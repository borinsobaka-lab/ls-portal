-- ============================================================
-- Bookings log — отдельная "история записей" для админки.
-- Хранит денормализованные снимки: данные пользователя на момент
-- бронирования + данные тренировки + статус.
-- Запускать ПОСЛЕ db/bookings.sql. Идемпотентно.
-- ============================================================

create table if not exists public.bookings_log (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  booking_id uuid unique references public.schedule_bookings(id) on delete set null,
  entry_id uuid,
  user_id uuid,

  -- Снимок пользователя (минимально достаточный для поиска)
  client_first_name text,
  client_last_name  text,
  client_full_name  text,
  client_phone      text,
  client_email      text,

  -- Снимок тренировки
  workout_id   uuid,
  workout_name text,
  workout_type text,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,

  -- Статус и временные метки
  status        text not null check (status in ('booked','completed','cancelled')),
  booked_at     timestamptz not null default now(),
  cancelled_at  timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists bookings_log_studio_idx  on public.bookings_log(studio_id);
create index if not exists bookings_log_user_idx    on public.bookings_log(user_id);
create index if not exists bookings_log_status_idx  on public.bookings_log(status);
create index if not exists bookings_log_starts_idx  on public.bookings_log(starts_at);

grant select on public.bookings_log to authenticated;
grant all    on public.bookings_log to service_role;

alter table public.bookings_log enable row level security;

drop policy if exists "bookings_log trainer read" on public.bookings_log;
create policy "bookings_log trainer read" on public.bookings_log
  for select to authenticated
  using (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "bookings_log self read" on public.bookings_log;
create policy "bookings_log self read" on public.bookings_log
  for select to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- Триггер: при появлении/изменении записи — пишем снимок
-- ============================================================
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

  insert into public.bookings_log (
    studio_id, booking_id, entry_id, user_id,
    client_first_name, client_last_name, client_full_name,
    client_phone, client_email,
    workout_id, workout_name, workout_type,
    starts_at, ends_at,
    status, booked_at, cancelled_at, updated_at
  ) values (
    new.studio_id, new.id, new.entry_id, new.user_id,
    v_first, v_last, v_full,
    v_phone, coalesce(v_client.email, v_email),
    v_workout.id, v_workout.name, v_workout.type::text,
    v_entry.starts_at, v_entry.ends_at,
    new.status, coalesce(new.created_at, now()), new.cancelled_at,
    now()
  )
  on conflict (booking_id) do update set
    status       = excluded.status,
    cancelled_at = excluded.cancelled_at,
    updated_at   = now();

  return new;
end;
$$;

drop trigger if exists schedule_bookings_log_aiu on public.schedule_bookings;
create trigger schedule_bookings_log_aiu
  after insert or update on public.schedule_bookings
  for each row execute function public.bookings_log_sync();

-- Бэкап: подтянуть уже существующие записи (один раз — повторно не дублирует)
insert into public.bookings_log (
  studio_id, booking_id, entry_id, user_id,
  client_first_name, client_last_name, client_full_name,
  client_phone, client_email,
  workout_id, workout_name, workout_type,
  starts_at, ends_at,
  status, booked_at, cancelled_at, updated_at
)
select
  sb.studio_id, sb.id, sb.entry_id, sb.user_id,
  c.first_name, c.last_name,
  coalesce(c.full_name, nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')),
  c.phone, coalesce(c.email, u.email),
  w.id, w.name, w.type::text,
  se.starts_at, se.ends_at,
  sb.status, sb.created_at, sb.cancelled_at, now()
from public.schedule_bookings sb
join public.schedule_entries se on se.id = sb.entry_id
join public.workouts w on w.id = se.workout_id
left join public.clients c on c.user_id = sb.user_id and c.studio_id = sb.studio_id
left join auth.users u on u.id = sb.user_id
on conflict (booking_id) do nothing;

-- ============================================================
-- Перевод "booked" -> "completed" для прошедших занятий.
-- Можно вызвать из админки вручную; либо повесить pg_cron.
-- ============================================================
create or replace function public.mark_completed_bookings()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- В исходной таблице
  update public.schedule_bookings sb
     set status = 'completed'
    from public.schedule_entries se
   where se.id = sb.entry_id
     and sb.status = 'booked'
     and se.ends_at < now();

  -- В логе
  update public.bookings_log
     set status = 'completed', completed_at = now(), updated_at = now()
   where status = 'booked' and ends_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_completed_bookings() from public;
grant execute on function public.mark_completed_bookings() to authenticated;

notify pgrst, 'reload schema';
