-- ============================================================================
-- Убрать данные нагрузочного прогона (deploy/load/seed.sql): сотрудников
-- @loadtest.invalid (с их чтением, поиском, попытками), роль, базу знаний и
-- курс «Нагрузочный тест». Supabase Studio → SQL Editor.
-- ============================================================================
do $$
declare
  v_base uuid := (select id from public.kb_bases where title = 'Нагрузочный тест');
begin
  delete from public.acad_courses where title = 'Нагрузочный тест';
  delete from public.access_roles where name = 'Нагрузочный тест';
  if v_base is not null then
    delete from public.kb_node_tags where base_id = v_base;
    delete from public.kb_tags where base_id = v_base;
    delete from public.kb_bases where id = v_base;
  end if;
  delete from public.profiles
   where id in (select id from auth.users where email like '%@loadtest.invalid');
  delete from auth.users where email like '%@loadtest.invalid';
  perform public.access_flush();
end;
$$;

select count(*) as loadtest_users_left from auth.users where email like '%@loadtest.invalid';
