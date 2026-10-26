-- News for the mobile app — run on Supabase after db/schema.sql.

create table if not exists public.news (
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

alter table public.news add column if not exists button_text text;
alter table public.news add column if not exists button_url text;

create index if not exists news_studio_position_idx
  on public.news(studio_id, position asc);

notify pgrst, 'reload schema';

grant select on public.news to anon;
grant select, insert, update, delete on public.news to authenticated;
grant all on public.news to service_role;

alter table public.news enable row level security;

-- Public read for the mobile app
drop policy if exists "news public read" on public.news;
create policy "news public read" on public.news
  for select to anon, authenticated using (true);

-- Studio staff manage their studio's news
drop policy if exists "news studio write" on public.news;
create policy "news studio write" on public.news
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- Storage bucket for news images
insert into storage.buckets (id, name, public)
values ('news-media', 'news-media', true)
on conflict (id) do nothing;

drop policy if exists "news-media public read" on storage.objects;
create policy "news-media public read" on storage.objects
  for select using (bucket_id = 'news-media');

-- ВНИМАНИЕ: запись в бакет разрешена только сотрудникам —
-- политики заданы в db/storage_hardening.sql. Здесь их не
-- создаём, иначе перезапуск файла снова открыл бы бакет всем.
