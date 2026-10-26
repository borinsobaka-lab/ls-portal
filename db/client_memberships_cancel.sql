-- Auto-renew + cancellation fields on a client's active membership.
-- Run on Supabase after db/client_memberships.sql.

-- 1) Columns -----------------------------------------------------------------
alter table public.client_memberships
  add column if not exists auto_renew boolean not null default false,
  add column if not exists auto_renew_cancelled_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists cancel_source text check (cancel_source in ('admin','mobile','system'));

-- 2) Carry auto_renew from the catalog into a freshly-created membership ----
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
  select duration_days, visits_count, auto_renew
    into m
    from public.memberships
    where id = new.membership_id;

  update public.client_memberships
     set status = 'replaced'
   where client_id = new.client_id and status = 'active';

  computed_ends := case
    when m.duration_days is not null
      then (new.sold_at + (m.duration_days || ' days')::interval)::date
    else null
  end;

  insert into public.client_memberships (
    studio_id, client_id, membership_id, sale_id, source,
    started_at, ends_at, visits_left, status, auto_renew
  ) values (
    new.studio_id, new.client_id, new.membership_id, new.id,
    coalesce(new.source, 'admin'),
    new.sold_at, computed_ends, m.visits_count, 'active',
    coalesce(m.auto_renew, false)
  );

  return new;
end
$$;

-- 3) RPC: отключить автопродление у активного абонемента --------------------
create or replace function public.cancel_membership_autorenew(
  _client_membership_id uuid,
  _source text default 'mobile'
) returns public.client_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.client_memberships;
begin
  update public.client_memberships
     set auto_renew = false,
         auto_renew_cancelled_at = coalesce(auto_renew_cancelled_at, now())
   where id = _client_membership_id
   returning * into row;
  return row;
end
$$;

-- 4) RPC: полностью отменить абонемент (status = 'cancelled') ---------------
create or replace function public.cancel_membership(
  _client_membership_id uuid,
  _reason text default null,
  _source text default 'mobile'
) returns public.client_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.client_memberships;
begin
  update public.client_memberships
     set status = 'cancelled',
         auto_renew = false,
         cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(_reason, cancel_reason),
         cancel_source = coalesce(_source, 'mobile')
   where id = _client_membership_id and status = 'active'
   returning * into row;
  return row;
end
$$;

grant execute on function public.cancel_membership_autorenew(uuid, text) to authenticated;
grant execute on function public.cancel_membership(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
