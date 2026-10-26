-- Promo codes — run on Supabase after db/schema.sql.

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  code text not null,
  expires_at date,
  discount_type text not null check (discount_type in ('amount','percent')),
  discount_value numeric(12,2) not null check (discount_value >= 0),
  usage_limit integer,
  usage_count integer not null default 0,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists promo_codes_studio_code_idx
  on public.promo_codes(studio_id, upper(code));

create index if not exists promo_codes_studio_idx
  on public.promo_codes(studio_id, created_at desc);

notify pgrst, 'reload schema';

grant select, insert, update, delete on public.promo_codes to authenticated;
grant all on public.promo_codes to service_role;

alter table public.promo_codes enable row level security;

drop policy if exists "promo_codes studio read" on public.promo_codes;
create policy "promo_codes studio read" on public.promo_codes
  for select to authenticated
  using (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "promo_codes studio write" on public.promo_codes;
create policy "promo_codes studio write" on public.promo_codes
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
