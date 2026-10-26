-- ============================================================================
-- Фильтры «Клиентов»: цель клиента и последний раз в приложении (решение
-- владельца 2026-10-18; фильтр «Пол» убран)
-- ============================================================================
-- 1. clients.app_last_seen_at — когда клиент последний раз был в приложении
--    формата клуба карточки (человек может быть клиентом клубов обоих
--    форматов — у каждого своё приложение, как в client_app_overview).
--    Источник — app_devices.last_seen_at (пишет app_ping); сами устройства
--    закрыты всем, кроме сервера, поэтому для фильтра таблицы время
--    переносится в карточку триггером app_devices_client_seen_aiu. Пинг идёт
--    раз в 5 минут, пока приложение открыто, — карточку триггер обновляет не
--    чаще раза в 15 минут и всегда при смене дня (по Тбилиси): фильтр —
--    по датам. Из админки и приложения колонку не подделать
--    (clients_source_guard, как source и onec_ref). Заполнена по уже
--    известным устройствам.
-- 2. clients_with_status пересоздана: c.* раскрывается при создании вью, плюс
--    primary_goal — цель из анкеты приложения (member_profiles, «Цели и
--    мотивация» карточки; ключи fitness_goal, подписи — lib/client-profile.ts
--    админки). Остальное — как в 2026-10-18_zz_clients_source.sql.
-- 3. Политики member_profiles для сотрудника и самого клиента — в виде
--    2026-10-16_zz_rls_initplan_perf.sql: вью теперь соединяется с анкетами
--    на каждой странице «Клиентов», а прежняя staff_read_profiles звала
--    is_trainer на каждую анкету.
--
-- Порядок: после 2026-10-18_zz_clients_source.sql (clients_source_guard) и
-- 2026-10-15_zzzzz_client_app_activity.sql (app_devices). Идемпотентно.
-- ============================================================================

alter table public.clients add column if not exists app_last_seen_at timestamptz;

comment on column public.clients.app_last_seen_at is
  'Последний раз в приложении формата клуба карточки (из app_devices, триггер app_devices_client_seen_aiu; точность — 15 минут).';

-- Тело — как в 2026-10-18_zz_clients_source.sql + app_last_seen_at.
create or replace function public.clients_source_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Запросы админки и приложения идут от ролей authenticated / anon; функции
  -- с security definer и сервер — от своих ролей.
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.source := 'admin';
      new.onec_ref := null;
      new.app_last_seen_at := null;
    else
      new.source := old.source;
      new.onec_ref := old.onec_ref;
      new.app_last_seen_at := old.app_last_seen_at;
    end if;
  end if;
  if new.onec_ref is not null then
    new.source := 'import';
  end if;
  return new;
end;
$$;

create or replace function public.app_devices_client_seen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.clients c
     set app_last_seen_at = new.last_seen_at
    from public.studios s
   where c.user_id = new.user_id
     and s.id = c.studio_id
     and coalesce(s.format, 'subscription') = new.app_format
     and (c.app_last_seen_at is null
          or (c.app_last_seen_at < new.last_seen_at
              and (c.app_last_seen_at < new.last_seen_at - interval '15 minutes'
                   or (c.app_last_seen_at at time zone 'Asia/Tbilisi')::date
                      <> (new.last_seen_at at time zone 'Asia/Tbilisi')::date)));
  return null;
end;
$$;

revoke all on function public.app_devices_client_seen() from public, anon, authenticated;

drop trigger if exists app_devices_client_seen_aiu on public.app_devices;
create trigger app_devices_client_seen_aiu
  after insert or update of last_seen_at on public.app_devices
  for each row execute function public.app_devices_client_seen();

-- Уже известные устройства.
update public.clients c
   set app_last_seen_at = d.seen
  from (select user_id, app_format, max(last_seen_at) as seen
          from public.app_devices
         group by user_id, app_format) d,
       public.studios s
 where c.user_id = d.user_id
   and s.id = c.studio_id
   and coalesce(s.format, 'subscription') = d.app_format
   and c.app_last_seen_at is distinct from d.seen;

-- 2. Вью «Клиентов» ---------------------------------------------------------------

-- c.* раскрывается при создании вью — пересоздаём целиком.
drop view if exists public.clients_with_status;
create view public.clients_with_status
with (security_invoker = true) as
select
  c.*,
  coalesce(c.last_name, '') || ' ' ||
  coalesce(c.first_name, '') || ' ' ||
  coalesce(c.full_name, '') as search_name,
  case
    when st.has_active then 'chk'
    when st.has_any then 'bchk'
    else 'pchk'
  end as club_status,
  mp.primary_goal::text as primary_goal
from public.clients c
left join public.member_profiles mp on mp.user_id = c.user_id
left join lateral (
  select
    count(*) > 0 as has_any,
    coalesce(
      bool_or(
        cm.status = 'frozen'
        or (cm.status = 'active' and (cm.ends_at is null or cm.ends_at >= current_date))
      ),
      false
    ) as has_active
  from public.client_memberships cm
  left join public.memberships m on m.id = cm.membership_id
  where cm.client_id = c.id
    and m.kind is distinct from 'trial'
) st on true;

grant select on public.clients_with_status to authenticated;

-- 3. Анкеты: политики без вызова функции на каждую строку -------------------------

drop policy if exists own_profile_select on public.member_profiles;
create policy own_profile_select on public.member_profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists staff_read_profiles on public.member_profiles;
create policy staff_read_profiles on public.member_profiles
  for select to authenticated
  using (exists (
    select 1 from public.clients c
     where c.user_id = member_profiles.user_id
       and c.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

notify pgrst, 'reload schema';
