-- Clients section — run on Supabase after db/schema.sql.
-- If table already exists, add new columns via ALTER TABLE.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  first_name text,
  last_name text,
  phone text,
  email text,
  birthday date,
  gender text,
  notes text,
  registration_date date,
  last_visit_date date,
  crm_link text,
  photo_url text,
  -- avatar_url здесь раньше объявлялся, но в живой базе колонки нет: таблица
  -- была создана до этого файла, а create table if not exists колонок не
  -- добавляет. Код нигде её не пишет, поэтому колонка убрана и из кода.
  created_at timestamptz not null default now()
);
create index if not exists clients_studio_idx on public.clients(studio_id);
create index if not exists clients_user_idx on public.clients(user_id);

grant select, insert, update, delete on public.clients to authenticated;
grant all on public.clients to service_role;

alter table public.clients enable row level security;

-- ВНИМАНИЕ: политики доступа к этой таблице заданы в
-- db/security_hardening.sql (принцип «своя строка или сотрудник»).
-- Здесь их намеренно НЕ создаём: этот файл идемпотентный и его
-- перезапускают ради новых колонок — раньше он при этом молча
-- возвращал широкую политику и заново открывал доступ.

drop policy if exists "clients trainer write" on public.clients;
create policy "clients trainer write" on public.clients
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
