-- ============================================================================
-- Учётные записи клиентского приложения: вход только по карточке, полное
-- удаление клиента, разовая очистка (решение владельца 2026-10-12).
--
-- Проблема: человек, которого нет в клиентах клуба, входил в приложение и
-- попадал в старый аккаунт с чужими/давними данными, без онбординга.
-- handle_new_user (2026-10-11_zzzzzzzzz_client_signin_only.sql) проверяет
-- карточку только при СОЗДАНИИ учётной записи; учётные записи, созданные
-- раньше, входили по коду как прежде, а ensure_client_profile молча заводил
-- им новую карточку. Удаление клиента на портале учётную запись, анкету
-- (member_profiles) и оценки тренеров не трогало — следующий вход снова
-- открывал «старый аккаунт».
--
-- 1) ensure_client_profile больше НЕ заводит карточку: нет карточки с этой
--    почтой (привязанной или свободной) — исключение not_a_club_member,
--    приложение выходит и показывает «почта не найдена среди членов клуба».
--    Хук писем (/api/auth-email) по client_app_sign_in_allowed не шлёт код
--    такой почте из клиентского приложения.
-- 2) wipe_client_app_account(user_id) — стирает всё, что человек оставил в
--    приложении: анкету, оценки тренеров, записи и строки журнала без
--    карточки, учётную запись GoTrue (каскадом — профиль, роли, сессии).
--    История клуба (карточки, продажи, абонементы, записи по карточке)
--    остаётся — только отвязывается от учётной записи. Сотрудникам (роль
--    owner/admin/trainer или staff_account из «Доступов») учётную запись не
--    удаляем — стираем только клиентскую часть. Права в «Доступах»
--    (admin_permissions) — тоже сотрудник: с учётной записью каскадом ушли
--    бы его скрипты LS.
-- 3) Удаление карточки клиента (раздел «Клиенты», удаление студии) —
--    триггер clients_wipe_account_ad: если других карточек у учётной записи
--    нет — wipe_client_app_account, и в любом случае журнал записей этой
--    карточки (bookings_log хранит имя, телефон, почту).
-- 4) Разово: wipe_client_app_account только для «фантомных» учётных
--    записей — входили в приложение, но карточки в «Клиентах» у них нет.
--    Клиентов с карточкой (и их продажи, абонементы, записи, анкету) это не
--    касается. Свободная карточка с той же почтой, если есть, привяжется к
--    новой учётной записи при следующем входе (handle_new_user).
--
-- Порядок: после 2026-10-11_zzzzzzzzz_client_signin_only.sql (переопределяет
-- ensure_client_profile) и trainer_ratings (trainer_reviews).
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Сотрудник ли учётная запись -----------------------------------------------

create or replace function public.client_account_is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.user_roles ur
            where ur.user_id = _user_id and ur.role in ('owner', 'admin', 'trainer')
         )
      or exists (select 1 from public.admin_permissions ap where ap.user_id = _user_id)
      or exists (select 1 from public.admin_studio_permissions asp where asp.user_id = _user_id)
      or exists (
           select 1 from auth.users u
            where u.id = _user_id
              and coalesce(u.raw_user_meta_data->>'staff_account', '') = 'true'
         )
$$;

revoke all on function public.client_account_is_staff(uuid) from public, anon, authenticated;

-- 2. Стереть учётную запись приложения ----------------------------------------
-- Возвращает 'deleted' (учётная запись удалена), 'staff' (сотрудник: стёрта
-- только клиентская часть) или 'kept' (удалить не удалось — см. warning;
-- клиентская часть стёрта, войти без карточки всё равно нельзя).

create or replace function public.wipe_client_app_account(_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if _user_id is null then
    return null;
  end if;

  -- Карточки — история клуба: остаются, но без учётной записи (при следующем
  -- входе по этой почте привяжутся заново). Сначала карточки, потом записи:
  -- триггер записей (schedule_bookings_link_person_biu) иначе вернул бы
  -- user_id из карточки.
  update public.clients set user_id = null where user_id = _user_id;

  update public.schedule_bookings set user_id = null
   where user_id = _user_id and client_id is not null;
  delete from public.schedule_bookings where user_id = _user_id;

  update public.bookings_log set user_id = null
   where user_id = _user_id and client_id is not null;
  delete from public.bookings_log where user_id = _user_id;

  delete from public.member_profiles where user_id = _user_id;
  delete from public.trainer_reviews where user_id = _user_id;

  if public.client_account_is_staff(_user_id) then
    return 'staff';
  end if;

  begin
    delete from auth.users where id = _user_id;
  exception when others then
    raise warning 'wipe_client_app_account: учётная запись % не удалена: %', _user_id, sqlerrm;
    return 'kept';
  end;
  return 'deleted';
end;
$$;

revoke all on function public.wipe_client_app_account(uuid) from public, anon, authenticated;

-- 3. Удаление карточки клиента ------------------------------------------------

create or replace function public.clients_wipe_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.bookings_log where client_id = old.id;
  if old.user_id is not null
     and not exists (select 1 from public.clients c where c.user_id = old.user_id) then
    perform public.wipe_client_app_account(old.user_id);
  end if;
  return old;
end;
$$;

drop trigger if exists clients_wipe_account_ad on public.clients;
create trigger clients_wipe_account_ad
  after delete on public.clients
  for each row execute function public.clients_wipe_account();

-- 4. ensure_client_profile — без автосоздания карточки --------------------------

create or replace function public.ensure_client_profile()
returns table (id uuid, studio_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_meta jsonb;
  v_studio uuid;
  v_client public.clients%rowtype;
  _first text;
  _last text;
  _phone text;
begin
  if v_user is null then
    raise exception 'unauthorized';
  end if;

  -- Уже есть карточка — просто возвращаем её.
  select * into v_client from public.clients c where c.user_id = v_user limit 1;
  if found then
    id := v_client.id; studio_id := v_client.studio_id; return next; return;
  end if;

  select u.email, u.raw_user_meta_data into v_email, v_meta
    from auth.users u where u.id = v_user;

  _first := nullif(trim(coalesce(v_meta->>'first_name', '')), '');
  _last  := nullif(trim(coalesce(v_meta->>'last_name', '')), '');
  _phone := nullif(trim(coalesce(v_meta->>'phone', '')), '');

  select p.studio_id into v_studio from public.profiles p where p.id = v_user;

  -- Карточка, заведённая на портале на ту же почту, но ещё не привязанная
  -- (любая студия; сначала студия профиля, затем самая новая).
  update public.clients c
     set user_id = v_user,
         phone = coalesce(c.phone, _phone),
         first_name = coalesce(c.first_name, _first),
         last_name = coalesce(c.last_name, _last)
   where c.id = (
     select c2.id from public.clients c2
      where c2.user_id is null
        and c2.email is not null
        and v_email is not null
        and lower(trim(c2.email)) = lower(trim(v_email))
      order by (c2.studio_id = v_studio) desc nulls last, c2.created_at desc
      limit 1
   )
  returning * into v_client;

  -- Карточки нет — в приложение не пускаем (регистрации нет, сотрудникам
  -- тоже нужна карточка). Приложение по этому сообщению выходит.
  if not found then
    raise exception 'not_a_club_member'
      using errcode = 'P0001',
            detail = 'Нет карточки клиента с этой почтой: войти в приложение может только член клуба, добавленный на портале';
  end if;

  -- profiles должен смотреть на ту же студию: от него зависит RLS расписания.
  update public.profiles p
     set studio_id = v_client.studio_id
   where p.id = v_user and p.studio_id is distinct from v_client.studio_id;

  insert into public.user_roles (user_id, studio_id, role)
  values (v_user, v_client.studio_id, 'member')
  on conflict do nothing; -- без списка колонок: studio_id здесь ещё и OUT-параметр

  id := v_client.id; studio_id := v_client.studio_id; return next;
end;
$$;

revoke all on function public.ensure_client_profile() from public;
grant execute on function public.ensure_client_profile() to authenticated;

-- 5. Можно ли слать код входа в клиентское приложение (хук писем) --------------
-- Есть привязанная карточка или свободная карточка с той же почтой.
-- Только service_role: иначе по почте можно было бы проверять, кто клиент.

create or replace function public.client_app_sign_in_allowed(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.clients c where c.user_id = _user_id)
      or exists (
           select 1
             from auth.users u
             join public.clients c
               on c.user_id is null
              and c.email is not null
              and lower(trim(c.email)) = lower(trim(u.email))
            where u.id = _user_id
         )
$$;

revoke all on function public.client_app_sign_in_allowed(uuid) from public, anon, authenticated;
grant execute on function public.client_app_sign_in_allowed(uuid) to service_role;

-- 6. Разово: фантомные учётные записи приложения ---------------------------------
-- Входил в приложение (роль member или анкета), но ни одна карточка клиента
-- на учётную запись не ссылается. Клиентов с карточкой не трогаем.
-- Сотрудники из «Доступов» тоже получают member — у них без карточки
-- стирается только клиентская часть (анкета, оценки, записи без карточки).

do $$
declare
  _uid uuid;
  _res text;
  _deleted int := 0;
  _staff int := 0;
  _kept int := 0;
begin
  for _uid in
    select u.id from auth.users u
     where not exists (select 1 from public.clients c where c.user_id = u.id)
       and (
         exists (select 1 from public.user_roles ur where ur.user_id = u.id and ur.role = 'member')
         or exists (select 1 from public.member_profiles mp where mp.user_id = u.id)
       )
  loop
    _res := public.wipe_client_app_account(_uid);
    if _res = 'deleted' then _deleted := _deleted + 1;
    elsif _res = 'staff' then _staff := _staff + 1;
    else _kept := _kept + 1;
    end if;
  end loop;
  raise notice 'Фантомные учётные записи: удалено %, сотрудников (стёрта клиентская часть) %, не удалось удалить %',
    _deleted, _staff, _kept;
end $$;

notify pgrst, 'reload schema';
