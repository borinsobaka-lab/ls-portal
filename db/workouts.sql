-- Workouts section — run on Supabase after db/schema.sql and db/trainers.sql.

create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  description text,
  photo_url text,
  type text check (type in ('strength','cardio','hybrid','recovery') or type is null),
  created_at timestamptz not null default now()
);
create index if not exists workouts_studio_idx on public.workouts(studio_id);

grant select, insert, update, delete on public.workouts to authenticated;
grant all on public.workouts to service_role;

alter table public.workouts enable row level security;

drop policy if exists "workouts studio select" on public.workouts;
create policy "workouts studio select" on public.workouts
  for select to authenticated
  using (studio_id = public.current_studio_id(auth.uid()));

drop policy if exists "workouts trainer write" on public.workouts;
create policy "workouts trainer write" on public.workouts
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- Storage bucket for workout photos
insert into storage.buckets (id, name, public)
values ('workout-photos', 'workout-photos', true)
on conflict (id) do nothing;

drop policy if exists "workout-photos public read" on storage.objects;
create policy "workout-photos public read" on storage.objects
  for select using (bucket_id = 'workout-photos');

-- ВНИМАНИЕ: запись в бакет разрешена только сотрудникам —
-- политики заданы в db/storage_hardening.sql. Здесь их не
-- создаём, иначе перезапуск файла снова открыл бы бакет всем.
