-- ============================================================================
-- «Абонементы» пакетных клубов — общий раздел и «Переоформить» (решения
-- владельца 2026-10-20).
--
-- 1. Раздел «Абонементы» показывает продажи всех пакетных клубов сети (как
--    общая база клиентов, 2026-10-17_packages_shared_clients.sql): читать их
--    сотруднику сети уже можно («sales network read»), разделение по клубам
--    остаётся — продажа, касса, зарплаты, дашборд по sales.studio_id. Вью
--    client_packages_list получает studio_name — колонку «Клуб продажи» и её
--    сортировку.
--
-- 2. «Переоформить» — передать абонемент другому клиенту: RPC
--    transfer_client_membership(p_sale_id, p_client_id) меняет владельца
--    продажи и выданного по ней абонемента (sales.client_id,
--    client_memberships.client_id); статус, остаток, срок, заморозка,
--    платежи, продавец и тренер не меняются. Можно, если:
--      * вызывающий — сотрудник клуба продажи (как правка и удаление продажи);
--      * новый владелец — клиент той же сети (общая база пакетных клубов);
--      * абонемент действует, заморожен или ждёт в очереди (истёкший — и
--        по сроку, заменённый, отменённый и с возвратом — нет: передавать
--        нечего);
--      * все платежи внесены (абонемент с долгом не передаётся);
--      * у нового владельца нет живого (действующего или замороженного)
--        абонемента того же вида баланса, если переоформляемый живой: у
--        клиента один живой абонемент на вид (client_memberships_one_live_per_balance).
--        Ждущий в очереди встаёт в очередь нового владельца.
--    После переноса очередь досчитывается у обоих (packages_settle): у
--    прежнего владельца продление становится текущим, у нового ждущий без
--    живого абонемента — текущим, как при продаже.
--    Кто и когда переоформил, с кого — sales.transferred_from_client_id,
--    transferred_from_name (снимок имени), transferred_at, transferred_by;
--    во вью — transferred_from_name, transferred_at («Переоформлен с …» в
--    строке раздела).
--
-- Вью — как в 2026-10-18_zzzzz_client_packages_filters.sql, плюс колонки в
-- конце (актуальное определение — здесь). Идемпотентно.
-- ============================================================================

-- 1. Отметка о переоформлении ------------------------------------------------

alter table public.sales
  add column if not exists transferred_from_client_id uuid
    references public.clients(id) on delete set null,
  add column if not exists transferred_from_name text,
  add column if not exists transferred_at timestamptz,
  add column if not exists transferred_by uuid references auth.users(id) on delete set null;

comment on column public.sales.transferred_from_client_id is
  'Абонемент переоформлен с этого клиента (последнее переоформление, transfer_client_membership).';
comment on column public.sales.transferred_from_name is
  'Имя прежнего владельца на момент переоформления — остаётся и после удаления его карточки.';

-- 2. Переоформить --------------------------------------------------------------

create or replace function public.transfer_client_membership(p_sale_id uuid, p_client_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_cm public.client_memberships%rowtype;
  v_from public.clients%rowtype;
  v_to public.clients%rowtype;
  v_live record;
  v_status text;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Абонемент не найден';
  end if;
  if not public.is_trainer(auth.uid(), v_sale.studio_id) then
    raise exception 'Переоформить абонемент может только сотрудник клуба, где его продали'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.studios
                  where id = v_sale.studio_id and format = 'packages') then
    raise exception 'Переоформить можно только абонемент клуба с пакетами тренировок';
  end if;

  select * into v_to from public.clients where id = p_client_id;
  if not found or not public.studios_same_network(v_sale.studio_id, v_to.studio_id) then
    raise exception 'Клиент не найден в базе клубов';
  end if;
  if v_to.id = v_sale.client_id then
    raise exception 'Абонемент уже оформлен на этого клиента';
  end if;

  -- Обе карточки — под блокировкой в одном порядке (её же берёт
  -- packages_settle): параллельная продажа или отметка посещения не
  -- проскочит между проверкой и переносом.
  perform 1 from public.clients
   where id in (v_sale.client_id, v_to.id)
   order by id
     for update;
  select * into v_from from public.clients where id = v_sale.client_id;

  select * into v_cm from public.client_memberships
   where sale_id = v_sale.id
   order by created_at desc
   limit 1
     for update;
  if not found then
    raise exception 'По этой продаже нет абонемента — переоформлять нечего';
  end if;
  -- Действующий с прошедшим сроком «Абонементы» показывают истёкшим
  -- (client_packages_list.membership_state) — передавать нечего.
  if v_cm.status not in ('active', 'frozen', 'pending')
     or (v_cm.status = 'active' and v_cm.ends_at < (now() at time zone 'Asia/Tbilisi')::date) then
    raise exception 'Переоформить можно только действующий, замороженный или ожидающий абонемент';
  end if;

  if exists (select 1 from public.sale_installments i
              where i.sale_id = v_sale.id and (not i.paid or i.refunded)) then
    raise exception 'Абонемент не оплачен полностью — переоформить можно только после того, как внесены все платежи';
  end if;

  if v_cm.status in ('active', 'frozen') then
    select cm.status, cm.ends_at, m.name
      into v_live
      from public.client_memberships cm
      left join public.memberships m on m.id = cm.membership_id
     where cm.client_id = v_to.id
       and cm.balance_kind = v_cm.balance_kind
       and cm.status in ('active', 'frozen')
     limit 1;
    if found then
      raise exception 'У клиента уже есть % абонемент «%»%: два живых абонемента одного вида у клиента быть не может',
        case when v_live.status = 'frozen' then 'замороженный' else 'действующий' end,
        coalesce(v_live.name, '—'),
        case when v_live.ends_at is not null
             then ' до ' || to_char(v_live.ends_at, 'DD.MM.YYYY') else '' end
        using errcode = '23505';
    end if;
  end if;

  update public.sales
     set client_id = v_to.id,
         transferred_from_client_id = v_from.id,
         transferred_from_name = nullif(btrim(
           coalesce(nullif(btrim(concat_ws(' ', v_from.last_name, v_from.first_name)), ''),
                    v_from.full_name, '')), ''),
         transferred_at = now(),
         transferred_by = auth.uid()
   where id = v_sale.id;
  update public.client_memberships set client_id = v_to.id where sale_id = v_sale.id;

  perform public.packages_settle(v_from.id);
  perform public.packages_settle(v_to.id);

  select status into v_status from public.client_memberships where id = v_cm.id;
  return json_build_object(
    'from_client_id', v_from.id,
    'to_client_id', v_to.id,
    'status', v_status
  );
end;
$$;

revoke all on function public.transfer_client_membership(uuid, uuid) from public, anon;
grant execute on function public.transfer_client_membership(uuid, uuid) to authenticated;

-- 3. Вью «Абонементов» ----------------------------------------------------------

create or replace view public.client_packages_list
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
  coalesce(cl.phone2, '') || ' ' ||
  coalesce(cl.email, '') || ' ' ||
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
      'phone', cl.phone,
      'email', cl.email
    )
  end as clients,
  case
    when m.id is null then null
    else json_build_object(
      'id', m.id,
      'name', m.name,
      'kind', m.kind,
      'visits_count', m.visits_count,
      'personal_count', m.personal_count,
      'diagnostics_count', m.diagnostics_count
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
    when cm.status = 'refunded' or pay.refunded_count > 0 then 'refunded'
    when pay.unpaid_count = 0 then 'paid'
    when pay.next_due_date < (now() at time zone 'Asia/Tbilisi')::date then 'overdue'
    when pay.next_due_date <= (now() at time zone 'Asia/Tbilisi')::date + 2 then 'soon'
    else 'pending'
  end as payment_state,
  cm.started_at as membership_started_at,
  coalesce(cm.starts_on_first_visit, false) as starts_on_first_visit,
  s.source,
  s.promo_code,
  cm.diagnostics_left,
  case
    when s.onec_ref is not null then 'import'
    when s.source = 'mobile' then 'mobile'
    else 'admin'
  end as added_via,
  s.seller_id,
  case when m.kind = 'personal' then cm.personal_left else cm.visits_left end
    as balance_left,
  case
    when cm.status is null then null
    when cm.status = 'active' and coalesce(cm.starts_on_first_visit, false)
         and cm.started_at is null then 'awaiting'
    when cm.status = 'active' and cm.ends_at < (now() at time zone 'Asia/Tbilisi')::date
      then 'expired'
    else cm.status
  end as membership_state,
  -- 2026-10-20 (новые колонки — в конце: create or replace view не меняет
  -- порядок прежних): клуб продажи и переоформление.
  st.name as studio_name,
  s.transferred_from_name,
  s.transferred_at
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.personal_left, c.ends_at, c.started_at,
         c.starts_on_first_visit, c.diagnostics_left
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
        'payment_method', s.payment_method,
        'refunded', false
      ))
      else json_agg(json_build_object(
        'id', i.id,
        'amount', i.amount,
        'due_date', i.due_date,
        'paid', i.paid,
        'paid_at', i.paid_at,
        'payment_method', i.payment_method,
        'refunded', i.refunded
      ) order by i.due_date, i.created_at)
    end as payments,
    case
      when count(i.id) = 0 then s.total_amount
      else coalesce(sum(i.amount) filter (where i.paid), 0)
    end as paid_amount,
    min(i.due_date) filter (where not i.paid and not i.refunded) as next_due_date,
    count(i.id) filter (where not i.paid and not i.refunded) as unpaid_count,
    count(i.id) filter (where i.refunded) as refunded_count
  from public.sale_installments i
  where i.sale_id = s.id
) pay;

grant select on public.client_packages_list to authenticated;

notify pgrst, 'reload schema';
