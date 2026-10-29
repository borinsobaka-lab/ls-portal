-- ============================================================================
-- «Аналитика сети» (2026-10-26 … 2026-10-27) удаляется целиком — решение
-- владельца 2026-10-29 (ANALYTICS_PLAN.md): вместо неё раздел «Аналитика»
-- переносит портал аналитики Lady Stretch как есть
-- (2026-10-29_z_analytics_core.sql и следующие). Данных в боевой базе не было.
--
-- Удаляются только объекты прежней версии — по именам и сигнатурам (новые
-- объекты раздела называются иначе), поэтому файл безопасно выполнить
-- повторно. Назначения удаляемых ролей уходят каскадом; их триггеры помечают
-- людей, пересчёт прав — при фиксации.
-- ============================================================================

-- 1) Таблицы (с ними — их политики и триггеры).
drop table if exists public.an_visits;
drop table if exists public.an_sales;
drop table if exists public.an_classes;
drop table if exists public.an_revenue;
drop table if exists public.an_imports;
drop table if exists public.an_nomenclature;
drop table if exists public.an_city_targets;
drop table if exists public.an_user_cities;
drop table if exists public.an_studios;

-- 2) Функции.
drop function if exists public.an_access();
drop function if exists public.an_bucket(date, text);
drop function if exists public.an_can_manage();
drop function if exists public.an_city_target_save(text, numeric);
drop function if exists public.an_classes_report(uuid[], date, date, text);
drop function if exists public.an_club_ids(uuid);
drop function if exists public.an_has(uuid, text);
drop function if exists public.an_ids(uuid[]);
drop function if exists public.an_import_delete(uuid);
drop function if exists public.an_import_finish(uuid);
drop function if exists public.an_import_rows(uuid, jsonb);
drop function if exists public.an_import_start(text, text, text, date, date, text[], jsonb);
drop function if exists public.an_nomenclature_set(uuid[], text, text);
drop function if exists public.an_paid_subscriptions(text[], integer);
drop function if exists public.an_partner_cities_save(uuid, text[]);
drop function if exists public.an_partners_list();
drop function if exists public.an_revenue_report(uuid[], date, date, text);
drop function if exists public.an_sales_report(uuid[], date, date, text, integer);
drop function if exists public.an_scope();
drop function if exists public.an_studio_save(uuid, text, text, uuid, date, text, uuid);
drop function if exists public.an_studio_save(uuid, text, text, uuid, date, text);
drop function if exists public.an_studios_list();
drop function if exists public.an_trials_report(uuid[], date, date, text);
drop function if exists public.an_zero_report(uuid[], date, date);
drop function if exists public.auth_an_studio_ids();

-- 3) Стартовые роли и права прежней версии.
delete from public.access_roles
 where system_key in ('network_analyst', 'analytics_partner', 'club_owner_analytics');
delete from public.access_permissions
 where key in ('analytics.view', 'analytics.cities', 'analytics.manage', 'analytics.clubs');

notify pgrst, 'reload schema';
