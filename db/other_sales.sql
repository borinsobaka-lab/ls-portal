-- ============================================================================
-- Прочие продажи: каталог услуг/товаров + продажи по позициям.
-- Отдельно от sales (там — абонементы). Идемпотентно, безопасно перезапускать.
-- Запускать после db/clients.sql, db/schema.sql (нужны studios, clients, is_trainer).
--
-- Сценарий: менеджер в студии в разделе «Прочие продажи» выбирает позицию
-- (услуга/товар), количество, цену, при желании клиента — и фиксирует продажу.
-- Позиции ведутся в каталоге sale_items (вкладка «Позиции» того же раздела).
-- ============================================================================

-- 1) Каталог позиций (услуги и товары, доступные для выбора при продаже) ------
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  kind text not null check (kind in ('service','product')),
  name text not null,
  price numeric(12,2) not null default 0 check (price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sale_items_studio_idx on public.sale_items(studio_id, kind);

-- 2) Продажи позиций ---------------------------------------------------------
create table if not exists public.other_sales (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  item_id uuid references public.sale_items(id) on delete set null,
  -- снапшот позиции на момент продажи (переживает правки/удаление каталога)
  item_kind text not null check (item_kind in ('service','product')),
  item_name text not null,
  -- услугу можно привязать к клиенту; товар — не обязательно
  client_id uuid references public.clients(id) on delete set null,
  admin_id uuid references auth.users(id) on delete set null,
  admin_name text,
  quantity int not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  comment text,
  sold_at date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists other_sales_studio_sold_idx on public.other_sales(studio_id, sold_at desc);
create index if not exists other_sales_client_idx on public.other_sales(client_id);
create index if not exists other_sales_item_idx on public.other_sales(item_id);

-- 3) Гранты + RLS: только сотрудник студии -----------------------------------
grant select, insert, update, delete on public.sale_items to authenticated;
grant all on public.sale_items to service_role;
grant select, insert, update, delete on public.other_sales to authenticated;
grant all on public.other_sales to service_role;

alter table public.sale_items enable row level security;
alter table public.other_sales enable row level security;

drop policy if exists "sale_items studio read" on public.sale_items;
create policy "sale_items studio read" on public.sale_items
  for select to authenticated
  using (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "sale_items staff write" on public.sale_items;
create policy "sale_items staff write" on public.sale_items
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "other_sales studio rw" on public.other_sales;
create policy "other_sales studio rw" on public.other_sales
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- updated_at на каталоге
drop trigger if exists sale_items_updated_at on public.sale_items;
create trigger sale_items_updated_at
  before update on public.sale_items
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
