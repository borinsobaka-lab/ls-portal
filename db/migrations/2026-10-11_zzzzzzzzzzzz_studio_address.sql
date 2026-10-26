-- ============================================================================
-- Адрес студии (решение владельца 2026-10-11): виден в приложении пакетов —
-- плашка выбранной студии на главной и список «Сменить»; задаётся в админке
-- («Клубы» → редактирование клуба).
--
-- studios читается публично по колонкам (2026-10-09_studio_formats.sql:
-- grant select (…) to anon, authenticated) — добавляем address в оба гранта,
-- правка — у владельца студии, как остальные колонки.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.studios add column if not exists address text;

comment on column public.studios.address is
  'Адрес студии одной строкой — для клиентского приложения (плашка выбранной студии).';

grant select (address) on public.studios to anon, authenticated;
grant update (address) on public.studios to authenticated;

notify pgrst, 'reload schema';
