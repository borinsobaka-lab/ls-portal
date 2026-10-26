-- ============================================================================
-- Первый суперадминистратор портала (копия Lady Stretch, 2026-10-26).
--
-- Выполнить ОДИН раз в Supabase Studio → SQL Editor, после первого старта
-- портала (мигратор уже собрал схему). Перед запуском поменять три значения
-- в блоке «Поменять» ниже. Скрипт:
--   1) заводит первый клуб, если клубов ещё нет (профилю сотрудника нужен
--      клуб; клубу — формат «пакеты», в разделах клубов его видит только
--      суперадминистратор);
--   2) заводит учётную запись входа (GoTrue) на почту владельца — без
--      пароля, вход по коду из письма; есть уже — берёт её;
--   3) делает её человеком портала с ролью «Суперадминистратор» во всех
--      клубах (право portal.admin) и сразу пересчитывает права.
-- Повторный запуск ничего не задваивает. Дальше людей заводят в портале:
-- «Пользователи и роли».
-- ============================================================================
do $$
declare
  -- ▼ Поменять ▼
  v_email      text := 'owner@example.com';
  v_first_name text := 'Имя';
  v_last_name  text := 'Фамилия';
  v_club_name  text := 'Lady Stretch';
  -- ▲ Поменять ▲
  v_email_norm text := lower(trim(v_email));
  v_full       text := trim(concat_ws(' ', v_last_name, v_first_name));
  v_studio uuid;
  v_user   uuid;
  v_role   uuid;
begin
  if v_email_norm = 'owner@example.com' or position('@' in v_email_norm) = 0 then
    raise exception 'Укажите почту владельца в v_email';
  end if;

  -- 1) Клуб
  select id into v_studio from public.studios order by created_at limit 1;
  if v_studio is null then
    insert into public.studios (name, slug, format)
    values (v_club_name, 'club-' || substr(md5(random()::text), 1, 8), 'packages')
    returning id into v_studio;
  end if;

  -- 2) Учётная запись входа
  select id into v_user from auth.users where lower(email) = v_email_norm;
  if v_user is null then
    v_user := gen_random_uuid();
    -- staff_account — профиль сотрудника без карточки клиента (handle_new_user).
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
      v_email_norm, '', now(),
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      jsonb_build_object('first_name', v_first_name, 'last_name', v_last_name,
                         'full_name', v_full, 'studio_id', v_studio, 'staff_account', true),
      now(), now(), '', '', '', '', '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_user, v_user::text, 'email',
            jsonb_build_object('sub', v_user::text, 'email', v_email_norm,
                               'email_verified', true, 'phone_verified', false),
            null, now(), now());
  end if;

  insert into public.profiles (id, studio_id, full_name, email)
  values (v_user, v_studio, v_full, v_email_norm)
  on conflict (id) do nothing;

  -- 3) Человек портала и роль «Суперадминистратор»
  insert into public.portal_users (user_id, user_type, note)
  values (v_user, 'hq', 'Первый суперадминистратор (deploy/first-superadmin.sql)')
  on conflict (user_id) do nothing;

  select id into v_role from public.access_roles where system_key = 'superadmin';
  if v_role is null then
    raise exception 'Нет роли «Суперадминистратор» — мигратор ещё не выполнил миграции';
  end if;
  if not exists (select 1 from public.access_assignments
                  where role_id = v_role and subject_type = 'user' and user_id = v_user) then
    insert into public.access_assignments (role_id, subject_type, user_id, scope_type, note)
    values (v_role, 'user', v_user, 'all', 'Первый суперадминистратор');
  end if;

  perform public.access_flush();
  raise notice 'Готово: % — суперадминистратор (клуб «%»)', v_email_norm,
    (select name from public.studios where id = v_studio);
end;
$$;

-- Проверка: должна вернуться одна строка с portal_admin = true.
select u.email, 'portal.admin' = any (r.rights) as portal_admin, r.manage_all
  from auth.users u
  join public.access_user_rights r on r.user_id = u.id
 where 'portal.admin' = any (r.rights);
