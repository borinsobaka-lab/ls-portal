-- Schedule section — run on Supabase after db/workouts.sql.

create table if not exists public.schedule_entries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  workout_id uuid not null references public.workouts(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists schedule_entries_studio_idx on public.schedule_entries(studio_id);
create index if not exists schedule_entries_starts_idx on public.schedule_entries(starts_at);

grant select, insert, update, delete on public.schedule_entries to authenticated;
grant all on public.schedule_entries to service_role;

alter table public.schedule_entries enable row level security;

drop policy if exists "schedule studio select" on public.schedule_entries;
create policy "schedule studio select" on public.schedule_entries
  for select to authenticated
  using (studio_id = public.current_studio_id(auth.uid()));

drop policy if exists "schedule trainer write" on public.schedule_entries;
create policy "schedule trainer write" on public.schedule_entries
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
