-- Отмены автопродления абонементов.
-- Запускать ПОСЛЕ db/client_memberships_cancel.sql. Идемпотентно.

-- 1) Колонка с причиной отмены автопродления: 'self' (пользователь сам в МП)
--    или 'auto' (списание не прошло; будет проставляться платёжной системой).
alter table public.client_memberships
  add column if not exists auto_renew_cancel_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_memberships_autorenew_reason_check'
      and conrelid = 'public.client_memberships'::regclass
  ) then
    alter table public.client_memberships
      add constraint client_memberships_autorenew_reason_check
      check (auto_renew_cancel_reason is null
             or auto_renew_cancel_reason in ('self','auto'));
  end if;
end$$;

-- 2) RPC: пользователь отключает автопродление из мобильного приложения.
--    Обновлённая версия принимает причину (по умолчанию 'self').
create or replace function public.cancel_membership_autorenew(
  _client_membership_id uuid,
  _source text default 'mobile',
  _reason text default 'self'
) returns public.client_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.client_memberships;
begin
  if _reason is not null and _reason not in ('self','auto') then
    raise exception 'invalid reason: %', _reason;
  end if;

  update public.client_memberships
     set auto_renew = false,
         auto_renew_cancelled_at = coalesce(auto_renew_cancelled_at, now()),
         auto_renew_cancel_reason = coalesce(auto_renew_cancel_reason, _reason)
   where id = _client_membership_id
   returning * into row;
  return row;
end
$$;

grant execute on function public.cancel_membership_autorenew(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
