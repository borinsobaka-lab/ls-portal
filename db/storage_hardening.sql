-- ============================================================================
-- Storage hardening (аудит 2026-08-07). Идемпотентно, безопасно перезапускать.
-- Требует хелпер public.is_staff (db/security_hardening.sql — прогнать раньше).
--
-- Проблема: маркетинговые бакеты (картинки новостей, абонементов, услуг, фото
-- тренеров и тренировок) имели политики записи «for insert/update/delete to
-- authenticated using (bucket_id = 'X')» — без проверки роли. Любой
-- зарегистрировавшийся клиент мог заливать произвольные файлы, ПЕРЕЗАПИСЫВАТЬ и
-- УДАЛЯТЬ любые чужие объекты в этих бакетах (снести/подменить всю витрину,
-- захостить произвольный контент на вашем хранилище).
--
-- Фикс: запись/правка/удаление в этих бакетах — только сотрудник (is_staff).
-- Публичное чтение сохраняем (витрина). Бакет avatars НЕ трогаем — там запись
-- уже ограничена своей папкой {auth.uid()}/ (db/storage_avatars.sql).
-- ============================================================================

do $$
declare
  b text;
  buckets text[] := array[
    'memberships-media', 'news-media', 'services-media',
    'trainer-photos', 'workout-photos'
  ];
begin
  foreach b in array buckets loop
    -- Снимаем старые широкие политики (исходные имена «<bucket> auth <cmd>»)
    -- и наши же (для идемпотентности).
    execute format('drop policy if exists %I on storage.objects', b || ' auth insert');
    execute format('drop policy if exists %I on storage.objects', b || ' auth update');
    execute format('drop policy if exists %I on storage.objects', b || ' auth delete');
    execute format('drop policy if exists %I on storage.objects', b || ' staff insert');
    execute format('drop policy if exists %I on storage.objects', b || ' staff update');
    execute format('drop policy if exists %I on storage.objects', b || ' staff delete');

    execute format(
      'create policy %I on storage.objects for insert to authenticated '
      || 'with check (bucket_id = %L and public.is_staff(auth.uid()))',
      b || ' staff insert', b);

    execute format(
      'create policy %I on storage.objects for update to authenticated '
      || 'using (bucket_id = %L and public.is_staff(auth.uid())) '
      || 'with check (bucket_id = %L and public.is_staff(auth.uid()))',
      b || ' staff update', b, b);

    execute format(
      'create policy %I on storage.objects for delete to authenticated '
      || 'using (bucket_id = %L and public.is_staff(auth.uid()))',
      b || ' staff delete', b);
  end loop;
end $$;
