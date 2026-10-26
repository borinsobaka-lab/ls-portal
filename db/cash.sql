-- Cash register operations (Касса) — run on Supabase after db/schema.sql.

create table if not exists public.cash_operations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('income','expense')),
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  comment text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists cash_operations_studio_occurred_idx
  on public.cash_operations(studio_id, occurred_at desc);

notify pgrst, 'reload schema';

grant select, insert, update, delete on public.cash_operations to authenticated;
grant all on public.cash_operations to service_role;

alter table public.cash_operations enable row level security;

drop policy if exists "cash_operations studio select" on public.cash_operations;
create policy "cash_operations studio select" on public.cash_operations
  for select to authenticated
  using (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "cash_operations trainer write" on public.cash_operations;
create policy "cash_operations trainer write" on public.cash_operations
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
