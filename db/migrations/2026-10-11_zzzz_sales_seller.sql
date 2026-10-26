-- ============================================================================
-- Продавец в продажах и зарплата по поступившим платежам (постановка
-- владельца 2026-10-11).
--
-- 1) «Администратор» в продажах (абонементы и прочие продажи, оба формата)
--    больше не подставляется из учётной записи вошедшего: его выбирают из
--    администраторов студии (справочник «Сотрудники») — можно внести продажу
--    за коллегу. sales.seller_id / other_sales.seller_id — сотрудник
--    справочника, admin_name — снимок его имени, admin_id — по-прежнему тот,
--    кто внёс продажу.
--    Старые продажи: seller_id заполняется по связке учётной записи
--    (trainers.user_id = admin_id), затем — по точному совпадению имени
--    (admin_name = имя единственного администратора студии с таким именем).
-- 2) Связка сотрудник ↔ учётная запись (trainers.user_id и RPC
--    staff_accounts_for_link из 2026-10-11_zzz_staff_payroll.sql) больше не
--    нужна — удаляется.
-- 3) payroll_lines: продажи в зарплату — не полной стоимостью абонемента, а
--    деньгами, поступившими за период: первый платёж (или вся сумма без
--    рассрочки) и доплаты по рассрочке в день внесения, в том числе по
--    абонементам, проданным раньше. Остальное в функции — как было.
--
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- 1) Продавец -----------------------------------------------------------------------
alter table public.sales
  add column if not exists seller_id uuid references public.trainers(id) on delete set null;
create index if not exists sales_seller_idx on public.sales(seller_id) where seller_id is not null;

alter table public.other_sales
  add column if not exists seller_id uuid references public.trainers(id) on delete set null;

comment on column public.sales.seller_id is
  'Администратор, который продал (сотрудник справочника trainers); admin_name — снимок имени, admin_id — кто внёс.';
comment on column public.other_sales.seller_id is
  'Администратор, который продал (сотрудник справочника trainers); admin_name — снимок имени, admin_id — кто внёс.';

do $$
declare
  n int;
begin
  -- По связке учётной записи — пока колонка есть (повторный прогон без неё).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'trainers' and column_name = 'user_id'
  ) then
    execute
      'update public.sales s set seller_id = t.id
         from public.trainers t
        where s.seller_id is null and s.admin_id is not null and t.user_id = s.admin_id';
    get diagnostics n = row_count;
    raise notice 'Продавец по учётной записи: % продаж', n;
    execute
      'update public.other_sales s set seller_id = t.id
         from public.trainers t
        where s.seller_id is null and s.admin_id is not null and t.user_id = s.admin_id';
  end if;
end;
$$;

-- По имени: единственный администратор студии с точно таким именем.
with match as (
  select s.id as sale_id, min(t.id::text)::uuid as trainer_id
    from public.sales s
    join public.trainer_studios ts on ts.studio_id = s.studio_id
    join public.trainers t on t.id = ts.trainer_id and t.role = 'admin'
   where s.seller_id is null
     and nullif(btrim(s.admin_name), '') is not null
     and lower(btrim(t.full_name)) = lower(btrim(s.admin_name))
   group by s.id
  having count(*) = 1
)
update public.sales s set seller_id = m.trainer_id from match m where s.id = m.sale_id;

with match as (
  select s.id as sale_id, min(t.id::text)::uuid as trainer_id
    from public.other_sales s
    join public.trainer_studios ts on ts.studio_id = s.studio_id
    join public.trainers t on t.id = ts.trainer_id and t.role = 'admin'
   where s.seller_id is null
     and nullif(btrim(s.admin_name), '') is not null
     and lower(btrim(t.full_name)) = lower(btrim(s.admin_name))
   group by s.id
  having count(*) = 1
)
update public.other_sales s set seller_id = m.trainer_id from match m where s.id = m.sale_id;

-- 2) Связка с учётной записью больше не нужна -------------------------------------
drop function if exists public.staff_accounts_for_link();
drop index if exists public.trainers_user_id_key;
alter table public.trainers drop column if exists user_id;

-- 3) Расчёт --------------------------------------------------------------------------
-- Как в 2026-10-11_zzz_staff_payroll.sql, кроме продаж (kind = sale): строки —
-- поступившие за период платежи по продажам сотрудника (продал или был
-- тренером), units — число платежей, amount — их сумма.
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
  -- Чьи продажи: администратор, который продал (seller_id), и тренер при
  -- продаже (trainer_id). union, а не union all: один человек в обеих ролях —
  -- одна продажа.
  sale_people as (
    select s.seller_id as trainer_id, s.id as sale_id
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.seller_id is not null
    union
    select s.trainer_id, s.id
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.trainer_id is not null
  ),
  -- Поступившие деньги: продажа без графика — вся сумма в день продажи;
  -- с графиком (рассрочка) — каждый внесённый платёж в день внесения
  -- (первый платёж графика внесён в день продажи). Так доплата по
  -- абонементу, проданному в прошлом месяце, идёт в период, когда внесена.
  payments as (
    select s.id as sale_id, s.studio_id, s.sold_at as d, s.total_amount as amount
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.sold_at between _from and _to
       and not exists (select 1 from public.sale_installments i where i.sale_id = s.id)
    union all
    select s.id, s.studio_id, coalesce(i.paid_at, i.due_date), i.amount
      from public.sale_installments i
      join public.sales s on s.id = i.sale_id
      join pk on pk.id = s.studio_id
     where i.paid
       and coalesce(i.paid_at, i.due_date) between _from and _to
  ),
  sold as (
    select p.trainer_id, pay.d, pay.studio_id, pay.amount as total_amount
      from sale_people p
      join visible v on v.trainer_id = p.trainer_id
      join payments pay on pay.sale_id = p.sale_id
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
