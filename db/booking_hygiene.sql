-- ============================================================================
-- Гигиена данных по записям + причины отмен + автоистечение абонементов +
-- триггер last_visit_date. Идемпотентно. Поведение записи НЕ меняется
-- (параметр причины отмены — с дефолтом; вейт-лист — отдельным заходом).
-- Запускать после db/bookings.sql, db/bookings_log.sql, db/bookings_statuses_v2.sql,
-- db/client_memberships.sql, security_hardening.sql (нужен is_staff).
-- ============================================================================

-- 1) Причина и срок отмены на брони и в журнале ------------------------------
alter table public.schedule_bookings
  add column if not exists cancel_reason text,
  add column if not exists cancelled_lead_minutes int;  -- >0 = за сколько минут до начала

alter table public.bookings_log
  add column if not exists cancel_reason text,
  add column if not exists cancelled_lead_minutes int;

-- 2) Единый словарь статусов в bookings_log ----------------------------------
--    Канон: booked | waitlist | attended | no_show | cancelled.
--    Легаси 'completed' -> 'attended', 'rejected' -> 'cancelled'.
update public.bookings_log set status = 'attended'  where status = 'completed';
update public.bookings_log set status = 'cancelled' where status = 'rejected';

alter table public.bookings_log drop constraint if exists bookings_log_status_check;
alter table public.bookings_log
  add constraint bookings_log_status_check
  check (status in ('booked','waitlist','attended','no_show','cancelled'));

-- 3) Пересобрать sync журнала: нормализуем статус + копируем причину/срок -----
create or replace function public.bookings_log_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry   public.schedule_entries%rowtype;
  v_workout public.workouts%rowtype;
  v_client  public.clients%rowtype;
  v_email   text;
  v_first   text;
  v_last    text;
  v_full    text;
  v_phone   text;
  v_status  text;
begin
  select * into v_entry   from public.schedule_entries where id = new.entry_id;
  select * into v_workout from public.workouts          where id = v_entry.workout_id;
  select * into v_client
    from public.clients
   where user_id = new.user_id and studio_id = new.studio_id
   limit 1;

  select email into v_email from auth.users where id = new.user_id;

  v_first := coalesce(v_client.first_name, null);
  v_last  := coalesce(v_client.last_name,  null);
  v_full  := coalesce(v_client.full_name,  nullif(trim(coalesce(v_first,'') || ' ' || coalesce(v_last,'')), ''));
  v_phone := v_client.phone;

  v_status := case new.status::text
    when 'completed' then 'attended'
    when 'rejected'  then 'cancelled'
    else new.status::text
  end;

  insert into public.bookings_log (
    studio_id, booking_id, entry_id, user_id,
    client_first_name, client_last_name, client_full_name,
    client_phone, client_email,
    workout_id, workout_name, workout_type,
    starts_at, ends_at,
    status, booked_at, cancelled_at, cancel_reason, cancelled_lead_minutes, updated_at
  ) values (
    new.studio_id, new.id, new.entry_id, new.user_id,
    v_first, v_last, v_full,
    v_phone, coalesce(v_client.email, v_email),
    v_workout.id, v_workout.name, v_workout.type::text,
    v_entry.starts_at, v_entry.ends_at,
    v_status, coalesce(new.created_at, now()), new.cancelled_at,
    new.cancel_reason, new.cancelled_lead_minutes,
    now()
  )
  on conflict (booking_id) do update set
    status                 = excluded.status,
    cancelled_at           = excluded.cancelled_at,
    cancel_reason          = excluded.cancel_reason,
    cancelled_lead_minutes = excluded.cancelled_lead_minutes,
    updated_at             = now();

  return new;
end;
$$;

-- 4) Отмена записи клиентом — принимает причину, считает срок отмены ----------
create or replace function public.cancel_schedule_booking(
  p_entry_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.schedule_entries%rowtype;
  v_booking public.schedule_bookings%rowtype;
  v_lead int;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_booking
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  if not found or v_booking.status <> 'booked' then
    return jsonb_build_object('ok', false, 'reason', 'not_booked');
  end if;

  v_lead := round(extract(epoch from (v_entry.starts_at - now())) / 60)::int;

  update public.schedule_bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = p_reason,
         cancelled_lead_minutes = v_lead
   where id = v_booking.id;

  update public.schedule_entries
     set booked_count = greatest(0, booked_count - 1)
   where id = p_entry_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_schedule_booking(uuid, text) from public;
grant execute on function public.cancel_schedule_booking(uuid, text) to authenticated;

-- 5) Отмена записи сотрудником — тоже с причиной и сроком ---------------------
create or replace function public.cancel_schedule_booking_admin(
  p_booking_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.schedule_bookings%rowtype;
  v_entry public.schedule_entries%rowtype;
  v_lead int;
begin
  select * into v_booking from public.schedule_bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.is_trainer(auth.uid(), v_booking.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select * into v_entry from public.schedule_entries where id = v_booking.entry_id;
  v_lead := round(extract(epoch from (v_entry.starts_at - now())) / 60)::int;

  update public.schedule_bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = p_reason,
         cancelled_lead_minutes = v_lead
   where id = p_booking_id;

  if v_booking.status = 'booked' then
    update public.schedule_entries
       set booked_count = greatest(0, booked_count - 1)
     where id = v_booking.entry_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_schedule_booking_admin(uuid, text) from public;
grant execute on function public.cancel_schedule_booking_admin(uuid, text) to authenticated;

-- 6) Триггер: проставить clients.last_visit_date при отметке посещения --------
create or replace function public.update_last_visit_on_attended()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_date date;
begin
  if new.status = 'attended' and (old.status is distinct from 'attended') then
    select se.starts_at::date into v_date
      from public.schedule_entries se where se.id = new.entry_id;
    if v_date is not null then
      update public.clients
         set last_visit_date = greatest(coalesce(last_visit_date, v_date), v_date)
       where user_id = new.user_id and studio_id = new.studio_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_last_visit on public.schedule_bookings;
create trigger schedule_bookings_last_visit
  after update on public.schedule_bookings
  for each row execute function public.update_last_visit_on_attended();

-- Бэкфилл last_visit_date по уже посещённым занятиям
update public.clients c
   set last_visit_date = agg.max_date
  from (
    select bl.user_id, bl.studio_id, max(bl.starts_at::date) as max_date
      from public.bookings_log bl
     where bl.status = 'attended'
     group by bl.user_id, bl.studio_id
  ) agg
 where c.user_id = agg.user_id
   and c.studio_id = agg.studio_id
   and (c.last_visit_date is null or c.last_visit_date < agg.max_date);

-- 7) Автоистечение абонементов (по дате). Гонять по cron; клиента блокируем ---
create or replace function public.expire_memberships()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_staff(auth.uid()) then
    raise exception 'forbidden: staff only';
  end if;

  update public.client_memberships
     set status = 'expired'
   where status = 'active'
     and ends_at is not null
     and ends_at < current_date;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_memberships() from public;
grant execute on function public.expire_memberships() to authenticated, service_role;

notify pgrst, 'reload schema';
