-- Trainers section — run this on your Supabase project after db/schema.sql.

-- Add social columns if they don't exist (safe for existing tables)
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='telegram') then
    alter table public.trainers add column telegram text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='whatsapp') then
    alter table public.trainers add column whatsapp text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='instagram') then
    alter table public.trainers add column instagram text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='facebook') then
    alter table public.trainers add column facebook text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='tiktok') then
    alter table public.trainers add column tiktok text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='trainers' and column_name='role') then
    alter table public.trainers add column role text not null default 'trainer' check (role in ('trainer','admin'));
  end if;
end $$;

create table if not exists public.trainers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  full_name text not null,
  photo_url text,
  gender text check (gender in ('male','female') or gender is null),
  specialization text,
  bio text,
  telegram text,
  whatsapp text,
  instagram text,
  facebook text,
  tiktok text,
  role text not null default 'trainer' check (role in ('trainer','admin')),
  created_at timestamptz not null default now()
);
create index if not exists trainers_studio_idx on public.trainers(studio_id);

grant select, insert, update, delete on public.trainers to authenticated;
grant all on public.trainers to service_role;

alter table public.trainers enable row level security;

drop policy if exists "trainers studio select" on public.trainers;
create policy "trainers studio select" on public.trainers
  for select to authenticated
  using (studio_id = public.current_studio_id(auth.uid()));

drop policy if exists "trainers trainer write" on public.trainers;
create policy "trainers trainer write" on public.trainers
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- Storage bucket for trainer photos
insert into storage.buckets (id, name, public)
values ('trainer-photos', 'trainer-photos', true)
on conflict (id) do nothing;

drop policy if exists "trainer-photos public read" on storage.objects;
create policy "trainer-photos public read" on storage.objects
  for select using (bucket_id = 'trainer-photos');

-- ВНИМАНИЕ: запись в бакет разрешена только сотрудникам —
-- политики заданы в db/storage_hardening.sql. Здесь их не
-- создаём, иначе перезапуск файла снова открыл бы бакет всем.

