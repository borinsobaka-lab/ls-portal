-- Bookings / capacity — run on Supabase after db/workouts.sql and db/schedule.sql.
-- Idempotent: можно запускать повторно.

-- =========================================================================
-- 1. Capacity на тренировке (шаблон) и на конкретном занятии (override)
-- =========================================================================
alter table public.workouts
  add column if not exists capacity int;

alter table public.workouts
  drop constraint if exists workouts_capacity_positive;
alter table public.workouts
  add constraint workouts_capacity_positive
  check (capacity is null or capacity >= 0);

alter table public.schedule_entries
  add column if not exists capacity int,                     -- override; если null — берём из workouts.capacity
  add column if not exists booked_count int not null default 0;

-- booked_count никогда не должен превышать ёмкость занятия (учётом фоллбэка)
create or replace function public.schedule_entry_effective_capacity(_entry_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(se.capacity, w.capacity, 0)
  from public.schedule_entries se
  join public.workouts w on w.id = se.workout_id
  where se.id = _entry_id
$$;

-- =========================================================================
-- 2. Таблица записей пользователей на занятие
-- =========================================================================
create table if not exists public.schedule_bookings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  entry_id uuid not null references public.schedule_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status public.booking_status not null default 'booked',
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  unique (entry_id, user_id)
);
create index if not exists schedule_bookings_entry_idx on public.schedule_bookings(entry_id);
create index if not exists schedule_bookings_user_idx on public.schedule_bookings(user_id);
create index if not exists schedule_bookings_studio_idx on public.schedule_bookings(studio_id);

grant select, insert, update, delete on public.schedule_bookings to authenticated;
grant all on public.schedule_bookings to service_role;

alter table public.schedule_bookings enable row level security;

drop policy if exists "schedule_bookings self or trainer select" on public.schedule_bookings;
create policy "schedule_bookings self or trainer select" on public.schedule_bookings
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));

-- Запись и отмена идут ТОЛЬКО через RPC ниже (SECURITY DEFINER),
-- поэтому прямой insert/update/delete для обычных пользователей оставим тренерам.
drop policy if exists "schedule_bookings trainer write" on public.schedule_bookings;
create policy "schedule_bookings trainer write" on public.schedule_bookings
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- =========================================================================
-- 3. Атомарная запись на занятие — без овербукинга
-- =========================================================================
-- Возвращает json:
--   { ok: true,  booking_id, booked_count, capacity }
--   { ok: false, reason: 'full' | 'already_booked' | 'no_membership' | 'not_found' | 'past' }
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

  -- блокируем строку занятия до конца транзакции
  select * into v_entry
  from public.schedule_entries
  where id = p_entry_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_entry.starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'past');
  end if;

  -- эффективная вместимость: override на занятии либо capacity тренировки
  select coalesce(v_entry.capacity, w.capacity, 0)
    into v_capacity
  from public.workouts w
  where w.id = v_entry.workout_id;

  -- активный абонемент пользователя в этой студии
  -- memberships — это справочник тарифов; активные абонементы клиента
  -- хранятся в client_memberships, а пользователь привязан через clients.user_id.
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

  -- уже записан?
  select * into v_existing
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  if found and v_existing.status = 'booked' then
    return jsonb_build_object(
      'ok', false, 'reason', 'already_booked',
      'booking_id', v_existing.id,
      'booked_count', v_entry.booked_count,
      'capacity', v_capacity
    );
  end if;

  if v_entry.booked_count >= v_capacity then
    return jsonb_build_object('ok', false, 'reason', 'full',
      'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

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

  return jsonb_build_object(
    'ok', true,
    'booking_id', v_booking_id,
    'booked_count', v_entry.booked_count + 1,
    'capacity', v_capacity
  );
end;
$$;

revoke all on function public.book_schedule_entry(uuid) from public;
grant execute on function public.book_schedule_entry(uuid) to authenticated;

-- =========================================================================
-- 4. Отмена записи — тоже атомарно
-- =========================================================================
create or replace function public.cancel_schedule_booking(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.schedule_entries%rowtype;
  v_booking public.schedule_bookings%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select * into v_entry
  from public.schedule_entries
  where id = p_entry_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_booking
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  if not found or v_booking.status <> 'booked' then
    return jsonb_build_object('ok', false, 'reason', 'not_booked');
  end if;

  update public.schedule_bookings
     set status = 'cancelled', cancelled_at = now()
   where id = v_booking.id;

  update public.schedule_entries
     set booked_count = greatest(0, booked_count - 1)
   where id = p_entry_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_schedule_booking(uuid) from public;
grant execute on function public.cancel_schedule_booking(uuid) to authenticated;

-- =========================================================================
-- 5. Защита от рассинхрона booked_count <= capacity (если capacity на занятии задан)
-- =========================================================================
alter table public.schedule_entries
  drop constraint if exists schedule_entries_booked_le_capacity;
alter table public.schedule_entries
  add constraint schedule_entries_booked_le_capacity
  check (capacity is null or booked_count <= capacity);
