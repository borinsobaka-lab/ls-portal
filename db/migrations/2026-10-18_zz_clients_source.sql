-- ============================================================================
-- Как карточка клиента попала в базу — столбец «Добавлен» в «Клиентах»
-- (решение владельца 2026-10-18).
--
--   * clients.source: admin — «Сотрудником» (админка, по умолчанию), import —
--     «Импорт» (перенос из 1С, 2026-10-18_import_1c.sql), mobile —
--     «Приложение» (зарезервировано под регистрацию в приложении, её пока
--     нет). Значения — как у sales.source / client_memberships.source.
--   * Перенесённые из 1С (onec_ref не пуст) — import, и уже залитые, и
--     залитые после этой миграции (триггер clients_source_guard_biu).
--   * Из админки и приложения (роли authenticated / anon) source и onec_ref не
--     подделать: новая карточка — admin без onec_ref, правка их не меняет.
--     Функции владельца базы (перенос из 1С, будущая регистрация) и сервер
--     пишут как есть.
--   * clients_with_status пересоздана: c.* раскрывается при создании вью, без
--     этого в ней не было бы ни source, ни onec_ref. Определение — как в
--     2026-10-14_club_status_no_trial.sql.
--
-- Порядок: после 2026-10-18_import_1c.sql (onec_ref). Идемпотентно.
-- ============================================================================

alter table public.clients add column if not exists source text not null default 'admin';

alter table public.clients drop constraint if exists clients_source_check;
alter table public.clients add constraint clients_source_check
  check (source in ('admin', 'import', 'mobile'));

update public.clients set source = 'import'
 where onec_ref is not null and source <> 'import';

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
    else
      new.source := old.source;
      new.onec_ref := old.onec_ref;
    end if;
  end if;
  if new.onec_ref is not null then
    new.source := 'import';
  end if;
  return new;
end;
$$;

drop trigger if exists clients_source_guard_biu on public.clients;
create trigger clients_source_guard_biu
  before insert or update on public.clients
  for each row execute function public.clients_source_guard();

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
  end as club_status
from public.clients c
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

notify pgrst, 'reload schema';
