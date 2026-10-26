-- ============================================================================
-- Пакетные студии: раздел «Абонементы» (решение владельца 2026-10-11).
--
-- В разделе — проданные клиентам абонементы (одна строка — одна продажа):
-- тренировок на балансе, сколько дней осталось, кто продал, кто был тренером
-- при продаже, комментарий продажи, свой комментарий раздела и платежи
-- рассрочки — администраторы по ним собирают деньги.
--
-- 1. sales.trainer_id / trainer_name — тренер при продаже (за продажу ему
--    потом начисляется бонус к зарплате). Имя — снимок на момент продажи, как
--    admin_name: если сотрудника удалят из справочника, продажа его помнит.
-- 2. sales.membership_note — комментарий, который вносят уже в «Абонементах»
--    (комментарий продажи sales.comment остаётся как был).
-- 3. sale_installments.paid_at — когда платёж фактически внесён. Ставит
--    триггер: отметили «внесён» без даты — сегодня (по Тбилиси), сняли
--    отметку — дата стирается. Прежние оплаченные платежи — дата по графику.
-- 4. Вью client_packages_list — строки раздела: продажи пакетных студий с
--    клиентом, номенклатурой, балансом абонемента, платежами (json) и
--    состоянием оплаты: paid — всё внесено, overdue — есть невнесённый платёж
--    с прошедшей датой, pending — следующий платёж ещё впереди (в т.ч.
--    сегодня). Продажа без графика (оплата сразу) — один внесённый платёж на
--    всю сумму в день продажи.
-- 5. Вью sales_list пересоздаётся: s.* раскрывается при создании вью, без
--    пересоздания новых колонок в ней нет. Определение — как в
--    2026-10-11_packages_sale_kinds.sql.
--
-- Совместимо с подписочным форматом: новые колонки без умолчаний-смыслов,
-- старые не меняются. Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- Колонки из 2026-10-11_packages_sale_kinds.sql, которые читают вью ниже: по
-- имени тот файл идёт ПОСЛЕ этого, и на чистой базе мигратор падал здесь на
-- «column s.sale_kind does not exist». Ограничения (check) ставит тот файл.
-- На живой базе этот файл уже выполнен — правка влияет только на новые базы.
alter table public.memberships
  add column if not exists kind text not null default 'package';
alter table public.sales
  add column if not exists sale_kind text;

alter table public.sales
  add column if not exists trainer_id uuid references public.trainers(id) on delete set null,
  add column if not exists trainer_name text,
  add column if not exists membership_note text;

comment on column public.sales.trainer_id is
  'Пакетный формат: тренер при продаже (бонус к зарплате). trainer_name — снимок имени.';
comment on column public.sales.membership_note is
  'Пакетный формат: комментарий раздела «Абонементы» (не путать с comment — комментарием продажи).';

create index if not exists sales_trainer_idx on public.sales(trainer_id)
  where trainer_id is not null;

alter table public.sale_installments
  add column if not exists paid_at date;

comment on column public.sale_installments.paid_at is
  'Когда платёж фактически внесён (null — не внесён). Ставит триггер sale_installments_paid_at.';

update public.sale_installments
   set paid_at = due_date
 where paid and paid_at is null;

create or replace function public.sale_installments_paid_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not new.paid then
    new.paid_at := null;
  elsif new.paid_at is null then
    new.paid_at := (now() at time zone 'Asia/Tbilisi')::date;
  end if;
  return new;
end
$$;

drop trigger if exists trg_sale_installments_paid_at on public.sale_installments;
create trigger trg_sale_installments_paid_at
  before insert or update of paid, paid_at on public.sale_installments
  for each row execute function public.sale_installments_paid_at();

-- sales_list: то же определение, чтобы s.* подхватил новые колонки.
drop view if exists public.sales_list;
create view public.sales_list
with (security_invoker = true) as
select
  s.*,
  coalesce(cl.last_name, '') || ' ' ||
  coalesce(cl.first_name, '') || ' ' ||
  coalesce(cl.full_name, '') || ' ' ||
  coalesce(m.name, '') as search_text,
  case
    when cl.id is null then null
    else json_build_object(
      'id', cl.id,
      'full_name', cl.full_name,
      'first_name', cl.first_name,
      'last_name', cl.last_name,
      'phone', cl.phone,
      'email', cl.email
    )
  end as clients,
  case
    when m.id is null then null
    else json_build_object('id', m.id, 'name', m.name)
  end as memberships,
  coalesce(
    (
      select json_agg(
        json_build_object(
          'id', cm.id,
          'status', cm.status,
          'auto_renew', cm.auto_renew,
          'ends_at', cm.ends_at,
          'cancelled_at', cm.cancelled_at
        )
      )
      from public.client_memberships cm
      where cm.sale_id = s.id
    ),
    '[]'::json
  ) as client_memberships
from public.sales s
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id;

grant select on public.sales_list to authenticated;

-- Раздел «Абонементы» пакетных студий.
drop view if exists public.client_packages_list;
create view public.client_packages_list
with (security_invoker = true) as
select
  s.id,
  s.studio_id,
  s.client_id,
  s.membership_id,
  s.admin_name,
  s.trainer_id,
  s.trainer_name,
  s.sold_at,
  s.total_amount,
  s.sale_kind,
  s.comment,
  s.membership_note,
  s.created_at,
  coalesce(cl.last_name, '') || ' ' ||
  coalesce(cl.first_name, '') || ' ' ||
  coalesce(cl.full_name, '') || ' ' ||
  coalesce(cl.phone, '') || ' ' ||
  coalesce(m.name, '') || ' ' ||
  coalesce(s.trainer_name, '') || ' ' ||
  coalesce(s.admin_name, '') as search_text,
  case
    when cl.id is null then null
    else json_build_object(
      'id', cl.id,
      'full_name', cl.full_name,
      'first_name', cl.first_name,
      'last_name', cl.last_name,
      'phone', cl.phone
    )
  end as clients,
  case
    when m.id is null then null
    else json_build_object(
      'id', m.id,
      'name', m.name,
      'kind', m.kind,
      'visits_count', m.visits_count
    )
  end as memberships,
  cm.status as membership_status,
  cm.visits_left,
  cm.ends_at,
  pay.payments,
  pay.paid_amount,
  pay.next_due_date,
  case
    when pay.unpaid_count = 0 then 'paid'
    when pay.next_due_date < (now() at time zone 'Asia/Tbilisi')::date then 'overdue'
    else 'pending'
  end as payment_state
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.ends_at
    from public.client_memberships c
   where c.sale_id = s.id
   order by c.created_at desc
   limit 1
) cm on true
cross join lateral (
  select
    case
      when count(i.id) = 0 then json_build_array(json_build_object(
        'id', null,
        'amount', s.total_amount,
        'due_date', s.sold_at,
        'paid', true,
        'paid_at', s.sold_at
      ))
      else json_agg(json_build_object(
        'id', i.id,
        'amount', i.amount,
        'due_date', i.due_date,
        'paid', i.paid,
        'paid_at', i.paid_at
      ) order by i.due_date, i.created_at)
    end as payments,
    case
      when count(i.id) = 0 then s.total_amount
      else coalesce(sum(i.amount) filter (where i.paid), 0)
    end as paid_amount,
    min(i.due_date) filter (where not i.paid) as next_due_date,
    count(i.id) filter (where not i.paid) as unpaid_count
  from public.sale_installments i
  where i.sale_id = s.id
) pay;

grant select on public.client_packages_list to authenticated;

notify pgrst, 'reload schema';
