-- ============================================================================
-- Данные для нагрузочного прогона (deploy/load/k6.js). Выполнить в Supabase
-- Studio → SQL Editor ДО прогона, после него — deploy/load/cleanup.sql.
--
-- Заводит (всё помечено «Нагрузочный тест» / @loadtest.invalid, настоящие
-- данные не трогает):
--   * 500 сотрудников loadtest-001…500@loadtest.invalid — id детерминированы
--     (md5('ls-loadtest-' || n)), k6 вычисляет их сам; войти по почте
--     нельзя (домен .invalid), k6 подписывает их токены секретом JWT;
--   * роль портала «Нагрузочный тест»: просмотр тестовой базы знаний;
--   * базу знаний «Нагрузочный тест»: 3 раздела × 20 опубликованных статей
--     (~3 КБ текста, теги);
--   * курс Академии «Нагрузочный тест» (урок + тест из 5 вопросов),
--     назначенный роли.
-- Повторный запуск ничего не задваивает.
-- ============================================================================
do $$
declare
  c_users constant integer := 500;
  v_studio uuid;
  v_base uuid;
  v_role uuid;
  v_course uuid;
  v_lesson uuid;
  v_quiz uuid;
  v_folder uuid;
  v_node uuid;
  v_tag uuid;
  v_uid uuid;
  v_words text[] := array[
    'клиент', 'абонемент', 'тренировка', 'растяжка', 'запись', 'администратор',
    'касса', 'оплата', 'расписание', 'тренер', 'зал', 'смена', 'отчёт', 'звонок',
    'пробное', 'занятие', 'продление', 'заморозка', 'скидка', 'сертификат',
    'группа', 'персональная', 'стандарт', 'правило', 'приветствие', 'уборка',
    'инвентарь', 'коврик', 'музыка', 'договор', 'возврат', 'жалоба', 'отзыв'];
  v_doc jsonb;
  v_para text;
  f integer;
  a integer;
  p integer;
  w integer;
begin
  select id into v_studio from public.studios order by created_at limit 1;
  if v_studio is null then
    raise exception 'Нет ни одного клуба — сначала deploy/first-superadmin.sql';
  end if;

  -- База знаний ---------------------------------------------------------------
  select id into v_base from public.kb_bases where title = 'Нагрузочный тест';
  if v_base is null then
    insert into public.kb_bases (title, rail_title, description, sort_order)
    values ('Нагрузочный тест', 'Нагр. тест', 'Тестовые статьи для замера нагрузки.', 999)
    returning id into v_base;

    for f in 1..3 loop
      insert into public.kb_nodes (base_id, parent_id, kind, title, status, sort_order)
      values (v_base, null, 'folder', format('Раздел %s', f), 'published', f)
      returning id into v_folder;
      for a in 1..20 loop
        v_doc := '[]'::jsonb;
        for p in 1..12 loop
          v_para := '';
          for w in 1..40 loop
            v_para := v_para || v_words[1 + floor(random() * array_length(v_words, 1))::int] || ' ';
          end loop;
          v_doc := v_doc || jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text, 'type', 'paragraph', 'props', '{}'::jsonb,
            'content', jsonb_build_array(jsonb_build_object(
              'type', 'text', 'text', initcap(trim(v_para)) || '.', 'styles', '{}'::jsonb)),
            'children', '[]'::jsonb));
        end loop;
        insert into public.kb_nodes (base_id, parent_id, kind, title, status, sort_order,
                                     content, published_at)
        values (v_base, v_folder, 'article', format('Статья %s.%s', f, a), 'published', a,
                v_doc, now())
        returning id into v_node;
      end loop;
    end loop;

    insert into public.kb_tags (base_id, name) values (v_base, 'касса') returning id into v_tag;
    insert into public.kb_node_tags (base_id, node_id, tag_id)
    select v_base, n.id, v_tag from public.kb_nodes n
     where n.base_id = v_base and n.kind = 'article' and n.sort_order <= 5;
  end if;

  -- Роль портала ----------------------------------------------------------------
  select id into v_role from public.access_roles where name = 'Нагрузочный тест';
  if v_role is null then
    insert into public.access_roles (name, description, sort_order)
    values ('Нагрузочный тест', 'Только для нагрузочного прогона — удалить cleanup.sql.', 999)
    returning id into v_role;
    insert into public.access_role_permissions (role_id, perm_key, target_id, level)
    values (v_role, 'kb.base', v_base, 'view');
  end if;

  -- Курс Академии ----------------------------------------------------------------
  select id into v_course from public.acad_courses where title = 'Нагрузочный тест';
  if v_course is null then
    insert into public.acad_courses (title, description, status, sequential, pass_percent, published_at)
    values ('Нагрузочный тест', 'Курс для замера нагрузки.', 'published', false, 60, now())
    returning id into v_course;
    insert into public.acad_steps (course_id, kind, title, content, sort_order)
    values (v_course, 'lesson', 'Урок', (select content from public.kb_nodes
                                         where base_id = v_base and kind = 'article' limit 1), 1)
    returning id into v_lesson;
    insert into public.acad_steps (course_id, kind, title, sort_order)
    values (v_course, 'quiz', 'Тест', 2)
    returning id into v_quiz;
    for p in 1..5 loop
      insert into public.acad_questions (step_id, course_id, sort_order, kind, text, options)
      values (v_quiz, v_course, p, 'single', format('Вопрос %s: какой ответ верный?', p),
              jsonb_build_array(
                jsonb_build_object('id', 'a', 'text', 'Первый', 'correct', true),
                jsonb_build_object('id', 'b', 'text', 'Второй', 'correct', false),
                jsonb_build_object('id', 'c', 'text', 'Третий', 'correct', false)));
    end loop;
    insert into public.acad_assignments (course_id, subject_type, access_role_id)
    values (v_course, 'access_role', v_role);
  end if;

  -- Сотрудники -----------------------------------------------------------------------
  for p in 1..c_users loop
    v_uid := md5('ls-loadtest-' || p)::uuid;
    if not exists (select 1 from auth.users where id = v_uid) then
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change,
        email_change_token_current, phone_change, phone_change_token, reauthentication_token
      ) values (
        '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
        format('loadtest-%s@loadtest.invalid', lpad(p::text, 3, '0')), '', now(),
        '{"provider": "email", "providers": ["email"]}'::jsonb,
        jsonb_build_object('full_name', format('Тест %s', p), 'studio_id', v_studio,
                           'staff_account', true),
        now(), now(), '', '', '', '', '', '', '', ''
      );
    end if;
    insert into public.portal_users (user_id, user_type, note)
    values (v_uid, 'service', 'Нагрузочный тест')
    on conflict (user_id) do nothing;
    if not exists (select 1 from public.access_assignments
                    where role_id = v_role and subject_type = 'user' and user_id = v_uid) then
      insert into public.access_assignments (role_id, subject_type, user_id, scope_type, note)
      values (v_role, 'user', v_uid, 'all', 'Нагрузочный тест');
    end if;
  end loop;

  perform public.access_flush();
  raise notice 'Готово: % сотрудников, база %, курс %', c_users, v_base, v_course;
end;
$$;

-- Проверка: 500 человек видят тестовую базу.
select count(*) as loadtest_users_with_base
  from public.kb_grants g
  join public.kb_bases b on b.id = g.base_id and b.title = 'Нагрузочный тест'
 where g.subject_type = 'user';
