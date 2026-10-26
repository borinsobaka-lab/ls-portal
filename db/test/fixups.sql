-- Поправки тестовой схемы там, где прогон старых db/*.sql по алфавиту
-- расходится с живой базой (вручную их выполняли в другом порядке).

-- schedule_day_types.sql удаляет workouts.type, а на живой базе колонка есть
-- (её читают админка и журнал записей bookings_log_sync).
alter table public.workouts add column if not exists type text;
