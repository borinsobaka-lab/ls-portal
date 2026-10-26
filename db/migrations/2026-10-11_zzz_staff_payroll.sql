-- ============================================================================
-- Зарплаты сотрудников пакетных студий (постановка владельца 2026-10-11).
--
-- Раздел рейки «Сотрудники», две новые страницы админки:
--   «График администраторов» — кто из администраторов работает в какой день
--     в каждой студии (admin_shifts) и корректировки оклада — вычеты и
--     надбавки (payroll_adjustments);
--   «Зарплаты» — оклад (смены администратора, групповые, персональные и
--     прочие занятия из расписания по «Зарплатным ставкам»), продажи и бонус
--     5 %, корректировки, итог и отметка «выплачено» (payroll_payouts) за
--     период: аванс 1–19 (выплата 20-го), основная 20–конец месяца (выплата
--     1-го следующего месяца).
--
-- Оклад у сотрудника общий по всем пакетным студиям: руководитель студии А
-- видит и тренировки своего тренера в студии Б, хотя расписание студии Б ему
-- RLS не отдаёт. Поэтому расчёт — security definer RPC payroll_lines: она
-- сама проверяет раздел «Сотрудники» и отдаёт строки только по сотрудникам,
-- привязанным к пакетной студии, где у вызывающего есть роль («Доступы»).
--
-- Продажи администратора — те, что он внёс в «Продажи» (sales.admin_id —
-- его учётная запись). Справочник сотрудников с учётными записями не был
-- связан: trainers.user_id — учётная запись админки сотрудника, выбирается в
-- карточке сотрудника (список учётных записей — RPC staff_accounts_for_link).
-- Продажи тренера — где он указан тренером при продаже (sales.trainer_id).
--
-- Подписочные студии не затронуты: в расчёт идут только данные пакетных.
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- 1) Сотрудник ↔ учётная запись админки ----------------------------------------
alter table public.trainers
  add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists trainers_user_id_key
  on public.trainers(user_id) where user_id is not null;

comment on column public.trainers.user_id is
  'Учётная запись админки сотрудника: по ней его продажи (sales.admin_id) идут в зарплату.';

-- Учётные записи сотрудников студий вызывающего — для выбора в карточке
-- сотрудника. profiles других студий RLS не отдаёт, поэтому definer.
create or replace function public.staff_accounts_for_link()
returns table (user_id uuid, full_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.email
    from public.profiles p
   where public.has_admin_section(auth.uid(), 'staff')
     and exists (
       select 1 from public.user_roles ur
        where ur.user_id = p.id
          and ur.role in ('owner', 'admin', 'trainer')
          and public.is_trainer(auth.uid(), ur.studio_id)
     )
   order by coalesce(nullif(p.full_name, ''), p.email)
$$;

revoke all on function public.staff_accounts_for_link() from public, anon;
grant execute on function public.staff_accounts_for_link() to authenticated, service_role;

-- 2) Чей это сотрудник ----------------------------------------------------------
-- Зарплатные данные сотрудника ведёт тот, у кого раздел «Сотрудники» и роль
-- хоть в одной студии сотрудника.
create or replace function public.can_manage_employee(_user_id uuid, _trainer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_admin_section(_user_id, 'staff')
     and exists (
       select 1 from public.trainer_studios ts
        where ts.trainer_id = _trainer_id
          and public.is_trainer(_user_id, ts.studio_id)
     )
$$;

revoke all on function public.can_manage_employee(uuid, uuid) from public, anon;
grant execute on function public.can_manage_employee(uuid, uuid) to authenticated, service_role;

-- Подпись «кто сделал»: ФИО из профиля, иначе почта.
create or replace function public.payroll_actor_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(full_name), ''), email)
    from public.profiles where id = auth.uid()
$$;

revoke all on function public.payroll_actor_name() from public, anon;
grant execute on function public.payroll_actor_name() to authenticated, service_role;

-- 3) График администраторов -------------------------------------------------------
-- Одна строка — один администратор в студии в этот день (в день их может
-- быть несколько).
create table if not exists public.admin_shifts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  shift_date date not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (studio_id, shift_date, trainer_id)
);
create index if not exists admin_shifts_date_idx on public.admin_shifts(shift_date);
create index if not exists admin_shifts_trainer_idx on public.admin_shifts(trainer_id, shift_date);

grant select, insert, update, delete on public.admin_shifts to authenticated;
grant all on public.admin_shifts to service_role;

alter table public.admin_shifts enable row level security;

drop policy if exists "admin_shifts staff" on public.admin_shifts;
create policy "admin_shifts staff" on public.admin_shifts
  for all to authenticated
  using (
    public.is_trainer(auth.uid(), studio_id)
    and public.has_admin_section(auth.uid(), 'staff')
  )
  with check (
    public.is_trainer(auth.uid(), studio_id)
    and public.has_admin_section(auth.uid(), 'staff')
  );

-- 4) Корректировки оклада ------------------------------------------------------------
-- bonus — надбавка, deduction — вычет; сумма всегда положительная, знак — в kind.
-- Попадает в период зарплаты по adjusted_on.
create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  kind text not null check (kind in ('bonus', 'deduction')),
  amount numeric(10,2) not null check (amount > 0),
  adjusted_on date not null,
  reason text not null check (btrim(reason) <> ''),
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists payroll_adjustments_date_idx
  on public.payroll_adjustments(adjusted_on);
create index if not exists payroll_adjustments_trainer_idx
  on public.payroll_adjustments(trainer_id, adjusted_on);

grant select, insert, update, delete on public.payroll_adjustments to authenticated;
grant all on public.payroll_adjustments to service_role;

alter table public.payroll_adjustments enable row level security;

drop policy if exists "payroll_adjustments staff" on public.payroll_adjustments;
create policy "payroll_adjustments staff" on public.payroll_adjustments
  for all to authenticated
  using (public.can_manage_employee(auth.uid(), trainer_id))
  with check (public.can_manage_employee(auth.uid(), trainer_id));

create or replace function public.payroll_adjustments_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := auth.uid();
  new.created_by_name := public.payroll_actor_name();
  return new;
end;
$$;

drop trigger if exists payroll_adjustments_stamp_bi on public.payroll_adjustments;
create trigger payroll_adjustments_stamp_bi
  before insert on public.payroll_adjustments
  for each row execute function public.payroll_adjustments_stamp();

-- 5) Выплаты ------------------------------------------------------------------------
-- Отметка «выплачено» за период; amount — сумма к выплате на момент отметки
-- (если потом добавят корректировку, админка покажет расхождение).
create table if not exists public.payroll_payouts (
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount numeric(12,2) not null,
  paid_at timestamptz not null default now(),
  paid_by uuid references auth.users(id) on delete set null,
  paid_by_name text,
  primary key (trainer_id, period_start, period_end),
  check (period_end >= period_start)
);
create index if not exists payroll_payouts_period_idx
  on public.payroll_payouts(period_start, period_end);

grant select, insert, update, delete on public.payroll_payouts to authenticated;
grant all on public.payroll_payouts to service_role;

alter table public.payroll_payouts enable row level security;

drop policy if exists "payroll_payouts staff" on public.payroll_payouts;
create policy "payroll_payouts staff" on public.payroll_payouts
  for all to authenticated
  using (public.can_manage_employee(auth.uid(), trainer_id))
  with check (public.can_manage_employee(auth.uid(), trainer_id));

create or replace function public.payroll_payouts_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.paid_by := auth.uid();
  new.paid_by_name := public.payroll_actor_name();
  new.paid_at := now();
  return new;
end;
$$;

drop trigger if exists payroll_payouts_stamp_biu on public.payroll_payouts;
create trigger payroll_payouts_stamp_biu
  before insert or update on public.payroll_payouts
  for each row execute function public.payroll_payouts_stamp();

-- 6) Расчёт ---------------------------------------------------------------------------
-- Строки зарплаты за период по сотрудникам, которых видит вызывающий:
--   shift    — смены администратора (admin_shifts, прошедшие и сегодняшняя);
--   group    — проведённые групповые занятия (уже начались);
--   personal — проведённые персональные;
--   other    — прочие активности (ставка занятия pay_rate, title — название);
--   sale     — продажи абонементов: внёс сотрудник (admin_id = его учётная
--              запись) или он тренер при продаже (trainer_id); amount — сумма
--              продаж, бонус считает админка.
-- Ставка выключена в «Зарплатных ставках» — строка есть, сумма 0.
-- Дни — по Тбилиси. Группировка: сотрудник × день × студия × вид (× название).
create or replace function public.payroll_lines(_from date, _to date)
returns table (
  trainer_id uuid,
  work_date date,
  studio_id uuid,
  studio_name text,
  kind text,
  title text,
  units integer,
  amount numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  _today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  if not public.has_admin_section(auth.uid(), 'staff') then
    raise exception 'Нет доступа к разделу «Сотрудники»' using errcode = '42501';
  end if;
  if _from is null or _to is null or _to < _from or _to - _from > 62 then
    raise exception 'Неверный период: %–%', _from, _to;
  end if;

  return query
  with pk as (
    select s.id, s.name from public.studios s where s.format = 'packages'
  ),
  visible as (
    select distinct ts.trainer_id
      from public.trainer_studios ts
      join pk on pk.id = ts.studio_id
     where public.is_trainer(auth.uid(), ts.studio_id)
  ),
  lessons as (
    select st.trainer_id,
           (e.starts_at at time zone 'Asia/Tbilisi')::date as d,
           e.studio_id,
           e.kind,
           case when e.kind = 'other' then e.title end as title,
           case e.kind
             when 'group' then
               case when r.group_training_enabled then coalesce(r.group_training_rate, 0) else 0 end
             when 'personal' then
               case when r.personal_training_enabled then coalesce(r.personal_training_rate, 0) else 0 end
             else coalesce(e.pay_rate, 0)
           end as rate
      from public.schedule_entries e
      join pk on pk.id = e.studio_id
      join public.schedule_entry_trainers st on st.entry_id = e.id
      join visible v on v.trainer_id = st.trainer_id
      left join public.trainer_pay_rates r on r.trainer_id = st.trainer_id
     where e.starts_at <= now()
       and (e.starts_at at time zone 'Asia/Tbilisi')::date between _from and _to
  ),
  shifts as (
    select a.trainer_id, a.shift_date as d, a.studio_id,
           case when r.admin_shift_enabled then coalesce(r.admin_shift_rate, 0) else 0 end as rate
      from public.admin_shifts a
      join pk on pk.id = a.studio_id
      join visible v on v.trainer_id = a.trainer_id
      left join public.trainer_pay_rates r on r.trainer_id = a.trainer_id
     where a.shift_date between _from and least(_to, _today)
  ),
  sale_links as (
    -- union, а не union all: внёс продажу и был на ней тренером — одна продажа.
    select t.id as trainer_id, s.id as sale_id
      from public.sales s
      join pk on pk.id = s.studio_id
      join public.trainers t on t.user_id = s.admin_id
     where s.sold_at between _from and _to
    union
    select s.trainer_id, s.id
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.trainer_id is not null
       and s.sold_at between _from and _to
  ),
  sold as (
    select l.trainer_id, s.sold_at as d, s.studio_id, s.total_amount
      from sale_links l
      join visible v on v.trainer_id = l.trainer_id
      join public.sales s on s.id = l.sale_id
  ),
  all_lines as (
    select x.trainer_id, x.d, x.studio_id, x.kind, x.title, 1 as n, x.rate as amount from lessons x
    union all
    select x.trainer_id, x.d, x.studio_id, 'shift', null, 1, x.rate from shifts x
    union all
    select x.trainer_id, x.d, x.studio_id, 'sale', null, 1, x.total_amount from sold x
  )
  select l.trainer_id, l.d, l.studio_id, pk.name, l.kind, l.title,
         count(*)::integer, sum(l.amount)
    from all_lines l
    join pk on pk.id = l.studio_id
   group by l.trainer_id, l.d, l.studio_id, pk.name, l.kind, l.title
   order by l.d, pk.name;
end;
$$;

revoke all on function public.payroll_lines(date, date) from public, anon;
grant execute on function public.payroll_lines(date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
