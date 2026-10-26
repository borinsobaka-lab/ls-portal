-- Allow trainers/admins to cancel a booking on behalf of a user.
-- Run on Supabase after db/bookings.sql.

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
     set status = 'cancelled', cancelled_at = now()
   where id = p_booking_id;

  update public.schedule_entries
     set booked_count = greatest(0, booked_count - 1)
   where id = v_booking.entry_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_schedule_booking_admin(uuid) from public;
grant execute on function public.cancel_schedule_booking_admin(uuid) to authenticated;

notify pgrst, 'reload schema';
