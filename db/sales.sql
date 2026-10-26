-- Sales (Продажи) — run on Supabase after db/schema.sql, db/clients.sql, db/memberships.sql.

-- The legacy `installments` column (1/2/3) was replaced by `down_payment_amount`
-- + `remaining_installments` (0/2/3). Run the whole file to migrate existing rows.

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete restrict,
  admin_id uuid references auth.users(id) on delete set null,
  admin_name text,
  sold_at date not null default current_date,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  down_payment_amount numeric(12,2) not null default 0 check (down_payment_amount >= 0 and down_payment_amount <= total_amount),
  remaining_installments smallint not null default 0 check (remaining_installments in (0,2,3)),
  comment text,
  created_at timestamptz not null default now()
);

-- Repair existing tables that were created before this migration.
alter table public.sales
  add column if not exists down_payment_amount numeric(12,2) not null default 0,
  add column if not exists remaining_installments smallint not null default 0,
  drop column if exists installments;

-- Make sure the check constraints exist even on older tables.
-- (PostgreSQL has no "add constraint if not exists", so we use a helper block.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_remaining_installments_check' and conrelid = 'public.sales'::regclass
  ) then
    alter table public.sales add constraint sales_remaining_installments_check
      check (remaining_installments in (0,2,3));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_down_payment_check' and conrelid = 'public.sales'::regclass
  ) then
    alter table public.sales add constraint sales_down_payment_check
      check (down_payment_amount >= 0 and down_payment_amount <= total_amount);
  end if;
end
$$;

create table if not exists public.sale_installments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  due_date date not null,
  amount numeric(12,2) not null check (amount >= 0),
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists sales_studio_sold_idx on public.sales(studio_id, sold_at desc);
create index if not exists sales_client_idx on public.sales(client_id);
create index if not exists sale_installments_sale_idx on public.sale_installments(sale_id);

notify pgrst, 'reload schema';

grant select, insert, update, delete on public.sales to authenticated;
grant all on public.sales to service_role;

grant select, insert, update, delete on public.sale_installments to authenticated;
grant all on public.sale_installments to service_role;

alter table public.sales enable row level security;
alter table public.sale_installments enable row level security;

drop policy if exists "sales studio rw" on public.sales;
create policy "sales studio rw" on public.sales
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "sale_installments via sale" on public.sale_installments;
create policy "sale_installments via sale" on public.sale_installments
  for all to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_installments.sale_id
        and public.is_trainer(auth.uid(), s.studio_id)
    )
  )
  with check (
    exists (
      select 1 from public.sales s
      where s.id = sale_installments.sale_id
        and public.is_trainer(auth.uid(), s.studio_id)
    )
  );

-- Payment type and promo code (added later).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_payment_type') then
    create type public.sale_payment_type as enum ('first', 'recurring', 'other');
  end if;
end
$$;

alter table public.sales
  add column if not exists payment_type public.sale_payment_type not null default 'other',
  add column if not exists promo_code text;

notify pgrst, 'reload schema';
