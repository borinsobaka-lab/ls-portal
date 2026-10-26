-- ============================================================================
-- Добавляет причину и срок отмены в вью bookings_log_full (История записей).
-- Идемпотентно. Запускать после db/performance_indexes.sql и db/booking_hygiene.sql.
-- ============================================================================

drop view if exists public.bookings_log_full;
create view public.bookings_log_full
with (security_invoker = true) as
select
  bl.id::text as id,
  bl.studio_id,
  bl.booking_id,
  bl.entry_id,
  bl.user_id,
  bl.client_first_name,
  bl.client_last_name,
  bl.client_full_name,
  bl.client_phone,
  bl.client_email,
  bl.workout_name,
  bl.workout_type,
  bl.starts_at,
  bl.ends_at,
  bl.status::text as status,
  bl.booked_at,
  bl.cancelled_at,
  bl.completed_at,
  bl.cancel_reason,
  bl.cancelled_lead_minutes,
  bl.met_value,
  bl.weight_at_time,
  bl.duration_min,
  bl.calories,
  concat_ws(' ',
    bl.client_full_name, bl.client_first_name, bl.client_last_name,
    bl.client_phone, bl.client_email, bl.workout_name
  ) as search_text
from public.bookings_log bl

union all

select
  'schedule-booking-' || sb.id::text as id,
  sb.studio_id,
  sb.id as booking_id,
  sb.entry_id,
  sb.user_id,
  c.first_name as client_first_name,
  c.last_name as client_last_name,
  coalesce(
    c.full_name,
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')
  ) as client_full_name,
  c.phone as client_phone,
  c.email as client_email,
  w.name as workout_name,
  w.type as workout_type,
  se.starts_at,
  se.ends_at,
  sb.status::text as status,
  sb.created_at as booked_at,
  sb.cancelled_at,
  null::timestamptz as completed_at,
  sb.cancel_reason,
  sb.cancelled_lead_minutes,
  null::numeric(4, 2) as met_value,
  null::numeric(5, 1) as weight_at_time,
  null::int as duration_min,
  null::int as calories,
  concat_ws(' ',
    coalesce(c.full_name, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')),
    c.first_name, c.last_name, c.phone, c.email, w.name
  ) as search_text
from public.schedule_bookings sb
join public.schedule_entries se on se.id = sb.entry_id
left join public.workouts w on w.id = se.workout_id
left join public.clients c
  on c.user_id = sb.user_id
 and c.studio_id = sb.studio_id
where not exists (
  select 1 from public.bookings_log bl2 where bl2.booking_id = sb.id
);

grant select on public.bookings_log_full to authenticated;

notify pgrst, 'reload schema';
