-- ============================================================================
-- Исправления по код-ревью клиентского приложения (2026-08-07). Идемпотентно.
-- Запускать после security_hardening.sql и review_fixes.sql.
--
-- 1. Регистрация в приложении создаёт (или привязывает) карточку клиента —
--    без неё новый пользователь не мог вообще ничего.
-- 2. Клиент может править свой профиль: раньше все записи в clients из
--    приложения молча затирались RLS (0 строк, без ошибки).
-- 3. Матвью статистики больше не читается всеми подряд.
-- 4. studio_id клиента и профиля синхронизируются, клиент не может подменить
--    себе студию.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Регистрация: карточка клиента
--    handle_new_user создавал только profiles и user_roles. В приложении есть
--    самостоятельная регистрация (форма собирает имя, фамилию и телефон), но
--    строки в clients не появлялось, а создать её клиент не мог — из-за чего
--    «Абонементы» ругались на непривязанный профиль, а запись на занятие
--    возвращала no_membership. Если админ уже завёл клиента с такой почтой —
--    привязываем существующую карточку, а не плодим дубль.
--    УСТАРЕЛО: актуальное определение — в
--    db/migrations/2026-10-11_zzzzzzzzz_client_signin_only.sql (вход только
--    по карточке клиента с портала). Этот файл вручную не перезапускать.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _studio_id uuid;
  _first text := nullif(trim(coalesce(new.raw_user_meta_data->>'first_name', '')), '');
  _last  text := nullif(trim(coalesce(new.raw_user_meta_data->>'last_name', '')), '');
  _full  text;
  _phone text := nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '');
begin
  _studio_id := nullif(new.raw_user_meta_data->>'studio_id', '')::uuid;
  if _studio_id is null then
    select id into _studio_id from public.studios order by created_at asc limit 1;
  end if;

  if _studio_id is null then
    raise exception 'No studio available for new user %', new.id;
  end if;

  _full := nullif(
    trim(coalesce(new.raw_user_meta_data->>'full_name', concat_ws(' ', _last, _first))),
    ''
  );

  insert into public.profiles (id, studio_id, full_name, email)
  values (new.id, _studio_id, coalesce(_full, ''), new.email)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, studio_id, role)
  values (new.id, _studio_id, 'member')
  on conflict (user_id, studio_id, role) do nothing;

  -- Карточка клиента: сперва пытаемся привязать заведённую администратором.
  update public.clients
     set user_id = new.id,
         phone = coalesce(phone, _phone),
         first_name = coalesce(first_name, _first),
         last_name = coalesce(last_name, _last)
   where user_id is null
     and email is not null
     and lower(email) = lower(new.email)
     and studio_id = _studio_id;

  -- Сотрудника, созданного в «Доступах» (staff_account в метаданных), в
  -- клиенты не записываем (то же в db/migrations/2026-10-10_staff_accounts.sql — держать в синхроне).
  if not found and coalesce(new.raw_user_meta_data->>'staff_account', '') <> 'true' then
    insert into public.clients (
      studio_id, user_id, full_name, first_name, last_name, phone, email, registration_date
    ) values (
      _studio_id, new.id,
      coalesce(_full, new.email, ''),
      _first, _last, _phone, new.email, current_date
    );
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Клиент правит свой профиль.
--    Раньше на clients были только политики сотрудника, поэтому смена аватара,
--    имени или телефона из приложения меняла 0 строк — без ошибки, с бодрым
--    «Сохранено» в интерфейсе. Разрешаем править свою строку, но служебные
--    поля закрываем триггером: RLS умеет ограничивать строки, а не колонки.
-- ---------------------------------------------------------------------------
drop policy if exists "clients self update" on public.clients;
create policy "clients self update" on public.clients
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.clients_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Сотруднику студии можно всё. auth.uid() пуст при работе сервис-ключом и
  -- внутри триггеров — там ограничивать тоже нечего.
  if auth.uid() is null or public.is_trainer(auth.uid(), old.studio_id) then
    return new;
  end if;
  -- Клиенту — только свои личные поля. Остальное возвращаем как было:
  -- студия и привязка к пользователю определяют доступ, заметки и CRM-ссылка
  -- ведутся администратором, даты визитов считает система.
  new.id                := old.id;
  new.studio_id         := old.studio_id;
  new.user_id           := old.user_id;
  new.notes             := old.notes;
  new.crm_link          := old.crm_link;
  new.registration_date := old.registration_date;
  new.last_visit_date   := old.last_visit_date;
  return new;
end;
$$;

drop trigger if exists clients_guard_self_update on public.clients;
create trigger clients_guard_self_update
  before update on public.clients
  for each row execute function public.clients_guard_self_update();

-- ---------------------------------------------------------------------------
-- 3) Статистика: матвью нельзя закрыть через RLS (материализованные вью её не
--    поддерживают), а select был выдан роли authenticated — то есть любой
--    вошедший мог выгрузить посещаемость и калории всей клиентской базы
--    напрямую через PostgREST. Отзываем доступ и отдаём только свою строку.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.client_stats_30d_mv') is not null then
    execute 'revoke select on public.client_stats_30d_mv from authenticated, anon';
  end if;
end $$;

create or replace function public.my_stats_30d()
returns table (
  studio_id uuid,
  user_id uuid,
  visits_30d int,
  calories_30d int,
  visits_percentile double precision,
  calories_percentile double precision,
  cohort_size bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select m.studio_id, m.user_id, m.visits_30d, m.calories_30d,
         m.visits_percentile, m.calories_percentile, m.cohort_size
  from public.client_stats_30d_mv m
  where m.user_id = auth.uid()
$$;
revoke all on function public.my_stats_30d() from public;
grant execute on function public.my_stats_30d() to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Студия: приложение опирается на clients.studio_id, а RLS расписания,
--    тренировок и абонементов — на profiles.studio_id (current_studio_id).
--    Значения расходились: триггер регистрации ставил в profiles «самую старую
--    студию», а карточку клиента админ заводил в нужной — и клиент видел
--    пустое расписание без единой ошибки. Держим profiles в согласии с
--    карточкой клиента.
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_studio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null and new.studio_id is not null then
    update public.profiles
       set studio_id = new.studio_id
     where id = new.user_id
       and studio_id is distinct from new.studio_id;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_sync_profile_studio on public.clients;
create trigger clients_sync_profile_studio
  after insert or update of studio_id, user_id on public.clients
  for each row execute function public.sync_profile_studio();

-- Разовая синхронизация уже существующих расхождений.
update public.profiles p
   set studio_id = c.studio_id
  from public.clients c
 where c.user_id = p.id
   and c.studio_id is not null
   and p.studio_id is distinct from c.studio_id;

-- Клиент не должен переписывать себе студию: политика «profiles self or
-- trainer update» не имеет with check, поэтому член клуба мог поставить любой
-- studio_id и через current_studio_id() открыть себе чужое расписание,
-- тренировки и каталог абонементов.
create or replace function public.profiles_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Как и выше: пустой auth.uid() — это сервер/триггер, а не член клуба.
  if auth.uid() is null or public.is_staff(auth.uid()) then
    return new;
  end if;
  new.id        := old.id;
  new.studio_id := old.studio_id;
  return new;
end;
$$;

drop trigger if exists profiles_guard_self_update on public.profiles;
create trigger profiles_guard_self_update
  before update on public.profiles
  for each row execute function public.profiles_guard_self_update();

notify pgrst, 'reload schema';
