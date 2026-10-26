-- ============================================================================
-- Сотрудники — над студиями (решения владельца 2026-10-10).
--
-- Таблица trainers — справочник сотрудников: тренеры и администраторы
-- (trainers.role). Один и тот же сотрудник работает в нескольких студиях,
-- поэтому он больше не принадлежит студии: студии, где он работает, —
-- связка trainer_studios. Раздел «Сотрудники» в админке — в рейке, над
-- студиями; в расписании студии выбираются только её сотрудники. Доступ в
-- админку по-прежнему выдаётся отдельно, в «Доступах» (user_roles).
--
-- 1) trainer_studios — сотрудник ↔ студия (многие ко многим); переносим в неё
--    прежнюю привязку trainers.studio_id, колонку studio_id удаляем.
-- 2) Банковские реквизиты — trainer_bank_details, зарплатные ставки —
--    trainer_pay_rates. Обе читаются только сотрудниками: тренеров
--    по-прежнему видят клиенты (имена и фото в расписании приложения), а
--    номер счёта и ставки им видеть нельзя.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- Роль сотрудника (есть в db/trainers.sql; на случай базы без неё).
alter table public.trainers
  add column if not exists role text not null default 'trainer'
  check (role in ('trainer', 'admin'));

-- 1) Сотрудник ↔ студия ---------------------------------------------------------
create table if not exists public.trainer_studios (
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trainer_id, studio_id)
);
create index if not exists trainer_studios_studio_idx on public.trainer_studios(studio_id);

grant select, insert, update, delete on public.trainer_studios to authenticated;
grant all on public.trainer_studios to service_role;

alter table public.trainer_studios enable row level security;

-- Клиент видит связки своей студии (через них — тренеров), сотрудник — все.
drop policy if exists "trainer_studios select" on public.trainer_studios;
create policy "trainer_studios select" on public.trainer_studios
  for select to authenticated
  using (
    public.is_staff(auth.uid())
    or studio_id = public.current_studio_id(auth.uid())
  );

-- Привязать сотрудника к студии или отвязать — только сотрудник этой студии.
drop policy if exists "trainer_studios staff write" on public.trainer_studios;
create policy "trainer_studios staff write" on public.trainer_studios
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- Перенос привязки к студии. Через execute: после первого выполнения колонки
-- уже нет, а повторный (ручной) прогон не должен падать на разборе запроса.
do $$
declare
  n int;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'trainers' and column_name = 'studio_id'
  ) then
    execute
      'insert into public.trainer_studios (trainer_id, studio_id)
       select id, studio_id from public.trainers where studio_id is not null
       on conflict do nothing';
    get diagnostics n = row_count;
    raise notice 'Сотрудников привязано к студиям: %', n;
  end if;
end;
$$;

-- Прежние политики опираются на trainers.studio_id — снимаем до удаления колонки.
drop policy if exists "trainers studio select" on public.trainers;
drop policy if exists "trainers trainer write" on public.trainers;

alter table public.trainers drop column if exists studio_id;

-- Клиент видит сотрудников своей студии (имена и фото тренеров в расписании),
-- сотрудник — всех: справочник общий для студий.
drop policy if exists "trainers select" on public.trainers;
create policy "trainers select" on public.trainers
  for select to authenticated
  using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.trainer_studios ts
       where ts.trainer_id = trainers.id
         and ts.studio_id = public.current_studio_id(auth.uid())
    )
  );

drop policy if exists "trainers staff write" on public.trainers;
create policy "trainers staff write" on public.trainers
  for all to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

-- 2) Банковские реквизиты --------------------------------------------------------
-- bank: bog — Bank of Georgia, tbc — TBC Bank, credo — Credo Bank.
-- account_number — грузинский IBAN (GE + 20 знаков), хранится без пробелов.
create table if not exists public.trainer_bank_details (
  trainer_id uuid primary key references public.trainers(id) on delete cascade,
  bank text check (bank in ('bog', 'tbc', 'credo')),
  account_number text check (account_number ~ '^GE[0-9]{2}[A-Z]{2}[0-9]{16}$'),
  account_holder text,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.trainer_bank_details to authenticated;
grant all on public.trainer_bank_details to service_role;

alter table public.trainer_bank_details enable row level security;

drop policy if exists "trainer_bank_details staff" on public.trainer_bank_details;
create policy "trainer_bank_details staff" on public.trainer_bank_details
  for all to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

-- Зарплатные ставки ---------------------------------------------------------------
-- За смену администратора, групповую и персональную тренировку: у каждой
-- ставки свой флаг «получает ли её сотрудник сейчас» и сумма в лари. Сумма
-- хранится и при выключенной ставке — чтобы при включении не вводить заново.
create table if not exists public.trainer_pay_rates (
  trainer_id uuid primary key references public.trainers(id) on delete cascade,
  admin_shift_enabled boolean not null default false,
  admin_shift_rate numeric(10,2) check (admin_shift_rate >= 0),
  group_training_enabled boolean not null default false,
  group_training_rate numeric(10,2) check (group_training_rate >= 0),
  personal_training_enabled boolean not null default false,
  personal_training_rate numeric(10,2) check (personal_training_rate >= 0),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.trainer_pay_rates to authenticated;
grant all on public.trainer_pay_rates to service_role;

alter table public.trainer_pay_rates enable row level security;

drop policy if exists "trainer_pay_rates staff" on public.trainer_pay_rates;
create policy "trainer_pay_rates staff" on public.trainer_pay_rates
  for all to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

notify pgrst, 'reload schema';
