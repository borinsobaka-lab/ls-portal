-- ============================================================================
-- Вход в портал по логину и паролю из Platrum (решение владельца 2026-11-01).
--
-- Сотрудники заказчика входили в прежнюю базу знаний (Platrum) по логину и
-- паролю — те же реквизиты должны работать и в портале. У человека портала
-- теперь два способа входа, можно оба: почта (6-значный код из письма, как
-- раньше) и логин + пароль Platrum. Экран входа — переключатель, по
-- умолчанию «Логин и пароль».
--
-- Пароль — не в GoTrue (его пароли сотрудников стирает
-- 2026-10-10_staff_accounts.sql, и GoTrue входит только по почте или
-- телефону), а здесь: хэш scrypt считает сервер портала
-- (apps/admin/src/lib/password.server.ts). Сервер проверяет пару и выдаёт
-- сессию GoTrue той же учётной записи (apps/admin/src/lib/auth.functions.ts).
-- Человеку без почты учётная запись — со служебным адресом
-- (nomail-…@no-email.invalid), как и раньше.
--
-- Таблица закрыта браузеру (и хэш, и счётчики): пишет и читает сервер
-- сервис-ключом после проверки прав (access_can_manage). Браузеру — только
-- portal_login_info (логин без пароля: себе и тому, кто управляет человеком).
-- После 10 неверных паролей подряд логин закрыт на 15 минут
-- (portal_login_failed, только service_role). Идемпотентно.
-- ============================================================================

create table if not exists public.portal_logins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  login text not null,
  password_hash text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_set_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint portal_logins_login_check check (
    char_length(login) between 1 and 100 and login !~ '\s'
  ),
  constraint portal_logins_hash_check check (password_hash like 'scrypt$%')
);

-- Логин без регистра: «Ivanov» и «ivanov» — один логин.
create unique index if not exists portal_logins_login_key
  on public.portal_logins (lower(login));

alter table public.portal_logins enable row level security;
revoke all on public.portal_logins from anon, authenticated;
grant select, insert, update, delete on public.portal_logins to service_role;

-- Логин человека для карточки «Пользователей»: сам человек или тот, кто им
-- управляет. Пароль (и хэш) не отдаётся никому.
create or replace function public.portal_login_info(p_user uuid)
returns table (login text, last_login_at timestamptz, password_set_at timestamptz, locked_until timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or (p_user <> auth.uid() and not public.access_can_manage(p_user)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select l.login, l.last_login_at, l.password_set_at,
           case when l.locked_until > now() then l.locked_until end
      from public.portal_logins l
     where l.user_id = p_user;
end;
$$;

-- Неверный пароль: счётчик подряд, на 10-м — закрыть логин на 15 минут
-- (счётчик с начала). Возвращает, до какого времени закрыт (null — открыт).
create or replace function public.portal_login_failed(p_user uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked timestamptz;
begin
  update public.portal_logins
     set failed_count = case when failed_count + 1 >= 10 then 0 else failed_count + 1 end,
         locked_until = case when failed_count + 1 >= 10 then now() + interval '15 minutes'
                             else locked_until end
   where user_id = p_user
  returning case when locked_until > now() then locked_until end into v_locked;
  return v_locked;
end;
$$;

revoke all on function public.portal_login_info(uuid) from public, anon;
grant execute on function public.portal_login_info(uuid) to authenticated, service_role;
revoke all on function public.portal_login_failed(uuid) from public, anon, authenticated;
grant execute on function public.portal_login_failed(uuid) to service_role;
