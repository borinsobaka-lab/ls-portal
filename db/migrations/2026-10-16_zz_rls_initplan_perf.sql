-- Скорость RLS под нагрузкой (нагрузочный прогон 2026-10-16, ~2000 клиентов,
-- 37 тыс. записей): политики горячих таблиц звали SECURITY DEFINER-хелперы
-- построчно — is_trainer(auth.uid(), studio_id), current_studio_id(auth.uid()),
-- client_can_browse_studio(studio_id), is_staff/has_admin_section(auth.uid()).
-- Такие функции не инлайнятся, каждый вызов — отдельный запрос (~5–10 мкс), а
-- политики вложенных таблиц (schedule_entry_trainers → schedule_entries,
-- trainers → trainer_studios) умножают их: расписание недели — ~2300 вызовов,
-- 28 мс; «Мои абонементы» — подзапрос по clients с auth.uid() не может идти по
-- индексу под RLS clients и перебирает всех клиентов (2 × is_trainer на строку),
-- 25 мс и растёт с числом клиентов.
--
-- Здесь — те же правила доступа, но то, что не зависит от строки, считается
-- один раз на запрос (InitPlan): списки студий вызывающего — массивами,
-- auth.uid()/current_studio_id/is_staff/has_admin_section — в (select …).
--   is_trainer(auth.uid(), X)        ⇔  X = any((select auth_staff_studio_ids())::uuid[])
--   client_can_browse_studio(X)      ⇔  X = any((select auth_browse_studio_ids())::uuid[])
--   can_manage_catalog(auth.uid(), X) ⇔ X = any((select auth_catalog_studio_ids())::uuid[])
-- is_trainer, client_can_browse_studio, can_manage_catalog не меняются (их зовут
-- RPC и другие политики); current_studio_id — то же тело, но на plpgsql (п. 1).
--
-- Замер: смешанная нагрузка пакетного приложения (35 видов запросов, 10
-- соединений, как пул PostgREST) — 734 → 2899 запросов/с; расписание недели
-- 27,6 → 4,3 мс, «Мои абонементы» 25,5 → 0,27 мс. Доступ проверен построчно:
-- 13 таблиц × 13 видов вызывающих + 9 проб записи — видимые строки и итоги
-- записи до и после совпали (286 проверок).
--
-- Новая политика на эти таблицы — в том же виде: (select auth.uid()),
-- списки студий вызывающего массивом, а не хелпер на каждую строку.
--
-- Ожидаемый набор политик — как в тестовой схеме (db/test/build-schema.sh):
-- security_hardening.sql выполнен (clients/client_memberships «self or
-- trainer select»). Политики пересоздаются по именам; лишних не удаляет.

-- 1. Хелперы: всё про вызывающего — одним запросом ------------------------------

-- plpgsql, а не sql: план тела кэшируется в сеансе (SECURITY DEFINER sql-функция
-- не инлайнится и планируется заново в каждом запросе, ~0,1 мс на вызов).
create or replace function public.auth_staff_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- = is_trainer(auth.uid(), X) для каждого X из результата
  return (select coalesce(array_agg(distinct ur.studio_id), '{}'::uuid[])
            from public.user_roles ur
           where ur.user_id = auth.uid()
             and ur.role in ('owner', 'admin', 'trainer'));
end;
$$;

create or replace function public.auth_browse_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- = client_can_browse_studio(X)
  return (select coalesce(array_agg(s.id), '{}'::uuid[])
            from public.studios s
            join public.studios mine on mine.id = public.current_studio_id(auth.uid())
           where s.format = mine.format);
end;
$$;

create or replace function public.auth_catalog_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- = can_manage_catalog(auth.uid(), X): студии, где вызывающий сотрудник, и
  -- все пакетные, если он сотрудник хоть одной пакетной (общий каталог).
  return (select coalesce(array_agg(s.id), '{}'::uuid[])
            from public.studios s
           where exists (select 1 from public.user_roles ur
                          where ur.user_id = auth.uid() and ur.studio_id = s.id
                            and ur.role in ('owner', 'admin', 'trainer'))
              or (s.format = 'packages' and exists (
                    select 1 from public.studios other
                      join public.user_roles ur
                        on ur.studio_id = other.id and ur.user_id = auth.uid()
                       and ur.role in ('owner', 'admin', 'trainer')
                     where other.format = 'packages')));
end;
$$;

-- current_studio_id — то же тело (2026-10-12_zzz_staff_client_separation.sql),
-- но plpgsql: её зовут InitPlan'ы почти всех политик клиента (до 10 раз на
-- запрос расписания), а sql-версия с SECURITY DEFINER планируется на каждый вызов.
create or replace function public.current_studio_id(_user_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce(
    (select c.studio_id from public.clients c
      where c.user_id = _user_id
      order by c.created_at desc, c.id
      limit 1),
    (select p.studio_id from public.profiles p where p.id = _user_id)
  );
end;
$$;

revoke all on function public.auth_staff_studio_ids() from public;
revoke all on function public.auth_browse_studio_ids() from public;
revoke all on function public.auth_catalog_studio_ids() from public;
grant execute on function public.auth_staff_studio_ids() to authenticated, service_role;
grant execute on function public.auth_browse_studio_ids() to authenticated, service_role;
grant execute on function public.auth_catalog_studio_ids() to authenticated, service_role;

-- 2. Расписание ---------------------------------------------------------------

drop policy if exists "schedule client browse" on public.schedule_entries;
create policy "schedule client browse" on public.schedule_entries
  for select to authenticated
  using (kind = 'group' and cancelled_at is null
         and studio_id = any ((select public.auth_browse_studio_ids())::uuid[]));

drop policy if exists "schedule studio select" on public.schedule_entries;
create policy "schedule studio select" on public.schedule_entries
  for select to authenticated
  using (studio_id = (select public.current_studio_id(auth.uid()))
         and ((kind = 'group' and cancelled_at is null)
              or studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

drop policy if exists "schedule trainer write" on public.schedule_entries;
create policy "schedule trainer write" on public.schedule_entries
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "set client browse" on public.schedule_entry_trainers;
create policy "set client browse" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_trainers.entry_id
       and e.kind = 'group' and e.cancelled_at is null
       and e.studio_id = any ((select public.auth_browse_studio_ids())::uuid[])));

drop policy if exists "set studio select" on public.schedule_entry_trainers;
create policy "set studio select" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_trainers.entry_id
       and e.studio_id = (select public.current_studio_id(auth.uid()))
       and ((e.kind = 'group' and e.cancelled_at is null)
            or e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))));

drop policy if exists "set trainer write" on public.schedule_entry_trainers;
create policy "set trainer write" on public.schedule_entry_trainers
  for all to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_trainers.entry_id
       and e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])))
  with check (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_trainers.entry_id
       and e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

drop policy if exists "subs client browse" on public.schedule_entry_substitutions;
create policy "subs client browse" on public.schedule_entry_substitutions
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_substitutions.entry_id
       and e.kind = 'group' and e.cancelled_at is null
       and e.studio_id = any ((select public.auth_browse_studio_ids())::uuid[])));

drop policy if exists "subs studio select" on public.schedule_entry_substitutions;
create policy "subs studio select" on public.schedule_entry_substitutions
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_substitutions.entry_id
       and e.studio_id = (select public.current_studio_id(auth.uid()))
       and ((e.kind = 'group' and e.cancelled_at is null)
            or e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))));

drop policy if exists "subs trainer write" on public.schedule_entry_substitutions;
create policy "subs trainer write" on public.schedule_entry_substitutions
  for all to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_substitutions.entry_id
       and e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])))
  with check (exists (
    select 1 from public.schedule_entries e
     where e.id = schedule_entry_substitutions.entry_id
       and e.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

-- 3. Сотрудники в приложении ------------------------------------------------------

drop policy if exists "trainers client browse" on public.trainers;
create policy "trainers client browse" on public.trainers
  for select to authenticated
  using (exists (
    select 1 from public.trainer_studios ts
     where ts.trainer_id = trainers.id
       and ts.studio_id = any ((select public.auth_browse_studio_ids())::uuid[])));

drop policy if exists "trainers select" on public.trainers;
create policy "trainers select" on public.trainers
  for select to authenticated
  using ((select public.is_staff(auth.uid()))
         or exists (
           select 1 from public.trainer_studios ts
            where ts.trainer_id = trainers.id
              and ts.studio_id = (select public.current_studio_id(auth.uid()))));

drop policy if exists "trainers staff write" on public.trainers;
create policy "trainers staff write" on public.trainers
  for all to authenticated
  using ((select public.has_admin_section(auth.uid(), 'staff')))
  with check ((select public.has_admin_section(auth.uid(), 'staff')));

drop policy if exists "trainer_studios client browse" on public.trainer_studios;
create policy "trainer_studios client browse" on public.trainer_studios
  for select to authenticated
  using (studio_id = any ((select public.auth_browse_studio_ids())::uuid[]));

drop policy if exists "trainer_studios select" on public.trainer_studios;
create policy "trainer_studios select" on public.trainer_studios
  for select to authenticated
  using ((select public.is_staff(auth.uid()))
         or studio_id = (select public.current_studio_id(auth.uid())));

drop policy if exists "trainer_studios staff write" on public.trainer_studios;
create policy "trainer_studios staff write" on public.trainer_studios
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         and (select public.has_admin_section(auth.uid(), 'staff')))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              and (select public.has_admin_section(auth.uid(), 'staff')));

-- 4. Клиенты, абонементы, записи, журнал --------------------------------------------

drop policy if exists "clients self or trainer select" on public.clients;
create policy "clients self or trainer select" on public.clients
  for select to authenticated
  using (user_id = (select auth.uid())
         or studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "clients trainer write" on public.clients;
create policy "clients trainer write" on public.clients
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "client_memberships self or trainer select" on public.client_memberships;
create policy "client_memberships self or trainer select" on public.client_memberships
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or client_id in (select c.id from public.clients c where c.user_id = (select auth.uid())));

drop policy if exists "client_memberships trainer write" on public.client_memberships;
create policy "client_memberships trainer write" on public.client_memberships
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "schedule_bookings self or trainer select" on public.schedule_bookings;
create policy "schedule_bookings self or trainer select" on public.schedule_bookings
  for select to authenticated
  using (user_id = (select auth.uid())
         or studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "schedule_bookings trainer write" on public.schedule_bookings;
create policy "schedule_bookings trainer write" on public.schedule_bookings
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "bookings_log self read" on public.bookings_log;
create policy "bookings_log self read" on public.bookings_log
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "bookings_log trainer read" on public.bookings_log;
create policy "bookings_log trainer read" on public.bookings_log
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "bookings_log home studio read" on public.bookings_log;
create policy "bookings_log home studio read" on public.bookings_log
  for select to authenticated
  using (client_id is not null and exists (
    select 1 from public.clients c
     where c.id = bookings_log.client_id
       and c.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

-- 5. Каталог (витрина клиента) ----------------------------------------------------

drop policy if exists "workouts client browse" on public.workouts;
create policy "workouts client browse" on public.workouts
  for select to authenticated
  using (studio_id = any ((select public.auth_browse_studio_ids())::uuid[]));

drop policy if exists "workouts studio select" on public.workouts;
create policy "workouts studio select" on public.workouts
  for select to authenticated
  using (studio_id = (select public.current_studio_id(auth.uid())));

drop policy if exists "memberships client browse" on public.memberships;
create policy "memberships client browse" on public.memberships
  for select to authenticated
  using (is_active and studio_id = any ((select public.auth_browse_studio_ids())::uuid[]));

drop policy if exists "memberships studio select" on public.memberships;
create policy "memberships studio select" on public.memberships
  for select to authenticated
  using (studio_id = (select public.current_studio_id(auth.uid())));

drop policy if exists "workouts trainer write" on public.workouts;
create policy "workouts trainer write" on public.workouts
  for all to authenticated
  using (studio_id = any ((select public.auth_catalog_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_catalog_studio_ids())::uuid[]));

drop policy if exists "memberships trainer write" on public.memberships;
create policy "memberships trainer write" on public.memberships
  for all to authenticated
  using (studio_id = any ((select public.auth_catalog_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_catalog_studio_ids())::uuid[]));

-- 6. Продажи и график платежей (сотрудник) -----------------------------------------

drop policy if exists "sales studio rw" on public.sales;
create policy "sales studio rw" on public.sales
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "sale_installments via sale" on public.sale_installments;
create policy "sale_installments via sale" on public.sale_installments
  for all to authenticated
  using (exists (
    select 1 from public.sales s
     where s.id = sale_installments.sale_id
       and s.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])))
  with check (exists (
    select 1 from public.sales s
     where s.id = sale_installments.sale_id
       and s.studio_id = any ((select public.auth_staff_studio_ids())::uuid[])));

-- 7. NPS: «первые занятия» в общем плане шли по всему расписанию ----------------
-- (plpgsql после 5 вызовов переходит на общий план: обход schedule_entries по
-- starts_at целиком, 10–20 мс и растёт с историей; с параметрами — 0,1 мс).
-- create or replace этой функции сбрасывает настройку — новое определение
-- nps_pending_survey пишется сразу с «set plan_cache_mode = force_custom_plan».
alter function public.nps_pending_survey(uuid) set plan_cache_mode = force_custom_plan;

-- 8. Индексы ----------------------------------------------------------------------

-- handle_new_user, ensure_client_profile, client_app_sign_in_allowed ищут
-- свободную карточку по lower(trim(email)) — без индекса перебор всех клиентов
-- на каждый вход/запрос кода.
create index if not exists clients_email_unlinked_idx
  on public.clients (lower(trim(email)))
  where user_id is null and email is not null;

-- my_studio_visit_stats (статистика на главной пакетного приложения) считает
-- посещения всей студии за всё время: index-only scan вместо чтения журнала.
create index if not exists bookings_log_studio_attended_idx
  on public.bookings_log (studio_id, starts_at)
  include (client_id, user_id, entry_id)
  where status = 'attended';
