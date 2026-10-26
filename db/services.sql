-- Services for the mobile app — run on Supabase after db/schema.sql.

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  position integer not null default 0,
  image_url text,
  banner_url text,
  title text not null,
  description text,
  full_title text,
  full_text text,
  button_text text,
  button_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists services_studio_position_idx
  on public.services(studio_id, position asc);

notify pgrst, 'reload schema';

grant select on public.services to anon;
grant select, insert, update, delete on public.services to authenticated;
grant all on public.services to service_role;

alter table public.services enable row level security;

-- Public read for the mobile app
drop policy if exists "services public read" on public.services;
create policy "services public read" on public.services
  for select to anon, authenticated using (true);

-- Studio staff manage their studio's services
drop policy if exists "services studio write" on public.services;
create policy "services studio write" on public.services
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- Storage bucket for services images
insert into storage.buckets (id, name, public)
values ('services-media', 'services-media', true)
on conflict (id) do nothing;

drop policy if exists "services-media public read" on storage.objects;
create policy "services-media public read" on storage.objects
  for select using (bucket_id = 'services-media');

-- ВНИМАНИЕ: запись в бакет разрешена только сотрудникам —
-- политики заданы в db/storage_hardening.sql. Здесь их не
-- создаём, иначе перезапуск файла снова открыл бы бакет всем.
