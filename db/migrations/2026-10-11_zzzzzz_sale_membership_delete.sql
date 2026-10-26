-- ============================================================================
-- Продажа абонемента и выданный по ней абонемент клиента удаляются вместе
-- (решение владельца 2026-10-11).
--
-- Раньше client_memberships.sale_id был «on delete set null»: продажу удаляли
-- в «Продажах» — строка пропадала и из «Абонементов» (вью client_packages_list
-- строится по sales), а абонемент оставался у клиента в приложении и
-- продолжал списывать тренировки.
--
-- Имя с «zzzzzz»: файл опирается на packages_settle и balance_kind
-- (2026-10-11_zz_packages_personal_balance.sql, zzz_packages_renewal_queue) и
-- должен идти после них — мигратор выполняет файлы по порядку имён.
--
-- 1. Удаление продажи (sales) удаляет её абонементы клиента — триггер BEFORE
--    DELETE: внешний ключ «set null» срабатывает раньше любого AFTER-триггера.
--    Платежи рассрочки и возвраты удалялись каскадом и раньше.
-- 2. Удаление абонемента клиента напрямую удаляет и его продажу. Только для
--    прямого удаления (pg_trigger_depth() = 1): когда абонемент удаляет
--    триггер продажи или каскад (удаление клиента, студии), продажу не трогаем.
-- 3. После удаления действующего абонемента (active / frozen): прежний того же
--    вида баланса, который эта продажа заменила (replaced), снова действует,
--    если срок не вышел и действующего нет; в пакетной студии — очередь
--    продлений (packages_settle). Посещения, списанные с удалённого абонемента,
--    остаются посещениями (charged_membership_id — «set null»).
-- 4. Разово: в пакетных студиях абонементы без продажи — остатки удалённых
--    продаж (там каждый абонемент выдаётся продажей), удаляются. В подписочных
--    не трогаем: там могут быть абонементы, заведённые до привязки к продажам.
--
-- Оба формата. Идемпотентно.
-- ============================================================================

-- 3. После удаления абонемента клиента --------------------------------------

create or replace function public.client_memberships_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  -- Вернуть прежний абонемент, который заменила удалённая продажа.
  if old.status in ('active', 'frozen') and not exists (
    select 1 from public.client_memberships
     where client_id = old.client_id and balance_kind = old.balance_kind
       and status in ('active', 'frozen')
  ) then
    update public.client_memberships
       set status = 'active'
     where id = (
       select id from public.client_memberships
        where client_id = old.client_id and balance_kind = old.balance_kind
          and status = 'replaced'
          and created_at <= old.created_at
          and (ends_at is null or ends_at >= v_today)
        order by created_at desc
        limit 1
     );
  end if;

  -- Пакетная студия: ждущее продление становится текущим и т.п. Для
  -- подписочной и для удалённого клиента — ничего не делает.
  perform public.packages_settle(old.client_id);

  -- 2. Прямое удаление абонемента — удалить и продажу.
  if pg_trigger_depth() = 1 and old.sale_id is not null then
    delete from public.sales where id = old.sale_id;
  end if;

  return old;
end;
$$;

revoke all on function public.client_memberships_after_delete() from public, anon, authenticated;

drop trigger if exists client_memberships_after_delete on public.client_memberships;
create trigger client_memberships_after_delete
  after delete on public.client_memberships
  for each row execute function public.client_memberships_after_delete();

-- 1. Удаление продажи --------------------------------------------------------

create or replace function public.sales_delete_client_memberships()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.client_memberships where sale_id = old.id;
  return old;
end;
$$;

revoke all on function public.sales_delete_client_memberships() from public, anon, authenticated;

drop trigger if exists sales_delete_client_memberships on public.sales;
create trigger sales_delete_client_memberships
  before delete on public.sales
  for each row execute function public.sales_delete_client_memberships();

-- 4. Разово: остатки уже удалённых продаж в пакетных студиях ------------------

delete from public.client_memberships cm
 using public.studios st
 where st.id = cm.studio_id
   and st.format = 'packages'
   and cm.sale_id is null;

notify pgrst, 'reload schema';
