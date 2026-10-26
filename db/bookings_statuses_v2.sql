-- ============================================================
-- Расширение статусов записей: attended, no_show, rejected.
-- Запускать ПОСЛЕ db/bookings.sql и db/bookings_log.sql.
-- Идемпотентно.
-- ============================================================

-- 1. Добавляем 'rejected' в enum booking_status (attended/no_show уже есть).
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'booking_status' and e.enumlabel = 'rejected'
  ) then
    alter type public.booking_status add value 'rejected';
  end if;
end$$;

-- 2. Обновляем CHECK в bookings_log — допускаем все актуальные статусы.
alter table public.bookings_log
  drop constraint if exists bookings_log_status_check;
alter table public.bookings_log
  add constraint bookings_log_status_check
  check (status in ('booked','completed','cancelled','attended','no_show','rejected'));

-- 3. cancel_schedule_booking_admin → ставим статус 'rejected' (админ отклонил).
create or replace function public.cancel_schedule_booking_admin(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.schedule_bookings%rowtype;
begin
  select * into v_booking
  from public.schedule_bookings
  where id = p_booking_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.is_trainer(auth.uid(), v_booking.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if v_booking.status <> 'booked' then
    return jsonb_build_object('ok', true);
  end if;

  update public.schedule_bookings
     set status = 'rejected', cancelled_at = now()
   where id = p_booking_id;

  update public.schedule_entries
     set booked_count = greatest(0, booked_count - 1)
   where id = v_booking.entry_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_schedule_booking_admin(uuid) from public;
grant execute on function public.cancel_schedule_booking_admin(uuid) to authenticated;

-- 4. Зафиксировать посещение пользователя на тренировке.
create or replace function public.mark_booking_attended(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.schedule_bookings%rowtype;
begin
  select * into v_booking
  from public.schedule_bookings
  where id = p_booking_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.is_trainer(auth.uid(), v_booking.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if v_booking.status not in ('booked','no_show','attended') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_status');
  end if;

  update public.schedule_bookings
     set status = 'attended'
   where id = p_booking_id;

  update public.bookings_log
     set status = 'attended', completed_at = now(), updated_at = now()
   where booking_id = p_booking_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.mark_booking_attended(uuid) from public;
grant execute on function public.mark_booking_attended(uuid) to authenticated;

-- 5. Отметить как пропущенные тренировки, прошедшие без отметки посещения.
--    Заменяет mark_completed_bookings (оставляем для обратной совместимости).
create or replace function public.mark_no_show_bookings()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.schedule_bookings sb
     set status = 'no_show'
    from public.schedule_entries se
   where se.id = sb.entry_id
     and sb.status = 'booked'
     and se.ends_at < now();

  update public.bookings_log
     set status = 'no_show', completed_at = now(), updated_at = now()
   where status = 'booked' and ends_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_no_show_bookings() from public;
grant execute on function public.mark_no_show_bookings() to authenticated;

-- Старое имя — синоним для обратной совместимости.
create or replace function public.mark_completed_bookings()
returns int
language sql
security definer
set search_path = public
as $$
  select public.mark_no_show_bookings();
$$;

grant execute on function public.mark_completed_bookings() to authenticated;

notify pgrst, 'reload schema';
