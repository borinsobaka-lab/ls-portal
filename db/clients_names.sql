-- Split client name into first_name / last_name.
-- Keeps full_name in sync for backward compatibility (mobile app fallback,
-- existing reports, search by ФИО).

alter table public.clients
  add column if not exists first_name text,
  add column if not exists last_name  text;

-- Backfill first_name / last_name from existing full_name (best-effort split:
-- everything before the first space → first_name, the rest → last_name).
update public.clients
   set first_name = coalesce(first_name, nullif(split_part(full_name, ' ', 1), '')),
       last_name  = coalesce(
                      last_name,
                      nullif(trim(substring(full_name from position(' ' in full_name) + 1)), '')
                    )
 where full_name is not null
   and (first_name is null or last_name is null);

-- Trigger: whenever first_name / last_name change, rebuild full_name.
-- If caller still passes full_name directly (legacy code), we honor it.
create or replace function public.clients_sync_full_name()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    if new.full_name is null or btrim(new.full_name) = '' then
      new.full_name := btrim(concat_ws(' ', new.first_name, new.last_name));
    end if;
  elsif (tg_op = 'UPDATE') then
    if new.first_name is distinct from old.first_name
       or new.last_name is distinct from old.last_name then
      new.full_name := btrim(concat_ws(' ', new.first_name, new.last_name));
    end if;
  end if;
  if new.full_name is null or btrim(new.full_name) = '' then
    new.full_name := '—';
  end if;
  return new;
end $$;

drop trigger if exists clients_sync_full_name on public.clients;
create trigger clients_sync_full_name
  before insert or update on public.clients
  for each row execute function public.clients_sync_full_name();
