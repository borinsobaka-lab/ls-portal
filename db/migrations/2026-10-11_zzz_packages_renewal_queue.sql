-- ============================================================================
-- Пакетные студии: продление встаёт в очередь; способ оплаты у платежей
-- рассрочки (решение владельца 2026-10-11).
--
-- Имя с «zzz»: файл дополняет 2026-10-11_zz_packages_personal_balance.sql
-- (balance_kind, personal_left, списание при attended) и должен идти после
-- него — мигратор выполняет файлы по порядку имён.
--
-- 1. Продление (sales.sale_kind = 'renewal', пакетная студия) не заменяет
--    действующий абонемент: новый абонемент клиента — статус pending («ждёт
--    начала»), флаг starts_on_first_visit, без дат начала и конца. Остальные
--    продажи — как в zz_packages_personal_balance (замена абонемента того же
--    вида баланса).
-- 2. Списание (schedule_bookings_charge_balance, посещение = attended) —
--    как в zz_packages_personal_balance, плюс: сначала действующий абонемент,
--    пока он годен на дату занятия и на нём есть остаток, потом ждущие по
--    порядку продажи. Первое посещение по продлению ставит его срок: начало —
--    дата занятия (по Тбилиси), конец — начало + duration_days. Сняли отметку
--    посещения — срок продления пересчитывается от первого из оставшихся
--    посещений (нет их — снова «с первого посещения»).
-- 3. Очередь (packages_settle, отдельно для каждого вида баланса): у
--    текущего кончился основной остаток (group — visits_left, personal —
--    personal_left) или срок, и есть ждущий — текущий expired, ждущий active;
--    текущего нет — ждущий сразу active (срок ещё не идёт, по нему можно
--    записаться в приложении). Вернули тренировку на исчерпанный текущий, а
--    продление ещё не начато — продление снова ждёт, прежний снова active.
--    Срок вышел без посещений — переход при следующем посещении клиента или
--    RPC packages_settle_my_memberships (клиентское приложение) /
--    packages_settle_studio (раздел «Абонементы» админки).
-- 4. sale_installments.payment_method — способ оплаты внесённого платежа
--    (как у sales / other_sales). Первому платежу рассрочки — способ оплаты
--    продажи. Вью client_packages_list отдаёт способ в платежах и начало
--    абонемента.
--
-- Совместимо с подписочным форматом: очередь и списание — только в студиях
-- format = 'packages', новые колонки с умолчаниями, started_at стал
-- необязательным (у прежних строк он заполнен). Идемпотентно.
-- ============================================================================

-- 1. Схема -----------------------------------------------------------------

alter table public.client_memberships
  add column if not exists starts_on_first_visit boolean not null default false;
alter table public.client_memberships alter column started_at drop not null;

comment on column public.client_memberships.starts_on_first_visit is
  'Пакетный формат: продление — срок (started_at/ends_at) считается от первого посещения по абонементу.';

-- pending — продление ждёт, пока закончится текущий. not valid: старые строки
-- не перепроверяем (в живой базе могли остаться статусы старых версий).
alter table public.client_memberships drop constraint if exists client_memberships_status_check;
alter table public.client_memberships add constraint client_memberships_status_check
  check (status in ('active', 'frozen', 'pending', 'replaced', 'expired', 'cancelled')) not valid;

alter table public.sale_installments
  add column if not exists payment_method public.payment_method;

comment on column public.sale_installments.payment_method is
  'Способ оплаты внесённого платежа (наличные / карта / перевод / приложение).';

-- Разово: первый (внесённый в день продажи) платёж — способом оплаты продажи.
update public.sale_installments i
   set payment_method = s.payment_method
  from public.sales s
 where s.id = i.sale_id
   and i.payment_method is null
   and i.paid
   and i.due_date = s.sold_at
   and s.payment_method is not null;

-- 2. Очередь абонементов клиента -------------------------------------------

create or replace function public.packages_settle(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_balance text;
  v_live public.client_memberships%rowtype;
  v_old public.client_memberships%rowtype;
  v_has_live boolean;
begin
  if p_client_id is null or not exists (
    select 1 from public.clients c
      join public.studios st on st.id = c.studio_id and st.format = 'packages'
     where c.id = p_client_id
  ) then
    return;
  end if;

  foreach v_balance in array array['group', 'personal'] loop
    select * into v_live from public.client_memberships
     where client_id = p_client_id and balance_kind = v_balance
       and status in ('active', 'frozen')
     limit 1;
    v_has_live := found;

    -- Вернули тренировку на исчерпанный прежний абонемент, а продление ещё
    -- не начато — прежний снова текущий, продление снова ждёт.
    if v_has_live and v_live.status = 'active' and v_live.starts_on_first_visit
       and v_live.started_at is null then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and id <> v_live.id
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end)
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'pending' where id = v_live.id;
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_live := v_old;
        v_live.status := 'active';
      end if;
    end if;

    -- Текущий кончился (основной остаток или срок), а продление ждёт.
    if v_has_live and v_live.status = 'active'
       and ((v_balance = 'personal' and v_live.personal_left <= 0)
            or (v_balance = 'group' and v_live.visits_left is not null and v_live.visits_left <= 0)
            or (v_live.ends_at is not null and v_live.ends_at < v_today))
       and exists (
         select 1 from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
       ) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    -- Текущего нет — ждущий (самый ранний по продаже) становится текущим.
    if not v_has_live then
      update public.client_memberships
         set status = 'active'
       where id = (
         select id from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
          order by created_at
          limit 1
       );
    end if;
  end loop;
end;
$$;

revoke all on function public.packages_settle(uuid) from public, anon, authenticated;

-- Срок продления от первого посещения: начало — самое раннее из посещений,
-- списанных с абонемента (кроме p_skip_booking), конец — начало + срок.
create or replace function public.packages_restart_term(p_cm_id uuid, p_skip_booking uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first date;
begin
  if not exists (
    select 1 from public.client_memberships where id = p_cm_id and starts_on_first_visit
  ) then
    return;
  end if;
  select min((se.starts_at at time zone 'Asia/Tbilisi')::date) into v_first
    from public.schedule_bookings b
    join public.schedule_entries se on se.id = b.entry_id
   where b.charged_membership_id = p_cm_id
     and b.id is distinct from p_skip_booking
     and b.status = 'attended';
  update public.client_memberships cm
     set started_at = v_first,
         ends_at = case when v_first is null or m.duration_days is null then null
                        else v_first + m.duration_days end
    from public.memberships m
   where cm.id = p_cm_id and m.id = cm.membership_id;
end;
$$;

revoke all on function public.packages_restart_term(uuid, uuid) from public, anon, authenticated;

-- 3. Списание при посещении: + ждущие продления и срок от первого посещения -
-- Тело — как в 2026-10-11_zz_packages_personal_balance.sql, изменения:
-- кандидаты — active и pending (active первым), после списания/возврата —
-- срок продления и очередь.

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
  v_first_visit boolean;
  v_started date;
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
      perform public.packages_restart_term(old.charged_membership_id, old.id);
      perform public.packages_settle(old.client_id);
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

  -- Срок продления, по которому ещё не ходили, не кончается (ends_at null);
  -- у начатого — обычная проверка конца срока.
  if v_kind = 'group' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status in ('active', 'pending')
       and cm.visits_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set visits_left = visits_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'visits';
    end if;
  elsif v_kind = 'personal' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status in ('active', 'pending')
       and cm.personal_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set personal_left = personal_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'personal';
    end if;
  end if;

  if v_cm is not null then
    -- Первое посещение по продлению (или более раннее, чем уже учтённое) —
    -- срок от даты этого занятия.
    if v_first_visit and (v_started is null or v_date < v_started) then
      update public.client_memberships cm
         set started_at = v_date,
             ends_at = case when m.duration_days is null then null
                            else v_date + m.duration_days end
        from public.memberships m
       where cm.id = v_cm and m.id = cm.membership_id;
    end if;
    perform public.packages_settle(new.client_id);
  end if;

  return new;
end;
$$;

-- 4. Продажа: продление встаёт в очередь -----------------------------------
-- Тело — как в 2026-10-11_zz_packages_personal_balance.sql, плюс ветка
-- продления пакетной студии.

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

  -- Продление ничего не вытесняет: ждёт, пока закончится текущий; срок — с
  -- первого посещения. balance_kind и personal_left поставит
  -- client_memberships_packages_fill.
  if new.sale_kind = 'renewal' and exists (
    select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
  ) then
    insert into public.client_memberships (
      studio_id, client_id, membership_id, sale_id, source,
      started_at, ends_at, visits_left, status, auto_renew, starts_on_first_visit
    ) values (
      new.studio_id, new.client_id, new.membership_id, new.id,
      coalesce(new.source, 'admin'),
      null, null, m.visits_count, 'pending', false, true
    );
    perform public.packages_settle(new.client_id);
    return new;
  end if;

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

-- 5. RPC: досчитать очередь (срок текущего вышел без посещений) -------------

create or replace function public.packages_settle_my_memberships()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  for v_client in
    select c.id from public.clients c where c.user_id = auth.uid()
  loop
    perform public.packages_settle(v_client);
  end loop;
end;
$$;

revoke all on function public.packages_settle_my_memberships() from public, anon;
grant execute on function public.packages_settle_my_memberships() to authenticated;

create or replace function public.packages_settle_studio(p_studio_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  if not public.is_trainer(auth.uid(), p_studio_id) then
    raise exception 'forbidden';
  end if;
  for v_client in
    select distinct cm.client_id from public.client_memberships cm
     where cm.studio_id = p_studio_id and cm.status = 'pending'
  loop
    perform public.packages_settle(v_client);
  end loop;
end;
$$;

revoke all on function public.packages_settle_studio(uuid) from public, anon;
grant execute on function public.packages_settle_studio(uuid) to authenticated;

-- 6. Вью раздела «Абонементы»: способ оплаты платежей, начало абонемента -----
-- Определение — как в 2026-10-11_zz_packages_personal_balance.sql, плюс
-- payment_method в платежах и две колонки в конце.

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
  end as payment_state,
  cm.started_at as membership_started_at,
  coalesce(cm.starts_on_first_visit, false) as starts_on_first_visit
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.personal_left, c.ends_at, c.started_at,
         c.starts_on_first_visit
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
        'paid_at', s.sold_at,
        'payment_method', s.payment_method
      ))
      else json_agg(json_build_object(
        'id', i.id,
        'amount', i.amount,
        'due_date', i.due_date,
        'paid', i.paid,
        'paid_at', i.paid_at,
        'payment_method', i.payment_method
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
