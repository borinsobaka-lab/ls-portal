-- ============================================================================
-- Лист ожидания: при заполнении занятия клиент встаёт в очередь (status='waitlist')
-- вместо отказа; ведём счётчик waitlist_count на занятии. Отмена уменьшает нужный
-- счётчик. Автопродвижение из очереди — НЕ делаем (v1): очередь = сигнал спроса,
-- сотрудник видит число ожидающих. Идемпотентно.
-- Запускать после db/bookings.sql и db/booking_hygiene.sql (переопределяет те же
-- функции, сохраняя причину/срок отмены).
-- ============================================================================

alter table public.schedule_entries
  add column if not exists waitlist_count int not null default 0
    check (waitlist_count >= 0);

-- 1) Запись: при заполнении — в лист ожидания -------------------------------
create or replace function public.book_schedule_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.schedule_entries%rowtype;
  v_capacity int;
  v_booking_id uuid;
  v_existing public.schedule_bookings%rowtype;
  v_has_membership boolean;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_entry.starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'past');
  end if;

  select coalesce(v_entry.capacity, w.capacity, 0)
    into v_capacity
  from public.workouts w
  where w.id = v_entry.workout_id;

  select exists (
    select 1
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
     where c.user_id = v_user
       and cm.studio_id = v_entry.studio_id
       and cm.status = 'active'
       and (cm.ends_at is null or cm.ends_at >= current_date)
       and (cm.visits_left is null or cm.visits_left > 0)
  ) into v_has_membership;

  if not v_has_membership then
    return jsonb_build_object('ok', false, 'reason', 'no_membership');
  end if;

  select * into v_existing
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  if found and v_existing.status = 'booked' then
    return jsonb_build_object('ok', false, 'reason', 'already_booked',
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;
  if found and v_existing.status = 'waitlist' then
    return jsonb_build_object('ok', false, 'reason', 'already_waitlisted', 'waitlisted', true,
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

  -- Занятие заполнено → лист ожидания
  if v_entry.booked_count >= v_capacity then
    if found then
      update public.schedule_bookings
         set status = 'waitlist', cancelled_at = null, created_at = now()
       where id = v_existing.id
       returning id into v_booking_id;
    else
      insert into public.schedule_bookings (studio_id, entry_id, user_id, status)
      values (v_entry.studio_id, p_entry_id, v_user, 'waitlist')
      returning id into v_booking_id;
    end if;
    update public.schedule_entries
       set waitlist_count = waitlist_count + 1
     where id = p_entry_id;
    return jsonb_build_object('ok', true, 'waitlisted', true,
      'booking_id', v_booking_id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

  -- Обычная запись
  if found then
    update public.schedule_bookings
       set status = 'booked', cancelled_at = null, created_at = now()
     where id = v_existing.id
     returning id into v_booking_id;
  else
    insert into public.schedule_bookings (studio_id, entry_id, user_id, status)
    values (v_entry.studio_id, p_entry_id, v_user, 'booked')
    returning id into v_booking_id;
  end if;
  update public.schedule_entries
     set booked_count = booked_count + 1
   where id = p_entry_id;
  return jsonb_build_object('ok', true, 'waitlisted', false,
    'booking_id', v_booking_id, 'booked_count', v_entry.booked_count + 1, 'capacity', v_capacity);
end;
$$;
revoke all on function public.book_schedule_entry(uuid) from public;
grant execute on function public.book_schedule_entry(uuid) to authenticated;

-- 2) Отмена клиентом: уменьшаем нужный счётчик, пишем причину/срок ------------
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

  if not found or v_booking.status not in ('booked', 'waitlist') then
    return jsonb_build_object('ok', false, 'reason', 'not_booked');
  end if;

  v_lead := round(extract(epoch from (v_entry.starts_at - now())) / 60)::int;

  update public.schedule_bookings
     set status = 'cancelled', cancelled_at = now(),
         cancel_reason = p_reason, cancelled_lead_minutes = v_lead
   where id = v_booking.id;

  if v_booking.status = 'booked' then
    update public.schedule_entries set booked_count = greatest(0, booked_count - 1) where id = p_entry_id;
  else
    update public.schedule_entries set waitlist_count = greatest(0, waitlist_count - 1) where id = p_entry_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.cancel_schedule_booking(uuid, text) from public;
grant execute on function public.cancel_schedule_booking(uuid, text) to authenticated;

-- 3) Отмена сотрудником: то же, с учётом waitlist ----------------------------
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
     set status = 'cancelled', cancelled_at = now(),
         cancel_reason = p_reason, cancelled_lead_minutes = v_lead
   where id = p_booking_id;

  if v_booking.status = 'booked' then
    update public.schedule_entries set booked_count = greatest(0, booked_count - 1) where id = v_booking.entry_id;
  elsif v_booking.status = 'waitlist' then
    update public.schedule_entries set waitlist_count = greatest(0, waitlist_count - 1) where id = v_booking.entry_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.cancel_schedule_booking_admin(uuid, text) from public;
grant execute on function public.cancel_schedule_booking_admin(uuid, text) to authenticated;

-- 4) Бэкфилл счётчика по существующим записям в очереди -----------------------
update public.schedule_entries se
   set waitlist_count = coalesce(cnt.c, 0)
  from (
    select entry_id, count(*)::int as c
      from public.schedule_bookings
     where status = 'waitlist'
     group by entry_id
  ) cnt
 where cnt.entry_id = se.id;

notify pgrst, 'reload schema';
