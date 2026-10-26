-- Client active memberships — run on Supabase after db/sales.sql.
-- Adds:
--   * sales.source ('admin' | 'mobile')
--   * public.client_memberships table (active/replaced/expired/cancelled)
--   * trigger that auto-creates an active membership when a sale is inserted

-- 1) sales.source -------------------------------------------------------------
alter table public.sales
  add column if not exists source text not null default 'admin';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_source_check' and conrelid = 'public.sales'::regclass
  ) then
    alter table public.sales add constraint sales_source_check
      check (source in ('admin','mobile'));
  end if;
end
$$;

-- 2) client_memberships -------------------------------------------------------
create table if not exists public.client_memberships (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete set null,
  source text not null default 'admin' check (source in ('admin','mobile')),
  started_at date not null default current_date,
  ends_at date,                 -- null = бессрочно
  visits_left int,              -- null = безлимит
  status text not null default 'active' check (status in ('active','replaced','expired','cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists client_memberships_client_idx on public.client_memberships(client_id);
create index if not exists client_memberships_studio_idx on public.client_memberships(studio_id);
create unique index if not exists client_memberships_one_active
  on public.client_memberships(client_id) where status = 'active';

grant select, insert, update, delete on public.client_memberships to authenticated;
grant all on public.client_memberships to service_role;

alter table public.client_memberships enable row level security;

drop policy if exists "client_memberships studio select" on public.client_memberships;
create policy "client_memberships studio select" on public.client_memberships
  for select to authenticated
  using (studio_id = public.current_studio_id(auth.uid()));

drop policy if exists "client_memberships trainer write" on public.client_memberships;
create policy "client_memberships trainer write" on public.client_memberships
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- 3) Trigger -----------------------------------------------------------------
create or replace function public.activate_membership_from_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  computed_ends date;
begin
  select duration_days, visits_count
    into m
    from public.memberships
    where id = new.membership_id;

  -- mark any existing active membership as replaced
  update public.client_memberships
     set status = 'replaced'
   where client_id = new.client_id and status = 'active';

  computed_ends := case
    when m.duration_days is not null then (new.sold_at + (m.duration_days || ' days')::interval)::date
    else null
  end;

  insert into public.client_memberships (
    studio_id, client_id, membership_id, sale_id, source,
    started_at, ends_at, visits_left, status
  ) values (
    new.studio_id, new.client_id, new.membership_id, new.id, coalesce(new.source, 'admin'),
    new.sold_at, computed_ends, m.visits_count, 'active'
  );

  return new;
end
$$;

drop trigger if exists trg_activate_membership_from_sale on public.sales;
create trigger trg_activate_membership_from_sale
  after insert on public.sales
  for each row execute function public.activate_membership_from_sale();

notify pgrst, 'reload schema';
