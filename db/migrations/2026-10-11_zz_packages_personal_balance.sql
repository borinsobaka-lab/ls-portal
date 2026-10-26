-- ============================================================================
-- Пакетные студии: персональные тренировки и списание с баланса (решение
-- владельца 2026-10-11).
--
-- Имя с «zz»: файл должен идти после 2026-10-11_packages_sale_kinds.sql
-- (memberships.kind) и 2026-10-11_packages_client_memberships.sql (вью
-- client_packages_list) — мигратор выполняет файлы по порядку имён.
--
-- 1. Номенклатура: третий тип memberships.kind = 'personal' — «Пакет
--    персональных тренировок»; memberships.personal_count — сколько
--    персональных входит в номенклатуру: у пакета тренировок — подарочные
--    (0 — нет), у пакета персональных — само количество (visits_count у него
--    0: обычных тренировок в нём нет, и записаться по нему на групповое
--    нельзя — book_schedule_entry ищет абонемент с visits_left > 0).
-- 2. Абонемент клиента: client_memberships.personal_left — баланс
--    персональных, отдельный от visits_left (обычные тренировки);
--    balance_kind — group (пакет тренировок, пробное, подписочные) или
--    personal (пакет персональных). Оба ставит BEFORE INSERT-триггер по
--    номенклатуре (пакетные студии), кто бы ни вставлял строку.
-- 3. «Живой» абонемент — один на клиента И вид баланса: пакет персональных
--    не вытесняет пакет тренировок и наоборот. Индекс client_memberships_one_live
--    (client_id) заменён на (client_id, balance_kind); у подписочных студий
--    balance_kind всегда group — для них ничего не меняется.
--    activate_membership_from_sale — версия из db/membership_freeze.sql (с
--    auto_renew), замена — только абонемента того же вида баланса.
-- 4. Списание: посещение зафиксировано (schedule_bookings.status →
--    attended) в пакетной студии — минус одна тренировка: на групповом — с
--    visits_left, на персональном — с personal_left; абонемент — действующий
--    (active, срок не кончился к дате занятия) с остатком > 0, раньше
--    кончающийся — первым. Откуда списано — schedule_bookings.charged_*;
--    отметку сняли (attended → другой статус) — тренировка возвращается.
--    Остатка нет — посещение фиксируется без списания. Прошлые посещения не
--    списываются задним числом. Подписочные студии не затронуты.
-- 5. Вью client_packages_list: personal_left, personal_count и новое
--    состояние оплаты soon — невнесённый платёж сегодня или в ближайшие два
--    дня (синяя полоска); pending (платёж позже) больше не подсвечивается.
--
-- Совместимо: новые колонки с умолчаниями. Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Номенклатура ------------------------------------------------------------

alter table public.memberships
  add column if not exists personal_count int not null default 0;

alter table public.memberships drop constraint if exists memberships_personal_count_check;
alter table public.memberships add constraint memberships_personal_count_check
  check (personal_count >= 0);

comment on column public.memberships.personal_count is
  'Пакетный формат: сколько персональных тренировок входит (у пакета тренировок — подарочные, у пакета персональных — количество).';

alter table public.memberships drop constraint if exists memberships_kind_check;
alter table public.memberships add constraint memberships_kind_check
  check (kind in ('package', 'trial', 'personal'));

comment on column public.memberships.kind is
  'Пакетный формат: package — пакет тренировок, trial — пробное посещение, personal — пакет персональных тренировок. Подписочный формат не использует.';

-- 2. Абонемент клиента ------------------------------------------------------

alter table public.client_memberships
  add column if not exists personal_left int not null default 0,
  add column if not exists balance_kind text not null default 'group';

alter table public.client_memberships drop constraint if exists client_memberships_balance_kind_check;
alter table public.client_memberships add constraint client_memberships_balance_kind_check
  check (balance_kind in ('group', 'personal'));

comment on column public.client_memberships.personal_left is
  'Пакетный формат: остаток персональных тренировок (списывается на персональных занятиях).';
comment on column public.client_memberships.balance_kind is
  'group — обычные тренировки (пакет, пробное, подписка), personal — пакет персональных. Живой абонемент — один на клиента и вид.';

create or replace function public.client_memberships_packages_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_personal int;
begin
  select m.kind, m.personal_count into v_kind, v_personal
    from public.memberships m
    join public.studios s on s.id = m.studio_id and s.format = 'packages'
   where m.id = new.membership_id;
  if found then
    new.personal_left := coalesce(v_personal, 0);
    if v_kind = 'personal' then
      new.balance_kind := 'personal';
      new.visits_left := 0;
    else
      new.balance_kind := 'group';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_memberships_packages_fill_bi on public.client_memberships;
create trigger client_memberships_packages_fill_bi
  before insert on public.client_memberships
  for each row execute function public.client_memberships_packages_fill();

-- 3. Один живой абонемент на клиента и вид баланса -------------------------

drop index if exists public.client_memberships_one_active;
drop index if exists public.client_memberships_one_live;
create unique index if not exists client_memberships_one_live_per_balance
  on public.client_memberships(client_id, balance_kind) where status in ('active', 'frozen');

create or replace function public.activate_membership_from_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  computed_ends date;
  v_balance text;
begin
  select duration_days, visits_count, auto_renew, kind
    into m
    from public.memberships
    where id = new.membership_id;

  -- Пакет персональных — свой вид баланса: вытесняет только такой же.
  v_balance := case
    when m.kind = 'personal'
     and exists (select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages')
      then 'personal'
    else 'group'
  end;

  update public.client_memberships
     set status = 'replaced'
   where client_id = new.client_id
     and status in ('active','frozen')
     and balance_kind = v_balance;

  computed_ends := case
    when m.duration_days is not null
      then (new.sold_at + (m.duration_days || ' days')::interval)::date
    else null
  end;

  -- balance_kind и personal_left поставит client_memberships_packages_fill.
  insert into public.client_memberships (
    studio_id, client_id, membership_id, sale_id, source,
    started_at, ends_at, visits_left, status, auto_renew
  ) values (
    new.studio_id, new.client_id, new.membership_id, new.id,
    coalesce(new.source, 'admin'),
    new.sold_at, computed_ends, m.visits_count, 'active',
    coalesce(m.auto_renew, false)
  );

  return new;
end
$$;

-- 4. Списание тренировок при посещении -------------------------------------

alter table public.schedule_bookings
  add column if not exists charged_membership_id uuid
    references public.client_memberships(id) on delete set null,
  add column if not exists charged_balance text;

alter table public.schedule_bookings drop constraint if exists schedule_bookings_charged_balance_check;
alter table public.schedule_bookings add constraint schedule_bookings_charged_balance_check
  check (charged_balance is null or charged_balance in ('visits', 'personal'));

comment on column public.schedule_bookings.charged_membership_id is
  'Пакетный формат: с какого абонемента списана тренировка за это посещение (charged_balance — visits или personal).';

-- Имя после schedule_bookings_link_person_biu (BEFORE-триггеры идут по имени):
-- к этому моменту client_id у записи из приложения уже подставлен.
create or replace function public.schedule_bookings_charge_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_starts timestamptz;
  v_date date;
  v_cm uuid;
begin
  -- Отметку посещения сняли — тренировка возвращается на тот же абонемент.
  if tg_op = 'UPDATE' and old.status = 'attended' and new.status is distinct from 'attended' then
    if old.charged_membership_id is not null then
      if old.charged_balance = 'personal' then
        update public.client_memberships set personal_left = personal_left + 1
         where id = old.charged_membership_id;
      else
        update public.client_memberships set visits_left = visits_left + 1
         where id = old.charged_membership_id and visits_left is not null;
      end if;
    end if;
    new.charged_membership_id := null;
    new.charged_balance := null;
    return new;
  end if;

  if new.status is distinct from 'attended'
     or (tg_op = 'UPDATE' and old.status = 'attended')
     or new.charged_membership_id is not null
     or new.client_id is null
     or not exists (
       select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
     ) then
    return new;
  end if;

  select se.kind, se.starts_at into v_kind, v_starts
    from public.schedule_entries se where se.id = new.entry_id;
  v_date := coalesce((v_starts at time zone 'Asia/Tbilisi')::date,
                     (now() at time zone 'Asia/Tbilisi')::date);

  if v_kind = 'group' then
    select cm.id into v_cm
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status = 'active'
       and cm.visits_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set visits_left = visits_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'visits';
    end if;
  elsif v_kind = 'personal' then
    select cm.id into v_cm
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status = 'active'
       and cm.personal_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set personal_left = personal_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'personal';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists schedule_bookings_status_charge_biu on public.schedule_bookings;
create trigger schedule_bookings_status_charge_biu
  before insert or update of status on public.schedule_bookings
  for each row execute function public.schedule_bookings_charge_balance();

-- 5. Раздел «Абонементы» ------------------------------------------------------

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
      'visits_count', m.visits_count,
      'personal_count', m.personal_count
    )
  end as memberships,
  cm.status as membership_status,
  cm.visits_left,
  cm.personal_left,
  cm.ends_at,
  pay.payments,
  pay.paid_amount,
  pay.next_due_date,
  case
    when pay.unpaid_count = 0 then 'paid'
    when pay.next_due_date < (now() at time zone 'Asia/Tbilisi')::date then 'overdue'
    when pay.next_due_date <= (now() at time zone 'Asia/Tbilisi')::date + 2 then 'soon'
    else 'pending'
  end as payment_state
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.personal_left, c.ends_at
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
