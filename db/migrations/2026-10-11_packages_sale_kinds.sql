-- ============================================================================
-- Пакетные студии: типы номенклатуры и типы продаж (решение владельца
-- 2026-10-11).
--
-- 1. memberships.kind — номенклатура пакетной студии: «пакет тренировок»
--    (package) или «пробное посещение» (trial). Продажа «Пробное» предлагает
--    только пробные, остальные продажи — только пакеты. Подписочный формат
--    колонку не использует (у его строк — умолчание package).
-- 2. sales.sale_kind — тип продажи для аналитики: new (новая продажа в
--    студии), trial (пробное), upsell (допродажа — продали позже, например в
--    чате), renewal (продление — клиенту, у которого уже были абонементы).
--    null — продажа без типа: подписочные студии, покупки из приложения,
--    продажи до этой миграции.
-- 3. Вью sales_list пересоздаётся: s.* раскрывается при создании вью, без
--    пересоздания новой колонки в ней нет. Определение — как в
--    db/performance_indexes.sql.
--
-- Совместимо: новые колонки с умолчаниями, смысл старых не меняется.
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

alter table public.memberships
  add column if not exists kind text not null default 'package';

alter table public.memberships drop constraint if exists memberships_kind_check;
alter table public.memberships add constraint memberships_kind_check
  check (kind in ('package', 'trial'));

comment on column public.memberships.kind is
  'Пакетный формат: package — пакет тренировок, trial — пробное посещение. Подписочный формат не использует.';

alter table public.sales
  add column if not exists sale_kind text;

alter table public.sales drop constraint if exists sales_sale_kind_check;
alter table public.sales add constraint sales_sale_kind_check
  check (sale_kind is null or sale_kind in ('new', 'trial', 'upsell', 'renewal'));

comment on column public.sales.sale_kind is
  'Пакетный формат: new — новая продажа, trial — пробное, upsell — допродажа, renewal — продление. null — без типа (подписочный формат, приложение, старые продажи).';

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

notify pgrst, 'reload schema';
