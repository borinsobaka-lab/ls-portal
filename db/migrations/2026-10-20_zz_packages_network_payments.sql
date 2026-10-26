-- ============================================================================
-- Платежи и комментарии продаж — сотрудникам любого клуба сети (решение
-- владельца 2026-10-20: администраторы пакетных клубов помогают друг другу).
--
-- В общих «Абонементах» (2026-10-20_packages_membership_transfer.sql)
-- сотрудник пакетного клуба видит продажи всех пакетных клубов. Теперь он и
-- отмечает их платежи, правит график («Редактировать платежи» —
-- replace_sale_installments, security invoker) и пишет комментарии
-- (sales.comment, sales.membership_note):
--   * sale_installments — всё, как сотруднику клуба продажи (политика
--     «sale_installments network write»);
--   * sales — update сотруднику сети («sales network update»), но
--     сотрудник не клуба продажи меняет только комментарии и
--     remaining_installments (его пересчитывает replace_sale_installments) —
--     остальное (клиент, сумма, продавец, клуб…) сторожит триггер
--     sales_network_update_guard.
-- Продать, удалить продажу, оформить возврат и переоформить абонемент — по-
-- прежнему только клуб продажи. Подписочные клубы не затронуты:
-- auth_network_studio_ids у них — только свои клубы.
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

drop policy if exists "sale_installments network write" on public.sale_installments;
create policy "sale_installments network write" on public.sale_installments
  for all to authenticated
  using (exists (
    select 1 from public.sales s
     where s.id = sale_installments.sale_id
       and s.studio_id = any ((select public.auth_network_studio_ids())::uuid[])))
  with check (exists (
    select 1 from public.sales s
     where s.id = sale_installments.sale_id
       and s.studio_id = any ((select public.auth_network_studio_ids())::uuid[])));

drop policy if exists "sales network update" on public.sales;
create policy "sales network update" on public.sales
  for update to authenticated
  using (studio_id = any ((select public.auth_network_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_network_studio_ids())::uuid[]));

create or replace function public.sales_network_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free constant text[] := array['comment', 'membership_note', 'remaining_installments',
                                  'updated_at'];
begin
  -- Сервер, мигратор и функции без вызывающего, сотрудник клуба продажи —
  -- без ограничений.
  if auth.uid() is null or public.is_trainer(auth.uid(), old.studio_id) then
    return new;
  end if;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'В продаже другого клуба можно менять только платежи и комментарии'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists sales_network_update_guard_bu on public.sales;
create trigger sales_network_update_guard_bu
  before update on public.sales
  for each row execute function public.sales_network_update_guard();
