-- ============================================
-- STUDIO 40 — онбординг клиента: схема + RLS
-- Идемпотентно — можно прогонять повторно.
-- ============================================

-- 1. ENUM-типы
do $$ begin
  create type public.fitness_goal as enum (
    'weight_loss','muscle_strength','endurance',
    'energy_wellbeing','stress_habit','event_prep'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.experience_level as enum (
    'beginner','occasional','regular','advanced'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.target_timeframe as enum (
    'no_rush','few_months','event_date'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_gender as enum ('female','male','other');
exception when duplicate_object then null; end $$;

-- 2. Таблица профиля (одна строка на пользователя)
create table if not exists public.member_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Цели и мотивация
  primary_goal       public.fitness_goal,
  goal_motivation    text,
  target_timeframe   public.target_timeframe,
  desired_frequency  smallint,

  -- Опыт и нагрузка
  experience_level         public.experience_level,
  current_weekly_activity  smallint,
  tried_group_hiit         boolean,
  health_flags             text[] not null default '{}',
  health_notes             text,

  -- Базовые параметры
  height_cm   smallint,
  weight_kg   numeric(5,1),
  birth_year  smallint,
  gender      public.member_gender,

  -- Логистика и маркетинг
  preferred_times  text[] not null default '{}',
  referral_source  text,

  -- Служебное
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Гранты на Data API
grant select, insert, update, delete on public.member_profiles to authenticated;
grant all on public.member_profiles to service_role;

-- 4. Автообновление updated_at (используем общий триггер если есть)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists member_profiles_updated_at on public.member_profiles;
create trigger member_profiles_updated_at
  before update on public.member_profiles
  for each row execute function public.set_updated_at();

-- 5. RLS
alter table public.member_profiles enable row level security;

-- Клиент видит/меняет только свою строку
drop policy if exists own_profile_select on public.member_profiles;
create policy own_profile_select on public.member_profiles
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists own_profile_insert on public.member_profiles;
create policy own_profile_insert on public.member_profiles
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists own_profile_update on public.member_profiles;
create policy own_profile_update on public.member_profiles
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Тренер/админ студии видит профили своих клиентов
drop policy if exists staff_read_profiles on public.member_profiles;
create policy staff_read_profiles on public.member_profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.clients c
      where c.user_id = member_profiles.user_id
        and public.is_trainer(auth.uid(), c.studio_id)
    )
  );
