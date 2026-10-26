-- ============================================================================
-- Запись в бакеты картинок админки (2026-10-10).
--
-- Симптом: «Ошибка загрузки: new row violates row-level security policy» при
-- загрузке аватарки сотрудника. В self-hosted Supabase у бакетов картинок нет
-- политик записи: db/storage_hardening.sql (AGENT_TASKS, Задача 0b) вручную не
-- прогнан, а прежних широких политик в новом инстансе тоже нет. Здесь те же
-- политики — через мигратор, и сразу с разделами «Доступов»
-- (db/migrations/2026-10-10_admin_permissions.sql):
--   trainer-photos                     — раздел «Сотрудники»;
--   news-media, services-media         — раздел «Мобильное приложение»;
--   memberships-media, workout-photos  — любой сотрудник (разделы клуба RLS
--                                        не проверяет, граница — студия).
-- Чтение — публичное, как в исходных файлах (news.sql, trainers.sql, …):
-- нужно и витрине, и подписанным ссылкам админки. Бакет создаётся, если его
-- нет; флаг public у существующего не трогаем.
--
-- Заменяет db/storage_hardening.sql (Задачу 0b прогонять уже не нужно).
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

do $$
declare
  b record;
  cond text;
begin
  for b in
    select * from (values
      ('trainer-photos',    'public.has_admin_section(auth.uid(), ''staff'')'),
      ('news-media',        'public.has_admin_section(auth.uid(), ''app'')'),
      ('services-media',    'public.has_admin_section(auth.uid(), ''app'')'),
      ('memberships-media', 'public.is_staff(auth.uid())'),
      ('workout-photos',    'public.is_staff(auth.uid())')
    ) as t(bucket, check_expr)
  loop
    insert into storage.buckets (id, name, public)
    values (b.bucket, b.bucket, true)
    on conflict (id) do nothing;

    execute format('drop policy if exists %I on storage.objects', b.bucket || ' public read');
    execute format(
      'create policy %I on storage.objects for select using (bucket_id = %L)',
      b.bucket || ' public read', b.bucket);

    -- Прежние широкие политики (любой авторизованный) и наши — для идемпотентности.
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' auth insert');
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' auth update');
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' auth delete');
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' staff insert');
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' staff update');
    execute format('drop policy if exists %I on storage.objects', b.bucket || ' staff delete');

    cond := format('bucket_id = %L and %s', b.bucket, b.check_expr);
    execute format(
      'create policy %I on storage.objects for insert to authenticated with check (%s)',
      b.bucket || ' staff insert', cond);
    execute format(
      'create policy %I on storage.objects for update to authenticated using (%s) with check (%s)',
      b.bucket || ' staff update', cond, cond);
    execute format(
      'create policy %I on storage.objects for delete to authenticated using (%s)',
      b.bucket || ' staff delete', cond);
  end loop;
end;
$$;
