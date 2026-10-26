-- ============================================================================
-- Решения владельца 2026-10-14:
--
-- 1) «Вход закрыт» в клиентском приложении: доступ к приложению рассылают
--    заранее, до переноса базы клиентов — приложение ставят, но войти пока
--    нельзя. app_install_settings.sign_in_closed (строка на формат =
--    приложение): true — на экране входа вместо почты и согласия текст
--    «Вход откроем утром, 18 октября». Переключатель — админка, «Мобильное
--    приложение» → «Настройки». Граница — только экран входа: клиентов без
--    карточки и так не пускает база (handle_new_user, хук писем).
--
-- 2) Картинка клуба (studios.photo_url — путь в бакете studio-logos или
--    полный URL): маленькая квадратная картинка слева от названия в выборе
--    студии в приложении («Сменить студию»). Задаётся в «Клубах».
--    studios читается публично по колонкам — добавляем колонку в гранты,
--    как address (2026-10-11_zzzzzzzzzzzz_studio_address.sql).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.app_install_settings
  add column if not exists sign_in_closed boolean not null default false;

comment on column public.app_install_settings.sign_in_closed is
  'Вход в клиентское приложение закрыт: экран входа показывает текст вместо почты (до переноса базы).';

alter table public.studios add column if not exists photo_url text;

comment on column public.studios.photo_url is
  'Картинка клуба в клиентском приложении (выбор студии): путь в бакете studio-logos или полный URL.';

grant select (photo_url) on public.studios to anon, authenticated;
grant update (photo_url) on public.studios to authenticated;

notify pgrst, 'reload schema';
