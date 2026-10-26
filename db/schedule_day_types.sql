-- Move workout "type" from workouts to schedule days.
-- Run on Supabase after db/schedule.sql.

-- 1. Remove type from workouts
alter table public.workouts drop column if exists type;

-- 2. Per-day type table
create table if not exists public.schedule_days (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  day date not null,
  type text not null check (type in ('strength','cardio','hybrid','recovery')),
  created_at timestamptz not null default now(),
  unique (studio_id, day)
);
create index if not exists schedule_days_studio_idx on public.schedule_days(studio_id);
create index if not exists schedule_days_day_idx on public.schedule_days(day);

grant select, insert, update, delete on public.schedule_days to authenticated;
grant all on public.schedule_days to service_role;

alter table public.schedule_days enable row level security;

drop policy if exists "schedule_days studio select" on public.schedule_days;
create policy "schedule_days studio select" on public.schedule_days
  for select to authenticated
  using (studio_id = public.current_studio_id(auth.uid()));

drop policy if exists "schedule_days trainer write" on public.schedule_days;
create policy "schedule_days trainer write" on public.schedule_days
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
