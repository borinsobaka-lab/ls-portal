-- ============================================================================
-- Учётные записи сотрудников: вход только по коду из письма, без карточек
-- клиентов.
--
-- 1) handle_new_user не заводит карточку clients сотруднику, созданному в
--    «Доступах» (метка staff_account в raw_user_meta_data ставит админка).
-- 2) У сотрудников нет пароля. Вход в админку — только кодом из письма;
--    пароль позволял получить токен напрямую у GoTrue в обход письма.
--    Триггер стирает пароль при выдаче роли сотрудника, разово — у текущих.
-- 3) Разово удаляет пустые карточки клиентов, которые триггер завёл
--    сотрудникам (без абонементов, продаж, записей, анкеты, заметок, CRM).
--
-- Идемпотентно. Выполняет мигратор при старте админки (scripts/migrate.ts).
-- Форма входа без пароля (код из письма) уже в проде — стирать пароли
-- безопасно.
-- ============================================================================

-- 1) Регистрация пользователя ------------------------------------------------
-- Та же функция, что в db/client_app_fixes.sql (изменение staff_account внесено
-- и туда — ручной перезапуск старого файла его не теряет).
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
  -- клиенты не записываем: раньше каждый новый сотрудник появлялся в списке
  -- клиентов. Существующую карточку с той же почтой выше всё равно привязали —
  -- если сотрудник и правда клиент, связь не теряется.
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

-- 2) Сотрудники без пароля ------------------------------------------------------
-- Пустой encrypted_password — как у пользователей, созданных без пароля: GoTrue
-- отвечает на вход по паролю «Invalid login credentials». Восстановление пароля
-- требует доступа к той же почте, так что второй фактор это не обходит.
create or replace function public.clear_staff_password()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.role::text in ('owner', 'admin', 'trainer') then
    update auth.users
       set encrypted_password = ''
     where id = new.user_id
       and coalesce(encrypted_password, '') <> '';
  end if;
  return new;
end;
$$;

drop trigger if exists user_roles_staff_passwordless on public.user_roles;
create trigger user_roles_staff_passwordless
  after insert or update of role on public.user_roles
  for each row execute function public.clear_staff_password();

do $$
declare
  n int;
begin
  update auth.users u
     set encrypted_password = ''
   where coalesce(u.encrypted_password, '') <> ''
     and exists (
       select 1 from public.user_roles r
        where r.user_id = u.id and r.role::text in ('owner', 'admin', 'trainer')
     );
  get diagnostics n = row_count;
  raise notice 'Пароль стёрт у сотрудников: %', n;
end;
$$;

-- 3) Пустые карточки клиентов у сотрудников -----------------------------------
-- Удаляем только карточки без следов клиента: ни абонементов, ни продаж, ни
-- прочих продаж, ни записей на занятия, ни анкеты приложения, ни заметок и
-- ссылки CRM. Чтобы сначала посмотреть, что уйдёт, выполните отдельно:
--   select c.id, c.full_name, c.email from public.clients c where <условие ниже>;
do $$
declare
  n int;
  -- other_sales может ещё не быть (other_sales.sql — AGENT_TASKS, Задача 6).
  other_sales_check text := case
    when to_regclass('public.other_sales') is not null
    then ' and not exists (select 1 from public.other_sales os where os.client_id = c.id)'
    else ''
  end;
begin
  execute
    'delete from public.clients c
      where c.user_id is not null
        and exists (
          select 1 from public.user_roles r
           where r.user_id = c.user_id and r.role::text in (''owner'', ''admin'', ''trainer'')
        )
        and c.notes is null
        and c.crm_link is null
        and not exists (select 1 from public.client_memberships cm where cm.client_id = c.id)
        and not exists (select 1 from public.sales s where s.client_id = c.id)
        and not exists (select 1 from public.schedule_bookings b where b.user_id = c.user_id)
        and not exists (select 1 from public.member_profiles mp where mp.user_id = c.user_id)'
    || other_sales_check;
  get diagnostics n = row_count;
  raise notice 'Удалено пустых карточек клиентов у сотрудников: %', n;
end;
$$;

notify pgrst, 'reload schema';
