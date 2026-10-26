-- ============================================================================
-- Статус клуба без пробных абонементов (решение владельца 2026-10-14).
--
-- Пробный абонемент (memberships.kind = 'trial', пакетные клубы) дают тем, кто
-- пришёл попробовать студию, — клиент от него не становится ЧК. ЧК — после
-- продажи любого другого абонемента, БЧК — когда у такого клиента не осталось
-- действующих. Клиент, у которого были только пробные, остаётся ПЧК.
-- Пробные в статусе не считаются вовсе. Та же логика — computeClubStatus
-- (apps/admin/src/lib/client-status.ts) и «члены клуба» дашборда.
--
-- Вью — как в 2026-10-11_zzzzzzz_entry_cancel_no_show.sql, кроме отбора
-- абонементов. Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- c.* раскрывается при создании вью — пересоздаём целиком.
drop view if exists public.clients_with_status;
create view public.clients_with_status
with (security_invoker = true) as
select
  c.*,
  coalesce(c.last_name, '') || ' ' ||
  coalesce(c.first_name, '') || ' ' ||
  coalesce(c.full_name, '') as search_name,
  case
    when st.has_active then 'chk'
    when st.has_any then 'bchk'
    else 'pchk'
  end as club_status
from public.clients c
left join lateral (
  select
    count(*) > 0 as has_any,
    coalesce(
      bool_or(
        cm.status = 'frozen'
        or (cm.status = 'active' and (cm.ends_at is null or cm.ends_at >= current_date))
      ),
      false
    ) as has_active
  from public.client_memberships cm
  left join public.memberships m on m.id = cm.membership_id
  where cm.client_id = c.id
    and m.kind is distinct from 'trial'
) st on true;

grant select on public.clients_with_status to authenticated;

notify pgrst, 'reload schema';
