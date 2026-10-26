-- ============================================================================
-- Заморозка абонементов. Идемпотентно.
-- Тариф задаёт лимит дней заморозки; сотрудник замораживает активный абонемент,
-- срок действия (ends_at) продлевается на срок заморозки. Клиенту заморозку
-- показываем в преимуществах тарифа (freeze_days_allowed), а в админке — статус.
-- Запускать после db/memberships.sql, db/client_memberships.sql, security_hardening.
-- ============================================================================

-- 1) Лимит заморозки в тарифе ------------------------------------------------
alter table public.memberships
  add column if not exists freeze_days_allowed int not null default 0
    check (freeze_days_allowed >= 0);

-- 2) Статус 'frozen' + учёт использованных дней на абонементе клиента --------
alter table public.client_memberships
  drop constraint if exists client_memberships_status_check;
alter table public.client_memberships
  add constraint client_memberships_status_check
  check (status in ('active','frozen','replaced','expired','cancelled'));

alter table public.client_memberships
  add column if not exists freeze_days_used int not null default 0 check (freeze_days_used >= 0),
  add column if not exists frozen_at    date,
  add column if not exists frozen_until date;

-- Один «живой» абонемент на клиента = активный ИЛИ замороженный
drop index if exists public.client_memberships_one_active;
create unique index if not exists client_memberships_one_live
  on public.client_memberships(client_id) where status in ('active','frozen');

-- 3) Журнал заморозок --------------------------------------------------------
create table if not exists public.membership_freezes (
  id uuid primary key default gen_random_uuid(),
  client_membership_id uuid not null references public.client_memberships(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  started_at date not null default current_date,
  ends_at date not null,
  days int not null check (days > 0),
  reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists membership_freezes_cm_idx on public.membership_freezes(client_membership_id);

grant select, insert, update, delete on public.membership_freezes to authenticated;
grant all on public.membership_freezes to service_role;
alter table public.membership_freezes enable row level security;

drop policy if exists "membership_freezes studio rw" on public.membership_freezes;
create policy "membership_freezes studio rw" on public.membership_freezes
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- 4) RPC заморозки: проверяет квоту тарифа, продлевает ends_at ----------------
create or replace function public.freeze_membership(
  _client_membership_id uuid,
  _days int,
  _reason text default null
) returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare
  cm public.client_memberships;
  allowed int;
begin
  select * into cm from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not public.is_trainer(auth.uid(), cm.studio_id) then raise exception 'forbidden'; end if;
  if cm.status <> 'active' then raise exception 'membership not active'; end if;
  if _days is null or _days <= 0 then raise exception 'invalid days'; end if;

  select coalesce(freeze_days_allowed, 0) into allowed
    from public.memberships where id = cm.membership_id;
  if cm.freeze_days_used + _days > allowed then
    raise exception 'freeze quota exceeded (allowed %, used %, requested %)',
      allowed, cm.freeze_days_used, _days;
  end if;

  insert into public.membership_freezes(
    client_membership_id, studio_id, started_at, ends_at, days, reason, created_by)
  values (cm.id, cm.studio_id, current_date, current_date + _days, _days, _reason, auth.uid());

  update public.client_memberships
     set status = 'frozen',
         freeze_days_used = freeze_days_used + _days,
         frozen_at = current_date,
         frozen_until = current_date + _days,
         ends_at = case when ends_at is null then null else ends_at + _days end
   where id = cm.id
   returning * into cm;
  return cm;
end $$;

-- 5) RPC разморозки (досрочная): возвращает active. Продление ends_at остаётся
--    (клиент сохраняет уже начисленные дни) — упрощение v1.
create or replace function public.unfreeze_membership(_client_membership_id uuid)
returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare cm public.client_memberships;
begin
  select * into cm from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not public.is_trainer(auth.uid(), cm.studio_id) then raise exception 'forbidden'; end if;
  if cm.status <> 'frozen' then raise exception 'membership not frozen'; end if;

  update public.client_memberships
     set status = 'active', frozen_at = null, frozen_until = null
   where id = cm.id
   returning * into cm;
  return cm;
end $$;

revoke all on function public.freeze_membership(uuid, int, text) from public;
grant execute on function public.freeze_membership(uuid, int, text) to authenticated;
revoke all on function public.unfreeze_membership(uuid) from public;
grant execute on function public.unfreeze_membership(uuid) to authenticated;

-- 6) Новая продажа вытесняет ЛЮБОЙ живой абонемент (active ИЛИ frozen) --------
--    Иначе покупка при заморозке нарушит индекс client_memberships_one_live.
--    Переопределяем последнюю версию триггерной функции (с auto_renew),
--    меняя только область замены. Запускать после db/client_memberships_cancel.sql.
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
   where client_id = new.client_id and status in ('active','frozen');

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

notify pgrst, 'reload schema';
