-- ============================================================================
-- Общая база клиентов пакетных клубов (решение владельца 2026-10-17).
--
-- Все клубы формата «пакеты тренировок» — одна база клиентов: у человека одна
-- карточка clients на всю сеть, её видят и ведут сотрудники любого пакетного
-- клуба. Продажа — по-прежнему в конкретном клубе и привязана к нему:
-- sales.studio_id (и client_memberships.studio_id по ней) — клуб, где
-- продали; «Абонементы», «Продажи», касса, зарплаты и бонус продавца — по
-- клубу продажи, как раньше. Запись в любой клуб сети, списание с абонемента
-- любого клуба сети и приложение — как раньше (2026-10-14_network_guest_visits.sql).
--
-- Модель — как у общего каталога (2026-10-13_zzzz_packages_shared_catalog.sql):
-- clients.studio_id остаётся (колонка обязательна) — это клуб, где карточку
-- завели. На нём, как и прежде, держится то, что про «клуб клиента»: пуши
-- по клубам, заявки, NPS, сравнение в статистике приложения и студия
-- приложения по умолчанию. Доступ сотрудника — по сети (studios_same_network:
-- тот же клуб или оба пакетные):
--   * is_network_staff(uid, s)  — сотрудник клуба s или (s пакетный) любого
--                                 пакетного клуба;
--   * auth_network_studio_ids() — то же списком для политик (один раз на
--                                 запрос, как auth_staff_studio_ids).
-- Сотрудник любого пакетного клуба о клиенте сети:
--   * карточка — читает и правит (политики clients, clients_guard_self_update);
--   * абонементы — видит все и правит остаток, срок и заморозку (update,
--     freeze_membership / unfreeze_membership); выдать и удалить абонемент —
--     продажей, а её вносит и удаляет только клуб продажи (insert / delete
--     client_memberships — клуб абонемента);
--   * продажи и платежи других клубов — только читает (история в карточке);
--   * посещения во всех клубах (bookings_log), анкета, вес, вкладка «Приложение».
-- Подписочные клубы не затронуты: их сеть — сам клуб, проверки те же.
--
-- Одна карточка на человека: почта и учётная запись приложения у карточки
-- пакетного клуба — единственные во всех пакетных клубах
-- (clients_network_unique_guard; по почте приложение находит карточку при
-- первом входе — вторую с той же почтой оно не нашло бы никогда). Разово
-- дубли (одна учётная запись или одна почта в разных пакетных клубах —
-- оставались от модели «гостевых посещений») сливаются в одну карточку
-- (packages_merge_duplicate_clients): продажи, абонементы, записи, журнал,
-- заявки и NPS переходят на оставшуюся.
-- Удаление пакетного клуба переносит его клиентов (и их заявки) в другой
-- пакетный клуб, а не удаляет каскадом (studios_packages_catalog_rehome).
-- Гостевые RPC (entry_guest_clients, network_client_search) админка больше не
-- вызывает — карточки сети видны целиком; остаток на занятии с записями во
-- всех клубах — entry_bookings_ahead.
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Сотрудник сети ------------------------------------------------------------

-- Те же клубы, что у общего каталога (can_manage_catalog): сеть пакетных
-- клубов — все пакетные.
create or replace function public.is_network_staff(_user_id uuid, _studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_trainer(_user_id, _studio_id) or exists (
    select 1
      from public.studios s
      join public.studios other on other.format = 'packages'
      join public.user_roles ur
        on ur.studio_id = other.id
       and ur.user_id = _user_id
       and ur.role in ('owner', 'admin', 'trainer')
     where s.id = _studio_id
       and s.format = 'packages'
  )
$$;

-- plpgsql — план тела кэшируется (см. 2026-10-16_zz_rls_initplan_perf.sql).
create or replace function public.auth_network_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- = is_network_staff(auth.uid(), X): клубы, где вызывающий сотрудник, и
  -- все пакетные, если он сотрудник хоть одного пакетного.
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

revoke all on function public.is_network_staff(uuid, uuid) from public;
revoke all on function public.auth_network_studio_ids() from public;
grant execute on function public.is_network_staff(uuid, uuid) to authenticated, service_role;
grant execute on function public.auth_network_studio_ids() to authenticated, service_role;

-- 2. Карточки клиентов -----------------------------------------------------------

drop policy if exists "clients self or trainer select" on public.clients;
create policy "clients self or trainer select" on public.clients
  for select to authenticated
  using (user_id = (select auth.uid())
         or studio_id = any ((select public.auth_network_studio_ids())::uuid[]));

drop policy if exists "clients trainer write" on public.clients;
create policy "clients trainer write" on public.clients
  for all to authenticated
  using (studio_id = any ((select public.auth_network_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_network_studio_ids())::uuid[]));

-- Тело — как в 2026-10-12_zzz_staff_client_separation.sql, кроме первой
-- проверки: правит всё сотрудник сети, а не только клуба карточки (иначе
-- заметки, ссылку amoCRM и даты, сохранённые из другого клуба, триггер молча
-- возвращал бы прежними).
create or replace function public.clients_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _link boolean;
begin
  -- Сотруднику сети можно всё. auth.uid() пуст при работе сервис-ключом и
  -- внутри триггеров — там ограничивать тоже нечего.
  if auth.uid() is null or public.is_network_staff(auth.uid(), old.studio_id) then
    return new;
  end if;
  _link := old.user_id is null
       and new.user_id = auth.uid()
       and old.email is not null
       and exists (
             select 1 from auth.users u
              where u.id = auth.uid()
                and lower(trim(u.email)) = lower(trim(old.email))
           );
  -- Клиенту — только свои личные поля.
  new.id                := old.id;
  new.studio_id         := old.studio_id;
  if not _link then
    new.user_id         := old.user_id;
  end if;
  new.notes             := old.notes;
  new.crm_link          := old.crm_link;
  new.registration_date := old.registration_date;
  new.last_visit_date   := old.last_visit_date;
  return new;
end;
$$;

-- 3. Абонементы, продажи, платежи ------------------------------------------------

drop policy if exists "client_memberships self or trainer select" on public.client_memberships;
create policy "client_memberships self or trainer select" on public.client_memberships
  for select to authenticated
  using (studio_id = any ((select public.auth_network_studio_ids())::uuid[])
         or client_id in (select c.id from public.clients c where c.user_id = (select auth.uid())));

-- Выдать и удалить абонемент — только клуб абонемента (он же клуб продажи:
-- прямое удаление абонемента удаляет и продажу, client_memberships_after_delete).
drop policy if exists "client_memberships trainer write" on public.client_memberships;
create policy "client_memberships trainer write" on public.client_memberships
  for all to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

-- Остаток, срок и заморозку правит сотрудник любого клуба сети: абонемент
-- действует во всех клубах сети.
drop policy if exists "client_memberships network update" on public.client_memberships;
create policy "client_memberships network update" on public.client_memberships
  for update to authenticated
  using (studio_id = any ((select public.auth_network_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_network_studio_ids())::uuid[]));

-- Продажи и платежи других клубов сети — только чтение (история клиента в
-- карточке). Внести, изменить, удалить — «sales studio rw» / «sale_installments
-- via sale»: клуб продажи.
drop policy if exists "sales network read" on public.sales;
create policy "sales network read" on public.sales
  for select to authenticated
  using (studio_id = any ((select public.auth_network_studio_ids())::uuid[]));

drop policy if exists "sale_installments network read" on public.sale_installments;
create policy "sale_installments network read" on public.sale_installments
  for select to authenticated
  using (exists (
    select 1 from public.sales s
     where s.id = sale_installments.sale_id
       and s.studio_id = any ((select public.auth_network_studio_ids())::uuid[])));

-- Заморозка (db/membership_freeze.sql — выполнялся вручную; нет функции на
-- базе — нечего и менять). Тело — как там, кроме проверки сотрудника: клуб
-- той же сети, что абонемент.
do $do$
begin
  if to_regprocedure('public.freeze_membership(uuid, integer, text)') is not null then
    execute $f$
create or replace function public.freeze_membership(
  _client_membership_id uuid, _days integer, _reason text default null)
returns public.client_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  cm public.client_memberships;
  allowed int;
begin
  select * into cm from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not public.is_network_staff(auth.uid(), cm.studio_id) then raise exception 'forbidden'; end if;
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
$f$;
  end if;
  if to_regprocedure('public.unfreeze_membership(uuid)') is not null then
    execute $f$
create or replace function public.unfreeze_membership(_client_membership_id uuid)
returns public.client_memberships
language plpgsql
security definer
set search_path = public
as $$
declare cm public.client_memberships;
begin
  select * into cm from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not public.is_network_staff(auth.uid(), cm.studio_id) then raise exception 'forbidden'; end if;
  if cm.status <> 'frozen' then raise exception 'membership not frozen'; end if;

  update public.client_memberships
     set status = 'active', frozen_at = null, frozen_until = null
   where id = cm.id
   returning * into cm;
  return cm;
end $$;
$f$;
  end if;
end;
$do$;

-- 4. Посещения, анкета, вес ------------------------------------------------------

-- Журнал посещений клиента сети — во всех клубах сети (вкладка «Посещения»
-- карточки). Было: только клуб карточки («home studio»).
drop policy if exists "bookings_log home studio read" on public.bookings_log;
create policy "bookings_log home studio read" on public.bookings_log
  for select to authenticated
  using (client_id is not null and exists (
    select 1 from public.clients c
     where c.id = bookings_log.client_id
       and c.studio_id = any ((select public.auth_network_studio_ids())::uuid[])));

-- Анкета и вес читаются по карточке клиента. Прежние политики (клуб карточки,
-- db/*.sql и 2026-10-12_zzzzz_client_weights.sql) остаются — эти добавляют сеть.
drop policy if exists "member_profiles network staff read" on public.member_profiles;
create policy "member_profiles network staff read" on public.member_profiles
  for select to authenticated
  using (exists (
    select 1 from public.clients c
     where c.user_id = member_profiles.user_id
       and c.studio_id = any ((select public.auth_network_studio_ids())::uuid[])));

drop policy if exists "client_weights network staff read" on public.client_weights;
create policy "client_weights network staff read" on public.client_weights
  for select to authenticated
  using (exists (
    select 1 from public.clients c
     where c.user_id = client_weights.user_id
       and c.studio_id = any ((select public.auth_network_studio_ids())::uuid[])));

-- 5. Вкладка «Приложение» карточки клиента ---------------------------------------
-- Тело — как в 2026-10-15_zzzzz_client_app_activity.sql, кроме двух проверок
-- сотрудника: клуб той же сети, что карточка.
create or replace function public.client_app_overview(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_studio uuid;
  v_format text;
  v_cards uuid[];
  v_subs uuid[];
  v_since timestamptz := now() - interval '30 days';
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  select c.user_id, c.studio_id, coalesce(st.format, 'subscription')
    into v_user, v_studio, v_format
    from public.clients c
    left join public.studios st on st.id = c.studio_id
   where c.id = p_client_id;
  if not found then
    raise exception 'Клиент не найден' using errcode = 'P0002';
  end if;
  if not public.is_network_staff(auth.uid(), v_studio) then
    raise exception 'Нет доступа к клиенту' using errcode = '42501';
  end if;
  if v_user is null then
    return jsonb_build_object('has_account', false, 'app_format', v_format);
  end if;

  -- Карточки этого человека в клубах, которые видит вызывающий (сеть).
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_cards
    from public.clients c
   where c.user_id = v_user and public.is_network_staff(auth.uid(), c.studio_id);

  -- Телефоны с подпиской на пуши в приложении формата клуба: доставки
  -- ищутся по ним (индекс push_deliveries_subscription_idx).
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_subs
    from public.push_subscriptions s
   where s.user_id = v_user and (s.app_format is null or s.app_format = v_format);

  return jsonb_build_object(
    'has_account', true,
    'app_format', v_format,
    -- Учётная запись общая с админкой: «последний вход» — в любое приложение.
    'is_staff', public.is_staff(v_user),
    'account', (
      select jsonb_build_object(
        'created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at,
        'privacy_accepted_at', u.raw_user_meta_data ->> 'privacy_policy_accepted_at',
        'privacy_version', u.raw_user_meta_data ->> 'privacy_policy_version'
      )
        from auth.users u
       where u.id = v_user
    ),
    -- Самая новая версия, с которой открывали приложение за 30 дней, — чтобы
    -- показать, что у клиента устаревшая.
    'latest_app_version', (
      select d.app_version
        from public.app_devices d
       where d.app_version ~ '^\d{1,4}\.\d{1,4}$'
         and d.last_seen_at >= v_since
       order by split_part(d.app_version, '.', 1)::integer desc,
                split_part(d.app_version, '.', 2)::integer desc
       limit 1
    ),
    'devices', coalesce((
      select jsonb_agg(to_jsonb(d) - 'id' - 'user_id' order by d.last_seen_at desc)
        from public.app_devices d
       where d.user_id = v_user and d.app_format = v_format
    ), '[]'::jsonb),
    'activity', jsonb_build_object(
      'first_day', (
        select min(a.day) from public.app_activity_days a
         where a.user_id = v_user and a.app_format = v_format
      ),
      'days', coalesce((
        select jsonb_agg(jsonb_build_object('day', a.day, 'sessions', a.sessions) order by a.day)
          from public.app_activity_days a
         where a.user_id = v_user and a.app_format = v_format and a.day > v_today - 30
      ), '[]'::jsonb),
      'screens_30d', coalesce((
        select jsonb_object_agg(s.key, s.total)
          from (
            select e.key, sum(e.value::integer)::integer as total
              from public.app_activity_days a, jsonb_each_text(a.screens) e
             where a.user_id = v_user and a.app_format = v_format and a.day > v_today - 30
             group by e.key
          ) s
      ), '{}'::jsonb),
      'memberships_last_day', (
        select max(a.day) from public.app_activity_days a
         where a.user_id = v_user and a.app_format = v_format and a.screens ? 'memberships'
      )
    ),
    'push', jsonb_build_object(
      'subscriptions', cardinality(v_subs),
      'received_30d', (
        select count(*) from public.push_recipients r
          join public.push_notifications n on n.id = r.notification_id
         where r.user_id = v_user and r.created_at >= v_since
           and public.push_notification_in_format(n.studio_ids, v_format)
      ),
      'read_30d', (
        select count(*) from public.push_recipients r
          join public.push_notifications n on n.id = r.notification_id
         where r.user_id = v_user and r.created_at >= v_since and r.read_at is not null
           and public.push_notification_in_format(n.studio_ids, v_format)
      ),
      'last_received_at', (
        select max(r.created_at) from public.push_recipients r
          join public.push_notifications n on n.id = r.notification_id
         where r.user_id = v_user
           and public.push_notification_in_format(n.studio_ids, v_format)
      ),
      'sent_30d', (
        select count(*) from public.push_deliveries pd
         where pd.subscription_id = any(v_subs)
           and pd.user_id = v_user and pd.created_at >= v_since and pd.status = 'sent'
      ),
      'delivered_30d', (
        select count(*) from public.push_deliveries pd
         where pd.subscription_id = any(v_subs)
           and pd.user_id = v_user and pd.created_at >= v_since and pd.delivered_at is not null
      ),
      'clicked_30d', (
        select count(*) from public.push_deliveries pd
         where pd.subscription_id = any(v_subs)
           and pd.user_id = v_user and pd.created_at >= v_since and pd.clicked_at is not null
      )
    ),
    'actions', jsonb_build_object(
      -- Записи за 30 дней: сам в приложении или записал сотрудник
      -- («кто записал» база знает с 2026-10-15 — schedule_bookings.booked_by).
      'bookings_self_30d', (
        select count(*) from public.schedule_bookings b
         where b.booked_by = v_user and b.booked_at >= v_since
           and (b.user_id = v_user or b.client_id = any(v_cards))
      ),
      'bookings_staff_30d', (
        select count(*) from public.schedule_bookings b
         where b.booked_by is not null and b.booked_by <> v_user and b.booked_at >= v_since
           and (b.client_id = any(v_cards) or (b.client_id is null and b.user_id = v_user))
      ),
      'purchases_app', (
        select count(*) from public.sales s
         where s.client_id = any(v_cards) and s.source = 'mobile'
      ),
      'last_purchase_app_at', (
        select max(s.sold_at) from public.sales s
         where s.client_id = any(v_cards) and s.source = 'mobile'
      ),
      'trainer_reviews', (
        select count(*) from public.trainer_reviews tr where tr.user_id = v_user
      ),
      'requests', (
        select count(*) from public.client_requests cr where cr.client_id = any(v_cards)
      ),
      'nps_last', (
        select jsonb_build_object('score', nr.score, 'at', nr.created_at)
          from public.nps_responses nr
         where nr.user_id = v_user
         order by nr.created_at desc
         limit 1
      )
    )
  );
end;
$$;

revoke all on function public.client_app_overview(uuid) from public, anon;
grant execute on function public.client_app_overview(uuid) to authenticated;

-- 6. Одна карточка на человека в сети ------------------------------------------
-- Почта карточки — вход в приложение: при первом входе ensure_client_profile
-- находит карточку по почте и берёт одну; вторая карточка с той же почтой в
-- сети осталась бы без приложения, её продажи и записи клиент бы не увидел.
-- Проверяем только то, что меняется (почту, учётную запись, переход в
-- пакетный клуб): сохранение карточки без правки почты дубль не создаёт, а
-- перенос внутри сети (удаление клуба) — тоже.

create or replace function public.clients_network_unique_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(new.email, ''))), '');
  v_entered boolean;
  v_other public.clients%rowtype;
begin
  if not exists (
    select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
  ) then
    return new;
  end if;
  v_entered := tg_op = 'INSERT' or not exists (
    select 1 from public.studios s where s.id = old.studio_id and s.format = 'packages'
  );

  if v_email is not null and (
       v_entered
       or v_email is distinct from nullif(lower(btrim(coalesce(old.email, ''))), '')
     ) then
    -- Две одновременные карточки с одной почтой не проскочат обе.
    perform pg_advisory_xact_lock(hashtextextended('clients_network_email:' || v_email, 0));
    select c.* into v_other
      from public.clients c
      join public.studios s on s.id = c.studio_id and s.format = 'packages'
     where c.id <> new.id
       and lower(btrim(c.email)) = v_email
     limit 1;
    if found then
      raise exception 'Клиент с почтой % уже есть в базе клубов: %', v_email,
        coalesce(nullif(btrim(v_other.full_name), ''), 'без имени')
        using errcode = '23505', hint = 'client_email_taken', detail = v_other.id::text;
    end if;
  end if;

  if new.user_id is not null and (
       v_entered or new.user_id is distinct from old.user_id
     ) and exists (
       select 1
         from public.clients c
         join public.studios s on s.id = c.studio_id and s.format = 'packages'
        where c.id <> new.id
          and c.user_id = new.user_id
     ) then
    raise exception 'Учётная запись приложения уже привязана к другой карточке клиента'
      using errcode = '23505', hint = 'client_account_taken';
  end if;
  return new;
end;
$$;

drop trigger if exists clients_network_unique_guard_biu on public.clients;
create trigger clients_network_unique_guard_biu
  before insert or update of email, studio_id, user_id on public.clients
  for each row execute function public.clients_network_unique_guard();

-- Поиск по почте (защита выше, слияние ниже).
create index if not exists clients_email_norm_idx
  on public.clients (lower(btrim(email))) where email is not null;

-- 7. Слияние дублей ----------------------------------------------------------------

-- Заявки не меняют клуб и клиента обновлением (client_requests_guard) —
-- переносим строку целиком: удалить и вставить ту же с новым значением.
create or replace function public.client_requests_move(p_from_client uuid, p_to_client uuid,
                                                        p_from_studio uuid, p_to_studio uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.client_requests%rowtype;
begin
  for r in
    select * from public.client_requests
     where (p_from_client is not null and client_id = p_from_client)
        or (p_from_studio is not null and studio_id = p_from_studio)
     for update
  loop
    delete from public.client_requests where id = r.id;
    if p_from_client is not null and r.client_id = p_from_client then
      r.client_id := p_to_client;
    end if;
    if p_from_studio is not null and r.studio_id = p_from_studio then
      r.studio_id := p_to_studio;
    end if;
    insert into public.client_requests select r.*;
  end loop;
end;
$$;

revoke all on function public.client_requests_move(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Карточка p_drop сливается в p_keep: всё, что ссылается на дубль, переходит
-- на оставшуюся, пустые поля оставшейся заполняются из дубля, дубль удаляется.
-- Только для разового слияния (вызывают packages_merge_duplicate_clients и
-- тесты): прав вызывающего не проверяет.
create or replace function public.packages_merge_client_into(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.clients%rowtype;
  d public.clients%rowtype;
  v_user uuid;
  v_email text;
begin
  select * into k from public.clients where id = p_keep for update;
  select * into d from public.clients where id = p_drop for update;
  if k.id is null or d.id is null or k.id = d.id then
    return;
  end if;
  if k.user_id is not null and d.user_id is not null and k.user_id <> d.user_id then
    raise exception 'Карточки % и % привязаны к разным учётным записям — не сливаем', k.id, d.id;
  end if;
  v_user := coalesce(k.user_id, d.user_id);
  -- Почта дубля — оставшейся, если у неё нет своей и почта больше ни у кого.
  v_email := coalesce(nullif(btrim(k.email), ''), (
    select d.email
     where nullif(btrim(d.email), '') is not null
       and not exists (
         select 1 from public.clients c
           join public.studios s on s.id = c.studio_id and s.format = 'packages'
          where c.id not in (k.id, d.id)
            and lower(btrim(c.email)) = lower(btrim(d.email)))));

  -- 1. Дубль отдаёт почту и учётную запись: удаление карточки без них не
  -- стирает учётную запись приложения (clients_wipe_account и соседи).
  update public.clients set email = null, user_id = null where id = d.id;

  -- 2. Пустые поля оставшейся — из дубля.
  update public.clients c
     set user_id = v_user,
         email = v_email,
         first_name = coalesce(nullif(btrim(k.first_name), ''), d.first_name),
         last_name = coalesce(nullif(btrim(k.last_name), ''), d.last_name),
         phone = coalesce(nullif(btrim(k.phone), ''), d.phone),
         phone2 = coalesce(nullif(btrim(k.phone2), ''),
                           case when d.phone is distinct from coalesce(nullif(btrim(k.phone), ''), d.phone)
                                then d.phone end,
                           d.phone2),
         birthday = coalesce(k.birthday, d.birthday),
         gender = coalesce(nullif(btrim(k.gender), ''), d.gender),
         notes = case
                   when nullif(btrim(k.notes), '') is not null and nullif(btrim(d.notes), '') is not null
                        and btrim(k.notes) <> btrim(d.notes)
                     then k.notes || E'\n\n' || d.notes
                   else coalesce(nullif(btrim(k.notes), ''), d.notes)
                 end,
         registration_date = least(k.registration_date, d.registration_date),
         last_visit_date = greatest(k.last_visit_date, d.last_visit_date),
         crm_link = coalesce(nullif(btrim(k.crm_link), ''), d.crm_link),
         photo_url = coalesce(nullif(btrim(k.photo_url), ''), d.photo_url)
   where c.id = k.id;

  -- 3. Абонементы. Живой (действующий или замороженный) у одного клиента — один
  -- на вид баланса: живой дубля того же вида встаёт в очередь, как продление.
  update public.client_memberships cm
     set status = 'pending'
   where cm.client_id = d.id
     and cm.status in ('active', 'frozen')
     and exists (
       select 1 from public.client_memberships o
        where o.client_id = k.id
          and o.balance_kind = cm.balance_kind
          and o.status in ('active', 'frozen'));
  update public.client_memberships set client_id = k.id where client_id = d.id;

  -- 4. Продажи (on delete restrict) и прочие продажи.
  update public.sales set client_id = k.id where client_id = d.id;
  update public.other_sales set client_id = k.id where client_id = d.id;

  -- 5. Записи. Обе карточки на одном занятии — запись дубля удаляется вместе
  -- со строкой журнала (иначе занятие в истории двоилось бы); списанное по ней
  -- возвращается на абонемент, место освобождается (schedule_bookings_refund_ad).
  -- Иначе нарушились бы уникальности записи.
  with twin as (
    select b.id
      from public.schedule_bookings b
     where b.client_id = d.id
       and exists (
         select 1 from public.schedule_bookings o
          where o.entry_id = b.entry_id
            and o.id <> b.id
            and (o.client_id = k.id or (v_user is not null and o.user_id = v_user)))
  ), twin_log as (
    delete from public.bookings_log l using twin where l.booking_id = twin.id
  )
  delete from public.schedule_bookings b using twin where b.id = twin.id;
  update public.schedule_bookings set client_id = k.id where client_id = d.id;
  update public.bookings_log
     set client_id = k.id, user_id = coalesce(user_id, v_user)
   where client_id = d.id;

  -- 6. Заявки и NPS.
  perform public.client_requests_move(d.id, k.id, null, null);
  update public.nps_responses set client_id = k.id where client_id = d.id;
  update public.nps_survey_prompts set client_id = k.id where client_id = d.id;

  delete from public.clients where id = d.id;
  perform public.packages_settle(k.id);
end;
$$;

revoke all on function public.packages_merge_client_into(uuid, uuid) from public, anon, authenticated;

-- Разово (и безопасно повторно): дубли карточек в пакетных клубах — одна
-- учётная запись или одна почта (без учёта регистра и пробелов по краям).
-- Остаётся карточка с учётной записью приложения, затем с живым абонементом,
-- затем самая старая. Карточки одной почты, привязанные к разным учётным
-- записям, не сливаются (так не бывает: почта — вход). Возвращает число
-- слитых дублей.
create or replace function public.packages_merge_duplicate_clients()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  v_id uuid;
  v_merged integer := 0;
begin
  for g in
    with pc as (
      select c.*,
             exists (select 1 from public.client_memberships cm
                      where cm.client_id = c.id and cm.status in ('active', 'frozen')) as live
        from public.clients c
        join public.studios s on s.id = c.studio_id and s.format = 'packages'
    )
    select array_agg(pc.id order by (pc.user_id is not null) desc, pc.live desc,
                                    pc.created_at, pc.id) as ids
      from pc
     where pc.user_id is not null
     group by pc.user_id
    having count(*) > 1
  loop
    foreach v_id in array g.ids[2:] loop
      perform public.packages_merge_client_into(g.ids[1], v_id);
      v_merged := v_merged + 1;
    end loop;
  end loop;

  for g in
    with pc as (
      select c.*,
             exists (select 1 from public.client_memberships cm
                      where cm.client_id = c.id and cm.status in ('active', 'frozen')) as live
        from public.clients c
        join public.studios s on s.id = c.studio_id and s.format = 'packages'
       where nullif(btrim(c.email), '') is not null
    )
    select lower(btrim(pc.email)) as email,
           count(distinct pc.user_id) as users,
           array_agg(pc.id order by (pc.user_id is not null) desc, pc.live desc,
                                    pc.created_at, pc.id) as ids
      from pc
     group by lower(btrim(pc.email))
    having count(*) > 1
  loop
    if g.users > 1 then
      raise notice 'Почта % — у карточек разных учётных записей, не слиты: %', g.email, g.ids;
      continue;
    end if;
    foreach v_id in array g.ids[2:] loop
      perform public.packages_merge_client_into(g.ids[1], v_id);
      v_merged := v_merged + 1;
    end loop;
  end loop;
  return v_merged;
end;
$$;

revoke all on function public.packages_merge_duplicate_clients() from public, anon, authenticated;

select public.packages_merge_duplicate_clients();

-- 8. Удаление пакетного клуба -----------------------------------------------------
-- Тело — как в 2026-10-13_zzzz_packages_shared_catalog.sql (каталог) + клиенты
-- общей базы с их заявками: каскад удалил бы клиентов, которые ходят и в
-- другие клубы сети (или не дал бы удалить клуб из-за их продаж там).
-- Продажи, абонементы, записи и журнал самого клуба удаляются, как раньше.

create or replace function public.studios_packages_catalog_rehome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  if old.format <> 'packages' then
    return old;
  end if;
  select id into v_target from public.studios
   where format = 'packages' and id <> old.id
   order by created_at, id
   limit 1;
  if v_target is null then
    return old;
  end if;
  update public.workouts set studio_id = v_target where studio_id = old.id;
  update public.memberships set studio_id = v_target where studio_id = old.id;
  update public.clients set studio_id = v_target where studio_id = old.id;
  perform public.client_requests_move(null, null, old.id, v_target);
  return old;
end;
$$;

-- 9. Остаток на занятии: записи клиента во всех клубах ---------------------------
-- Окно занятия считает, хватит ли абонемента: остаток уйдёт сначала на
-- неотмеченные записи клиента на такие же занятия раньше этого. Записи
-- других клубов сети сотруднику не видны (RLS schedule_bookings — клуб
-- записи), а списываются с того же абонемента — поэтому число считает база.
-- Только сотрудник клуба занятия; отдаёт только числа.

create or replace function public.entry_bookings_ahead(p_entry_id uuid)
returns table (client_id uuid, ahead integer)
language sql
stable
security definer
set search_path = public
as $$
  select b.client_id, count(*)::integer
    from public.schedule_entries e
    join public.schedule_bookings b on b.entry_id = e.id and b.client_id is not null
    join public.schedule_bookings ob
      on ob.client_id = b.client_id and ob.status = 'booked' and ob.entry_id <> e.id
    join public.schedule_entries oe
      on oe.id = ob.entry_id and oe.kind = e.kind and oe.cancelled_at is null
     and oe.starts_at < e.starts_at
   where e.id = p_entry_id
     and public.is_trainer(auth.uid(), e.studio_id)
   group by b.client_id
$$;

revoke all on function public.entry_bookings_ahead(uuid) from public, anon;
grant execute on function public.entry_bookings_ahead(uuid) to authenticated;

notify pgrst, 'reload schema';
