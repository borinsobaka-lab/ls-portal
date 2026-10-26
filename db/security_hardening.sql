-- ============================================================================
-- Security hardening (аудит 2026-08-07). Идемпотентно, безопасно перезапускать.
-- Запускать в Supabase SQL Editor. Ужесточает RLS клиентских таблиц и закрывает
-- IDOR в RPC отмены абонемента — критично перед массовой раздачей клиентского
-- приложения (любой зарегистрировавшийся пользователь получает роль 'member').
--
-- Что чинит:
--   1. clients            — member мог читать ВСЮ клиентскую базу студии (PII);
--                           теперь только свою строку или сотрудник.
--   2. client_memberships — member мог читать ВСЕ абонементы студии; теперь
--                           только свои или сотрудник.
--   3. cancel_membership / cancel_membership_autorenew — IDOR: любой клиент мог
--                           отменить ЧУЖОЙ абонемент по его id; теперь только
--                           владелец абонемента или сотрудник.
--   4. feedback / nps_responses — любой авторизованный мог читать/править/удалять
--                           все отзывы и NPS; теперь чтение/правка/удаление —
--                           только сотрудник, вставка (отправка) — любой вошедший.
--   5. mark_no_show_bookings / mark_completed_bookings — любой клиент мог запустить
--                           студийную пакетную простановку статусов; теперь только
--                           сотрудник (или service_role/крон).
-- ============================================================================

-- 0) Хелпер: сотрудник ли пользователь (owner/admin/trainer в любой студии).
--    Для «пулов без студии» (feedback, nps) — где привязка к studio_id не годится.
create or replace function public.is_staff(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role in ('owner','admin','trainer')
  )
$$;

-- ---------------------------------------------------------------------------
-- 1) clients: своя строка или сотрудник студии (было: вся студия).
--    Клиентское приложение читает clients только через .eq('user_id', uid) —
--    не ломается. Админка читает как сотрудник (is_trainer) — не ломается.
-- ---------------------------------------------------------------------------
drop policy if exists "clients studio select" on public.clients;
drop policy if exists "clients self or trainer select" on public.clients;
create policy "clients self or trainer select" on public.clients
  for select to authenticated
  using (user_id = auth.uid() or public.is_trainer(auth.uid(), studio_id));

-- ---------------------------------------------------------------------------
-- 2) client_memberships: свои абонементы или сотрудник (было: вся студия).
-- ---------------------------------------------------------------------------
drop policy if exists "client_memberships studio select" on public.client_memberships;
drop policy if exists "client_memberships self or trainer select" on public.client_memberships;
create policy "client_memberships self or trainer select" on public.client_memberships
  for select to authenticated
  using (
    public.is_trainer(auth.uid(), studio_id)
    or client_id in (select id from public.clients where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3) RPC отмены: авторизуем вызывающего (владелец абонемента ИЛИ сотрудник).
--    Сигнатуры сохранены (клиент вызывает именованными аргументами).
-- ---------------------------------------------------------------------------

-- helper-предикат владения выражаем инлайном в каждой функции.

create or replace function public.cancel_membership_autorenew(
  _client_membership_id uuid,
  _source text default 'mobile',
  _reason text default 'self'
) returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare row public.client_memberships;
begin
  if _reason is not null and _reason not in ('self','auto') then
    raise exception 'invalid reason: %', _reason;
  end if;
  select * into row from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not (
    public.is_trainer(auth.uid(), row.studio_id)
    or exists (select 1 from public.clients c
               where c.id = row.client_id and c.user_id = auth.uid())
  ) then raise exception 'forbidden'; end if;

  update public.client_memberships
     set auto_renew = false,
         auto_renew_cancelled_at = coalesce(auto_renew_cancelled_at, now()),
         auto_renew_cancel_reason = coalesce(auto_renew_cancel_reason, _reason)
   where id = _client_membership_id
   returning * into row;
  return row;
end $$;

-- Старая 2-аргументная перегрузка (ещё существует и выдана authenticated).
create or replace function public.cancel_membership_autorenew(
  _client_membership_id uuid,
  _source text default 'mobile'
) returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare row public.client_memberships;
begin
  select * into row from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not (
    public.is_trainer(auth.uid(), row.studio_id)
    or exists (select 1 from public.clients c
               where c.id = row.client_id and c.user_id = auth.uid())
  ) then raise exception 'forbidden'; end if;

  update public.client_memberships
     set auto_renew = false,
         auto_renew_cancelled_at = coalesce(auto_renew_cancelled_at, now())
   where id = _client_membership_id
   returning * into row;
  return row;
end $$;

create or replace function public.cancel_membership(
  _client_membership_id uuid,
  _reason text default null,
  _source text default 'mobile'
) returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare row public.client_memberships;
begin
  select * into row from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not (
    public.is_trainer(auth.uid(), row.studio_id)
    or exists (select 1 from public.clients c
               where c.id = row.client_id and c.user_id = auth.uid())
  ) then raise exception 'forbidden'; end if;

  update public.client_memberships
     set status = 'cancelled',
         auto_renew = false,
         cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(_reason, cancel_reason),
         cancel_source = coalesce(_source, 'mobile')
   where id = _client_membership_id and status = 'active'
   returning * into row;
  return row;
end $$;

grant execute on function public.cancel_membership_autorenew(uuid, text) to authenticated;
grant execute on function public.cancel_membership_autorenew(uuid, text, text) to authenticated;
grant execute on function public.cancel_membership(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) feedback / nps_responses: пул без привязки к студии.
--    Чтение/правка/удаление — только сотрудник; вставка — любой вошедший
--    (отправка отзыва/оценки из приложения). Было: using(true) на всё.
-- ---------------------------------------------------------------------------
drop policy if exists "feedback read all auth"  on public.feedback;
drop policy if exists "feedback write all auth" on public.feedback;
drop policy if exists "feedback staff select"   on public.feedback;
drop policy if exists "feedback auth insert"    on public.feedback;
drop policy if exists "feedback staff update"   on public.feedback;
drop policy if exists "feedback staff delete"   on public.feedback;
create policy "feedback staff select" on public.feedback
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "feedback auth insert" on public.feedback
  for insert to authenticated with check (true);
create policy "feedback staff update" on public.feedback
  for update to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy "feedback staff delete" on public.feedback
  for delete to authenticated using (public.is_staff(auth.uid()));

drop policy if exists "nps read all auth"  on public.nps_responses;
drop policy if exists "nps write all auth" on public.nps_responses;
drop policy if exists "nps staff select"   on public.nps_responses;
drop policy if exists "nps auth insert"    on public.nps_responses;
drop policy if exists "nps staff update"   on public.nps_responses;
drop policy if exists "nps staff delete"   on public.nps_responses;
create policy "nps staff select" on public.nps_responses
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "nps auth insert" on public.nps_responses
  for insert to authenticated with check (true);
create policy "nps staff update" on public.nps_responses
  for update to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy "nps staff delete" on public.nps_responses
  for delete to authenticated using (public.is_staff(auth.uid()));

-- ---------------------------------------------------------------------------
-- 5) Пакетные простановки статусов.
--    mark_no_show_bookings вызывает админка вручную — оставляем authenticated,
--    но добавляем staff-guard (service_role/крон проходит: auth.uid() = null).
--    mark_completed_bookings из приложений не вызывается — отзываем у клиентов.
-- ---------------------------------------------------------------------------
create or replace function public.mark_no_show_bookings()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_staff(auth.uid()) then
    raise exception 'forbidden: staff only';
  end if;

  update public.schedule_bookings sb
     set status = 'no_show'
    from public.schedule_entries se
   where se.id = sb.entry_id
     and sb.status = 'booked'
     and se.ends_at < now();

  update public.bookings_log
     set status = 'no_show', completed_at = now(), updated_at = now()
   where status = 'booked' and ends_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.mark_no_show_bookings() from public;
grant execute on function public.mark_no_show_bookings() to authenticated, service_role;

-- Тело mark_completed_bookings не трогаем (легаси/крон), только сужаем доступ.
revoke execute on function public.mark_completed_bookings() from public, authenticated;
grant execute on function public.mark_completed_bookings() to service_role;

notify pgrst, 'reload schema';
