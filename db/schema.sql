-- CLUB 40 initial schema
-- Run this on your external Supabase project (SQL Editor, or `supabase db push`
-- after copying into your own `supabase/migrations/` folder).

-- =========================================================================
-- Enums
-- =========================================================================
do $$ begin
  create type public.app_role as enum ('member', 'trainer', 'admin', 'owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum ('booked', 'waitlist', 'cancelled', 'attended', 'no_show');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.membership_status as enum ('active', 'paused', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;

-- =========================================================================
-- Studios (tenant root)
-- =========================================================================
create table public.studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now()
);
grant select on public.studios to anon, authenticated;
grant all on public.studios to service_role;
alter table public.studios enable row level security;

-- =========================================================================
-- Profiles
-- =========================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete restrict,
  full_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index on public.profiles(studio_id);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- =========================================================================
-- User roles (separate table — never store roles on profiles)
-- =========================================================================
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, studio_id, role)
);
create index on public.user_roles(studio_id);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

-- Security-definer helpers (avoid recursive RLS)
create or replace function public.has_role(_user_id uuid, _studio_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles
    where user_id = _user_id and studio_id = _studio_id and role = _role)
$$;

create or replace function public.is_trainer(_user_id uuid, _studio_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles
    where user_id = _user_id and studio_id = _studio_id
      and role in ('owner','admin','trainer'))
$$;

create or replace function public.current_studio_id(_user_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select studio_id from public.profiles where id = _user_id
$$;

-- =========================================================================
-- Class types
-- =========================================================================
create table public.class_types (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  description text,
  duration_minutes int not null default 60,
  created_at timestamptz not null default now()
);
create index on public.class_types(studio_id);
grant select, insert, update, delete on public.class_types to authenticated;
grant all on public.class_types to service_role;
alter table public.class_types enable row level security;

-- =========================================================================
-- Class sessions
-- =========================================================================
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  class_type_id uuid references public.class_types(id) on delete set null,
  instructor_id uuid references auth.users(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity int not null default 0,
  booked_count int not null default 0,
  created_at timestamptz not null default now(),
  check (booked_count <= capacity),
  check (ends_at > starts_at)
);
create index class_sessions_studio_starts_idx on public.class_sessions(studio_id, starts_at);
grant select, insert, update, delete on public.class_sessions to authenticated;
grant all on public.class_sessions to service_role;
alter table public.class_sessions enable row level security;

-- =========================================================================
-- Bookings
-- =========================================================================
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status public.booking_status not null default 'booked',
  created_at timestamptz not null default now(),
  unique (session_id, user_id)
);
create index bookings_session_idx on public.bookings(session_id);
create index bookings_user_idx on public.bookings(user_id);
create index bookings_studio_idx on public.bookings(studio_id);
grant select, insert, update, delete on public.bookings to authenticated;
grant all on public.bookings to service_role;
alter table public.bookings enable row level security;

-- =========================================================================
-- Memberships
-- =========================================================================
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_name text not null,
  status public.membership_status not null default 'active',
  started_at timestamptz not null default now(),
  ends_at timestamptz,
  price_cents int,
  created_at timestamptz not null default now()
);
create index on public.memberships(studio_id);
create index on public.memberships(user_id);
grant select, insert, update, delete on public.memberships to authenticated;
grant all on public.memberships to service_role;
alter table public.memberships enable row level security;

-- =========================================================================
-- Employees
-- =========================================================================
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text,
  role_title text,
  hourly_rate_cents int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.employees(studio_id);
grant select, insert, update, delete on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;

-- =========================================================================
-- Payroll
-- =========================================================================
create table public.payroll (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  gross_cents int not null default 0,
  net_cents int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index on public.payroll(studio_id);
create index on public.payroll(employee_id);
grant select, insert, update, delete on public.payroll to authenticated;
grant all on public.payroll to service_role;
alter table public.payroll enable row level security;

-- =========================================================================
-- Results
-- =========================================================================
create table public.results (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.class_sessions(id) on delete set null,
  metric text not null,
  value numeric not null,
  unit text,
  recorded_at timestamptz not null default now()
);
create index on public.results(studio_id);
create index on public.results(user_id);
grant select, insert, update, delete on public.results to authenticated;
grant all on public.results to service_role;
alter table public.results enable row level security;

-- =========================================================================
-- RLS policies
-- =========================================================================

-- studios
create policy "studios readable by members" on public.studios
  for select to authenticated using (id = public.current_studio_id(auth.uid()));
create policy "studios updatable by owners" on public.studios
  for update to authenticated using (public.has_role(auth.uid(), id, 'owner'));

-- profiles
create policy "profiles self or trainer select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "profiles self insert" on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy "profiles self or trainer update" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_trainer(auth.uid(), studio_id));

-- user_roles
create policy "user_roles self or trainer select" on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "user_roles owner manage" on public.user_roles
  for all to authenticated
  using (public.has_role(auth.uid(), studio_id, 'owner'))
  with check (public.has_role(auth.uid(), studio_id, 'owner'));

-- class_types
create policy "class_types studio select" on public.class_types
  for select to authenticated using (studio_id = public.current_studio_id(auth.uid()));
create policy "class_types trainer write" on public.class_types
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- class_sessions
create policy "class_sessions studio select" on public.class_sessions
  for select to authenticated using (studio_id = public.current_studio_id(auth.uid()));
create policy "class_sessions trainer write" on public.class_sessions
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- bookings
create policy "bookings self or trainer select" on public.bookings
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "bookings self insert" on public.bookings
  for insert to authenticated
  with check (user_id = auth.uid() and studio_id = public.current_studio_id(auth.uid()));
create policy "bookings self or trainer update" on public.bookings
  for update to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "bookings self or trainer delete" on public.bookings
  for delete to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));

-- memberships
create policy "memberships self or trainer select" on public.memberships
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "memberships trainer write" on public.memberships
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- employees
create policy "employees trainer select" on public.employees
  for select to authenticated using (public.is_trainer(auth.uid(), studio_id));
create policy "employees admin write" on public.employees
  for all to authenticated
  using (public.has_role(auth.uid(), studio_id, 'admin') or public.has_role(auth.uid(), studio_id, 'owner'))
  with check (public.has_role(auth.uid(), studio_id, 'admin') or public.has_role(auth.uid(), studio_id, 'owner'));

-- payroll
create policy "payroll admin select" on public.payroll
  for select to authenticated
  using (public.has_role(auth.uid(), studio_id, 'admin') or public.has_role(auth.uid(), studio_id, 'owner'));
create policy "payroll admin write" on public.payroll
  for all to authenticated
  using (public.has_role(auth.uid(), studio_id, 'admin') or public.has_role(auth.uid(), studio_id, 'owner'))
  with check (public.has_role(auth.uid(), studio_id, 'admin') or public.has_role(auth.uid(), studio_id, 'owner'));

-- results
create policy "results self or trainer select" on public.results
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "results self or trainer insert" on public.results
  for insert to authenticated
  with check (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));
create policy "results trainer update" on public.results
  for update to authenticated using (public.is_trainer(auth.uid(), studio_id));
create policy "results trainer delete" on public.results
  for delete to authenticated using (public.is_trainer(auth.uid(), studio_id));
