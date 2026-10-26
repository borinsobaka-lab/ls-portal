-- ============================================================================
-- Настройки установки клиентского приложения (2026-10-11).
--
-- Раздел «Мобильное приложение» → «Настройки» в админке: иконка приложения
-- (фавикон и значок на рабочем столе, когда приложение сохраняют как PWA) и
-- подпись под значком. Хранится в общем синглтоне club_settings (id = true):
-- мобильное приложение общее для всех студий, одни настройки на обе сборки
-- клиента (app.base40.fit и pack.base40.fit).
--
--   app_name      — подпись под значком (name/short_name манифеста,
--                   apple-mobile-web-app-title); null — «Base40».
--   app_icon_path — папка в бакете app-icons с готовыми PNG: icon-512.png,
--                   icon-192.png, icon-maskable-512.png, apple-touch-icon.png,
--                   favicon-32.png (их нарезает админка при загрузке). Новая
--                   картинка — новая папка: адреса меняются, кэш браузеров и
--                   установленных приложений обновляется. null — иконка
--                   Base40 по умолчанию (apps/client/public).
--
-- Бакет app-icons — публичное чтение (иконки нужны браузеру до входа),
-- запись — раздел рейки «Мобильное приложение» (как news-media/services-media
-- в 2026-10-10_storage_media_write.sql). Правку самих колонок закрывает
-- прежняя политика "club_settings write" (has_admin_section 'app').
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

do $$
begin
  -- club_settings создан вне мигратора (db/club_settings.sql); на чистой базе
  -- без него пропускаем, как 2026-10-10_admin_permissions.sql.
  if to_regclass('public.club_settings') is not null then
    alter table public.club_settings add column if not exists app_name text;
    alter table public.club_settings add column if not exists app_icon_path text;

    alter table public.club_settings drop constraint if exists club_settings_app_name_len;
    alter table public.club_settings add constraint club_settings_app_name_len
      check (app_name is null or char_length(app_name) between 1 and 30);
  end if;
end;
$$;

insert into storage.buckets (id, name, public)
values ('app-icons', 'app-icons', true)
on conflict (id) do nothing;

drop policy if exists "app-icons public read" on storage.objects;
create policy "app-icons public read" on storage.objects
  for select using (bucket_id = 'app-icons');

drop policy if exists "app-icons staff insert" on storage.objects;
create policy "app-icons staff insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'app-icons' and public.has_admin_section(auth.uid(), 'app'));

drop policy if exists "app-icons staff update" on storage.objects;
create policy "app-icons staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'app-icons' and public.has_admin_section(auth.uid(), 'app'))
  with check (bucket_id = 'app-icons' and public.has_admin_section(auth.uid(), 'app'));

drop policy if exists "app-icons staff delete" on storage.objects;
create policy "app-icons staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'app-icons' and public.has_admin_section(auth.uid(), 'app'));

notify pgrst, 'reload schema';
