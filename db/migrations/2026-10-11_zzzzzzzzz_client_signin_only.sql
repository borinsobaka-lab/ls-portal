-- ============================================================================
-- Клиентское приложение без регистрации (решение владельца 2026-10-11).
--
-- Войти в приложение может только член клуба, которого завели на портале
-- (карточка clients с его почтой). Учётная запись GoTrue создаётся при первом
-- входе по коду (signInWithOtp, shouldCreateUser), а этот триггер:
--   * привязывает её к карточке клиента с той же почтой (любая студия;
--     если таких карточек несколько — сначала студия формата приложения
--     из метаданных app_format, затем самая новая);
--   * отказывает (исключение -> GoTrue «Database error saving new user»,
--     письмо не уходит), если непривязанной карточки с этой почтой нет.
-- Граница — в базе, а не в форме входа: /auth/v1/signup и /otp открыты
-- всем, у кого есть публичный ключ.
--
-- Сотрудников, созданных в «Доступах» (staff_account в метаданных), это не
-- касается — для них всё как в 2026-10-10_staff_accounts.sql.
--
-- ensure_client_profile (db/client_profile_backfill.sql) ищет карточку по
-- почте во всех студиях, а не только в студии из профиля: карточку могли
-- завести на портале уже после того, как у человека появилась учётная запись.
--
-- GOTRUE_DISABLE_SIGNUP должен оставаться false: при true GoTrue не создаёт
-- учётную запись даже члену клуба, и войти впервые нельзя.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _studio_id uuid;
  _client_id uuid;
  _client_name text;
  _first text := nullif(trim(coalesce(new.raw_user_meta_data->>'first_name', '')), '');
  _last  text := nullif(trim(coalesce(new.raw_user_meta_data->>'last_name', '')), '');
  _full  text;
  _phone text := nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '');
  _format text := nullif(new.raw_user_meta_data->>'app_format', '');
begin
  -- Сотрудник из «Доступов»: профиль и роль member в его студии, карточку
  -- клиента не заводим (существующую с той же почтой — привязываем).
  if coalesce(new.raw_user_meta_data->>'staff_account', '') = 'true' then
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

    update public.clients
       set user_id = new.id
     where user_id is null
       and email is not null
       and lower(trim(email)) = lower(trim(new.email))
       and studio_id = _studio_id;

    return new;
  end if;

  -- Клиент: только по карточке, заведённой на портале.
  select c.id, c.studio_id, c.full_name
    into _client_id, _studio_id, _client_name
    from public.clients c
    join public.studios s on s.id = c.studio_id
   where c.user_id is null
     and c.email is not null
     and new.email is not null
     and lower(trim(c.email)) = lower(trim(new.email))
   order by (s.format = _format) desc nulls last, c.created_at desc
   limit 1;

  if _client_id is null then
    raise exception 'Нет карточки клиента с почтой %: войти в приложение может только член клуба, добавленный на портале', new.email
      using errcode = 'P0001';
  end if;

  insert into public.profiles (id, studio_id, full_name, email)
  values (new.id, _studio_id, coalesce(nullif(trim(_client_name), ''), ''), new.email)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, studio_id, role)
  values (new.id, _studio_id, 'member')
  on conflict (user_id, studio_id, role) do nothing;

  update public.clients
     set user_id = new.id,
         phone = coalesce(phone, _phone),
         first_name = coalesce(first_name, _first),
         last_name = coalesce(last_name, _last)
   where id = _client_id;

  return new;
end;
$$;

-- Карточка клиента для уже существующей учётной записи (вызывает приложение,
-- если по user_id карточки нет). Отличие от db/client_profile_backfill.sql:
-- непривязанная карточка с той же почтой ищется во всех студиях.
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
  _full text;
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
  _full  := nullif(trim(coalesce(v_meta->>'full_name', concat_ws(' ', _last, _first))), '');

  select p.studio_id into v_studio from public.profiles p where p.id = v_user;

  -- Карточка, заведённая на портале на ту же почту, но ещё не привязанная:
  -- сначала в студии профиля, затем самая новая.
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

  if not found then
    -- Прежнее поведение для учётных записей без карточки (сотрудник открыл
    -- клиентское приложение, давние пользователи): карточка в студии профиля.
    v_studio := coalesce(v_studio, nullif(v_meta->>'studio_id', '')::uuid);
    if v_studio is null then
      select s.id into v_studio from public.studios s order by s.created_at asc limit 1;
    end if;
    if v_studio is null then
      raise exception 'no studio configured';
    end if;
    insert into public.clients (
      studio_id, user_id, full_name, first_name, last_name, phone, email, registration_date
    ) values (
      v_studio, v_user, coalesce(_full, v_email, ''), _first, _last, _phone, v_email, current_date
    )
    returning * into v_client;
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

notify pgrst, 'reload schema';
