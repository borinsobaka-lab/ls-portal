-- ============================================================================
-- «Добавлен» в «Абонементах» пакетных клубов (решение владельца 2026-10-18,
-- как столбец «Добавлен» в «Клиентах» — 2026-10-18_zz_clients_source.sql).
--
-- client_packages_list.added_via — как продажа попала в базу: import —
-- перенос из 1С (sales.onec_ref, 2026-10-18_import_1c.sql), mobile — покупка
-- в приложении (sales.source; в пакетных клубах её пока нет —
-- 2026-10-16_packages_no_app_purchase.sql), admin — внесена в админке.
-- Считается из продажи, отдельной колонки в sales нет: source продажи
-- переходит в client_memberships.source, и «import» там нарушил бы проверку.
--
-- Вью — как в 2026-10-15_zz_diagnostics_client_requests.sql, плюс added_via
-- в конце (актуальное определение — здесь). Порядок: после
-- 2026-10-18_import_1c.sql (sales.onec_ref). Идемпотентно.
-- ============================================================================

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
  -- «Добавлен» (новая колонка — в конце: create or replace view не меняет
  -- порядок прежних).
  case
    when s.onec_ref is not null then 'import'
    when s.source = 'mobile' then 'mobile'
    else 'admin'
  end as added_via
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
