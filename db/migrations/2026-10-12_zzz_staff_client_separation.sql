-- ============================================================================
-- Сотрудник и клиент на одной почте — независимо (решение владельца
-- 2026-10-12: «по одной почте можно входить и туда, и туда, и ничего не
-- бояться»).
--
-- Учётная запись GoTrue на почту одна (Supabase один на оба приложения), но
-- у неё две независимые части:
--   * служебная — роли owner/admin/trainer (user_roles), права «Доступов»
--     (admin_permissions, admin_studio_permissions), профиль profiles (имя,
--     аватарка, «домашняя» студия админки);
--   * клиентская — карточка clients (user_id), анкета member_profiles,
--     записи, оценки тренеров. Студия клиента — студия карточки.
--
-- Раньше клиентская часть переписывала служебную: студию клиента RLS брал из
-- profiles.studio_id (current_studio_id), поэтому ensure_client_profile и
-- триггер clients_sync_profile_studio переносили profiles.studio_id в студию
-- карточки клиента — у сотрудника-клиента это меняло «домашнюю» студию
-- админки. (У обычного клиента profiles_guard_self_update это и так гасил.)
--
-- 1) current_studio_id: студия карточки клиента, без карточки — профиля.
--    Политики клиента (расписание, тренировки, абонементы, тренеры) смотрят
--    на карточку; у сотрудников свои политики (is_trainer/is_staff), их это
--    не касается.
-- 2) Клиентская сторона больше не трогает профиль сотрудника:
--    sync_profile_studio и ensure_client_profile пропускают сотрудников
--    (client_account_is_staff из 2026-10-12_client_account_wipe.sql).
-- 3) Профиль сотрудника смотрит на студию, где он сотрудник: при выдаче роли
--    (триггер на user_roles) и разово — у текущих.
--
-- Удаление карточки клиента у сотрудника стирает только клиентскую часть
-- (wipe_client_app_account, 2026-10-12_client_account_wipe.sql); снятие
-- доступа в «Доступах» не удаляет учётную запись клиента (deleteEmployee в
-- apps/admin/src/lib/employees.functions.ts); выход в одном приложении не
-- завершает сессию в другом (signOut scope local в обоих приложениях).
--
-- Порядок: после 2026-10-12_client_account_wipe.sql (client_account_is_staff,
-- актуальный ensure_client_profile). Идемпотентно. Выполняет мигратор при
-- старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Студия клиента — по карточке ---------------------------------------------

create or replace function public.current_studio_id(_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select c.studio_id from public.clients c
      where c.user_id = _user_id
      order by c.created_at desc, c.id
      limit 1),
    (select p.studio_id from public.profiles p where p.id = _user_id)
  )
$$;

-- 2. Клиентская сторона не трогает профиль сотрудника -------------------------

create or replace function public.sync_profile_studio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null and new.studio_id is not null
     and not public.client_account_is_staff(new.user_id) then
    update public.profiles
       set studio_id = new.studio_id
     where id = new.user_id
       and studio_id is distinct from new.studio_id;
  end if;
  return new;
end;
$$;

-- Как в 2026-10-12_client_account_wipe.sql, кроме обновления profiles.
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
  select * into v_client from public.clients c
   where c.user_id = v_user
   order by c.created_at desc, c.id
   limit 1;
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

  -- Профиль клиента — в студию карточки (сотруднику не трогаем: это студия
  -- его админки; RLS клиента берёт студию из карточки, current_studio_id).
  if not public.client_account_is_staff(v_user) then
    update public.profiles p
       set studio_id = v_client.studio_id
     where p.id = v_user and p.studio_id is distinct from v_client.studio_id;
  end if;

  insert into public.user_roles (user_id, studio_id, role)
  values (v_user, v_client.studio_id, 'member')
  on conflict do nothing; -- без списка колонок: studio_id здесь ещё и OUT-параметр

  id := v_client.id; studio_id := v_client.studio_id; return next;
end;
$$;

revoke all on function public.ensure_client_profile() from public;
grant execute on function public.ensure_client_profile() to authenticated;

-- Привязка карточки из ensure_client_profile не работала ни у кого, кроме
-- сотрудников студии: функция обновляет clients от имени клиента
-- (auth.uid() — он), и clients_guard_self_update молча возвращал user_id
-- прежним (null) — функция отдавала карточку, но связи не было, и экраны,
-- ищущие карточку по user_id, видели «нет карточки». Теперь привязать
-- свободную карточку к себе можно, если её почта — почта учётной записи.
-- Напрямую через API клиент такую строку не изменит: политика
-- "clients self update" пускает только к строкам с user_id = auth.uid().
create or replace function public.clients_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _link boolean;
begin
  -- Сотруднику студии можно всё. auth.uid() пуст при работе сервис-ключом и
  -- внутри триггеров — там ограничивать тоже нечего.
  if auth.uid() is null or public.is_trainer(auth.uid(), old.studio_id) then
    return new;
  end if;
  _link := old.user_id is null
       and new.user_id = auth.uid()
       and old.email is not null
       and exists (
             select 1 from auth.users u
              where u.id = auth.uid()
                and lower(trim(u.email)) = lower(trim(old.email))
           );
  -- Клиенту — только свои личные поля.
  new.id                := old.id;
  new.studio_id         := old.studio_id;
  if not _link then
    new.user_id         := old.user_id;
  end if;
  new.notes             := old.notes;
  new.crm_link          := old.crm_link;
  new.registration_date := old.registration_date;
  new.last_visit_date   := old.last_visit_date;
  return new;
end;
$$;

-- 3. Профиль сотрудника — в студии, где он сотрудник ----------------------------

create or replace function public.staff_profile_home_studio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role::text in ('owner', 'admin', 'trainer') then
    update public.profiles p
       set studio_id = new.studio_id
     where p.id = new.user_id
       and p.studio_id is distinct from new.studio_id
       and not exists (
         select 1 from public.user_roles ur
          where ur.user_id = p.id
            and ur.studio_id = p.studio_id
            and ur.role::text in ('owner', 'admin', 'trainer')
       );
  end if;
  return new;
end;
$$;

revoke all on function public.staff_profile_home_studio() from public, anon, authenticated;

drop trigger if exists user_roles_staff_home_studio on public.user_roles;
create trigger user_roles_staff_home_studio
  after insert or update of role, studio_id on public.user_roles
  for each row execute function public.staff_profile_home_studio();

-- Разово: сотрудники, чей профиль увели в студию, где они только клиенты.
do $$
declare
  n int;
begin
  update public.profiles p
     set studio_id = (
       select ur.studio_id
         from public.user_roles ur
         join public.studios s on s.id = ur.studio_id
        where ur.user_id = p.id
          and ur.role::text in ('owner', 'admin', 'trainer')
        order by (ur.role::text = 'owner') desc, s.created_at, s.id
        limit 1
     )
   where exists (
           select 1 from public.user_roles ur
            where ur.user_id = p.id and ur.role::text in ('owner', 'admin', 'trainer')
         )
     and not exists (
           select 1 from public.user_roles ur
            where ur.user_id = p.id
              and ur.studio_id = p.studio_id
              and ur.role::text in ('owner', 'admin', 'trainer')
         );
  get diagnostics n = row_count;
  raise notice 'Профиль сотрудника возвращён в его студию: %', n;
end;
$$;

notify pgrst, 'reload schema';
