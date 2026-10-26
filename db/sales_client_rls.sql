-- RLS-политики, разрешающие клиенту мобильного приложения покупать абонемент.
-- Запустить в Supabase SQL Editor после db/sales.sql.

-- 1. Клиент видит только свои собственные продажи.
drop policy if exists "sales client select own" on public.sales;
create policy "sales client select own" on public.sales
  for select to authenticated
  using (
    exists (
      select 1 from public.clients c
      where c.id = sales.client_id
        and c.user_id = auth.uid()
    )
  );

-- 2. Клиент может вставить продажу только для самого себя,
--    в своей студии, без admin_id и без рассрочки.
drop policy if exists "sales client insert own" on public.sales;
create policy "sales client insert own" on public.sales
  for insert to authenticated
  with check (
    admin_id is null
    and remaining_installments = 0
    and exists (
      select 1 from public.clients c
      where c.id = sales.client_id
        and c.user_id = auth.uid()
        and c.studio_id = sales.studio_id
    )
  );

-- 3. Те же права на sale_installments через родительский sale.
drop policy if exists "sale_installments client select own" on public.sale_installments;
create policy "sale_installments client select own" on public.sale_installments
  for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      join public.clients c on c.id = s.client_id
      where s.id = sale_installments.sale_id
        and c.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
