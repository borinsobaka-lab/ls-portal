-- ============================================================================
-- «Контакты и правила» (админка, раздел «Мобильное приложение»): ссылки на
-- WhatsApp и Facebook Messenger клуба — у каждой студии свои, рядом с
-- Instagram (2026-10-11_zzzzzzzzzzz_packages_app_studio.sql). Показываются
-- в приложении пакетных студий: «Студия» → «Информация». Чтение и запись —
-- прежние политики studio_app_settings (читается публично, правит раздел
-- рейки «Мобильное приложение»).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.studio_app_settings add column if not exists whatsapp_url text;
alter table public.studio_app_settings add column if not exists messenger_url text;

comment on column public.studio_app_settings.whatsapp_url is
  'Ссылка на WhatsApp студии (https://wa.me/…) — раздел «Студия» в приложении.';
comment on column public.studio_app_settings.messenger_url is
  'Ссылка на Facebook Messenger студии (https://m.me/…) — раздел «Студия» в приложении.';
