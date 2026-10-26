-- ============================================================================
-- Платёжные детали, скидки и возвраты на продажах (абонементы + прочие).
-- Идемпотентно. Все поля nullable/с дефолтами — существующие строки не ломаются,
-- поведение не меняется до подключения в UI. Ложится под будущий эквайринг.
-- Запускать после db/sales.sql, db/other_sales.sql, db/promo_codes.sql.
-- ============================================================================

-- Способ оплаты
do $$ begin
  create type public.payment_method as enum ('cash','card','transfer','app');
exception when duplicate_object then null; end $$;

-- 1) sales (абонементы): оплата + скидка -------------------------------------
alter table public.sales
  add column if not exists payment_method    public.payment_method,
  add column if not exists acquirer          text,
  add column if not exists transaction_id    text,
  add column if not exists acquirer_fee      numeric(12,2) not null default 0 check (acquirer_fee >= 0),
  add column if not exists fiscal_receipt_id text,
  add column if not exists list_price        numeric(12,2),      -- цена каталога до скидки
  add column if not exists discount_amount   numeric(12,2) not null default 0 check (discount_amount >= 0),
  add column if not exists promo_code_id     uuid references public.promo_codes(id) on delete set null;

-- 2) other_sales (услуги/товары): оплата + скидка ----------------------------
alter table public.other_sales
  add column if not exists payment_method    public.payment_method,
  add column if not exists acquirer          text,
  add column if not exists transaction_id    text,
  add column if not exists acquirer_fee      numeric(12,2) not null default 0 check (acquirer_fee >= 0),
  add column if not exists fiscal_receipt_id text,
  add column if not exists discount_amount   numeric(12,2) not null default 0 check (discount_amount >= 0),
  add column if not exists promo_code_id     uuid references public.promo_codes(id) on delete set null;

-- 3) Возвраты — единая сущность: ссылается ЛИБО на sale, ЛИБО на other_sale ---
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete set null,
  other_sale_id uuid references public.other_sales(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 0),
  reason text,
  method public.payment_method,
  refunded_by uuid references auth.users(id) on delete set null,
  refunded_by_name text,
  refunded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint refunds_one_target check (num_nonnulls(sale_id, other_sale_id) = 1)
);
create index if not exists refunds_studio_idx on public.refunds(studio_id, refunded_at desc);
create index if not exists refunds_sale_idx on public.refunds(sale_id);
create index if not exists refunds_other_sale_idx on public.refunds(other_sale_id);

grant select, insert, update, delete on public.refunds to authenticated;
grant all on public.refunds to service_role;
alter table public.refunds enable row level security;

drop policy if exists "refunds studio rw" on public.refunds;
create policy "refunds studio rw" on public.refunds
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

notify pgrst, 'reload schema';
