-- ============================================================================
-- Мультиязычный контент клиентского приложения (решение владельца 2026-10-12):
-- приложение — на английском (по умолчанию), грузинском и русском; контент,
-- который заносят в админке, ведётся на трёх языках.
--
-- Русский текст остаётся в прежних колонках (title, description, name, …) —
-- это основной язык админки, его читают старые версии кода. Переводы — в
-- новой колонке translations:
--
--   {"en": {"title": "…", "description": "…"}, "ka": {"title": "…"}}
--
-- ключ верхнего уровня — язык (en / ka), внутри — те же имена полей, что у
-- русских колонок; список (memberships.benefits) — массив строк. Пустого
-- перевода нет: админка не пишет пустые строки, приложение берёт язык
-- клиента → английский → русский.
--
-- Одна jsonb-колонка, а не title_en/title_ka: строка приходит в приложение
-- целиком со всеми языками, и смена языка не делает новых запросов (кэш
-- React Query тот же). Объём — несколько килобайт текста на раздел.
--
-- studios читается по колонкам (grant select (…) to anon, authenticated —
-- 2026-10-09_studio_formats.sql) — добавляем translations в оба гранта,
-- правка — у владельца студии, как name/address.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.news add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.services add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.push_notifications add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.memberships add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.workouts add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.trainers add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.studio_app_settings add column if not exists translations jsonb not null default '{}'::jsonb;
alter table public.studios add column if not exists translations jsonb not null default '{}'::jsonb;

-- Только объект (не массив, не строка): приложение читает translations.en.title.
do $$
declare
  t text;
begin
  foreach t in array array[
    'news', 'services', 'push_notifications', 'memberships', 'workouts',
    'trainers', 'studio_app_settings', 'studios'
  ] loop
    if not exists (
      select 1 from pg_constraint
      where conname = t || '_translations_object'
        and conrelid = ('public.' || t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (jsonb_typeof(translations) = ''object'')',
        t, t || '_translations_object'
      );
    end if;
  end loop;
end $$;

comment on column public.news.translations is
  'Переводы для клиентского приложения: {"en": {поле: текст}, "ka": {…}}; русский — в своих колонках.';
comment on column public.services.translations is
  'Переводы для клиентского приложения: {"en": {поле: текст}, "ka": {…}}; русский — в своих колонках.';
comment on column public.push_notifications.translations is
  'Переводы пуша: {"en": {"title", "message"}, "ka": {…}}; русский — в своих колонках.';
comment on column public.memberships.translations is
  'Переводы для клиентского приложения: {"en": {name, description, tag_text, gift_text, benefits[]}, "ka": {…}}.';
comment on column public.workouts.translations is
  'Переводы для клиентского приложения: {"en": {name, description}, "ka": {…}}.';
comment on column public.trainers.translations is
  'Переводы для клиентского приложения: {"en": {full_name, bio}, "ka": {…}}.';
comment on column public.studio_app_settings.translations is
  'Переводы для клиентского приложения: {"en": {about}, "ka": {…}}.';
comment on column public.studios.translations is
  'Переводы для клиентского приложения: {"en": {name, address}, "ka": {…}}.';

grant select (translations) on public.studios to anon, authenticated;
grant update (translations) on public.studios to authenticated;

notify pgrst, 'reload schema';
