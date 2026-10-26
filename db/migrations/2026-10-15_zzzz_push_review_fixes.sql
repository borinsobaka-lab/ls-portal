-- ============================================================================
-- Пуш-уведомления: исправления по код-ревью 2026-10-15
-- (2026-10-15_push_delivery.sql, 2026-10-15_push_triggers.sql).
--
-- 1. Пуш и лента — своего приложения. Подписка устройства знает свой
--    формат (push_subscriptions.app_format), а доставки соединялись с
--    подписками только по учётной записи: у человека с картами в клубах
--    обоих форматов пуш Lady Stretch приходил и в приложение Base40, а лента
--    «Уведомления» показывала уведомления обоих приложений.
--    - push_start_due: доставка — на телефоны приложения формата клубов, где
--      у получателя карточка из выборки рассылки (формат подписки не
--      записан — как раньше, на телефон);
--    - push_trigger_send: доставка — на телефоны приложения формата
--      триггера;
--    - my_push_inbox / push_mark_read: p_app_format — уведомления клубов
--      этого формата (без него — все, как раньше: старое приложение);
--    - push_audience_stats: «с включёнными уведомлениями» — телефоны
--      приложения формата клубов выборки.
-- 2. push_triggers_run (актуальное определение — здесь):
--    - кандидаты без уже отправленного (push_trigger_log): раньше пачку
--      `limit 500` каждый проход заполняли одни и те же отправленные строки,
--      и до клиентов дальше по списку очередь не доходила; заодно
--      переменные текста (push_trigger_vars) больше не собираются впустую
--      каждую минуту;
--    - «после пробной» и «оцените тренера»: окно — 48 часов после момента
--      отправки (конец занятия + N часов), а не 48 часов от конца занятия: при
--      N от 38 часов окно сжималось до ночи и пуш терялся, при 48 — не
--      приходил никогда;
--    - «давно не был»: посещения и будущие записи — в клубах формата
--      триггера, диагностика тела — не тренировка; последнее посещение
--      считается одним проходом по записям окна, а не подзапросом на каждого
--      клиента с абонементом;
--    - «давно не был» и «день рождения»: журнал — свой у каждого формата
--      (ref с форматом: прежний ref без формата — год, дата посещения —
--      пускал только одно из двух приложений; уже отправленное по прежнему
--      ref не повторяется).
-- 3. Ссылка перехода — не длиннее 1000 символов (push_notifications,
--    push_triggers): пуш ограничен ~4 КБ.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 3. Длина ссылки перехода ------------------------------------------------------

alter table public.push_notifications drop constraint if exists push_notifications_action_url_length;
alter table public.push_notifications
  add constraint push_notifications_action_url_length
  check (action_url is null or char_length(action_url) <= 1000) not valid;

alter table public.push_triggers drop constraint if exists push_triggers_action_url_length;
alter table public.push_triggers
  add constraint push_triggers_action_url_length
  check (action_url is null or char_length(action_url) <= 1000) not valid;

-- 1. Пуш и лента — своего приложения ---------------------------------------------

create or replace function public.push_start_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_started integer := 0;
  v_recipients integer;
  v_devices integer;
begin
  for r in
    select id, studio_ids, segments
      from public.push_notifications
     where status = 'scheduled' and scheduled_at <= now()
     order by scheduled_at
     for update skip locked
  loop
    -- Клиенты выбранных клубов с учётной записью приложения; сегмент — статус
    -- клуба (ЧК/БЧК/ПЧК) карточки. Человек с карточками в нескольких клубах —
    -- один получатель.
    insert into public.push_recipients (notification_id, user_id)
    select distinct r.id, c.user_id
      from public.clients_with_status c
     where c.studio_id = any(r.studio_ids)
       and c.user_id is not null
       and (
         cardinality(r.segments) = 0
         or 'all' = any(r.segments)
         or c.club_status = any(r.segments)
       )
    on conflict do nothing;

    -- Телефоны приложения того формата, где у получателя карточка в клубах
    -- рассылки (Base40 — подписочные клубы, Lady Stretch — пакетные).
    insert into public.push_deliveries (notification_id, subscription_id, user_id)
    select r.id, s.id, s.user_id
      from public.push_recipients pr
      join public.push_subscriptions s on s.user_id = pr.user_id
     where pr.notification_id = r.id
       and (
         s.app_format is null
         or exists (
           select 1 from public.clients c
             join public.studios st on st.id = c.studio_id
            where c.user_id = pr.user_id
              and c.studio_id = any(r.studio_ids)
              and st.format = s.app_format
         )
       )
    on conflict do nothing;

    select count(*) into v_recipients from public.push_recipients where notification_id = r.id;
    select count(*) into v_devices from public.push_deliveries where notification_id = r.id;

    update public.push_notifications
       set status = case when v_devices = 0 then 'sent' else 'sending' end,
           sent_at = coalesce(sent_at, now()),
           finished_at = case when v_devices = 0 then now() end,
           recipients_count = v_recipients,
           devices_count = v_devices,
           updated_at = now()
     where id = r.id;
    v_started := v_started + 1;
  end loop;
  return v_started;
end;
$$;

revoke all on function public.push_start_due() from public, anon, authenticated;
grant execute on function public.push_start_due() to service_role;

-- Срабатывание триггера: как в 2026-10-15_push_triggers.sql, доставки — только
-- на телефоны приложения формата триггера.
create or replace function public.push_trigger_send(
  p_trigger public.push_triggers,
  p_user uuid,
  p_studio uuid,
  p_ref text,
  p_vars jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tr jsonb := '{}'::jsonb;
  v_lang text;
  v_title text;
  v_message text;
  v_devices integer;
begin
  if p_user is null or p_ref is null then
    return false;
  end if;

  insert into public.push_trigger_log (trigger_key, user_id, ref)
  values (p_trigger.key, p_user, p_ref)
  on conflict do nothing;
  if not found then
    return false;
  end if;

  foreach v_lang in array array['en', 'ka'] loop
    v_title := nullif(btrim(p_trigger.translations -> v_lang ->> 'title'), '');
    v_message := nullif(btrim(p_trigger.translations -> v_lang ->> 'message'), '');
    if v_title is not null or v_message is not null then
      v_tr := v_tr || jsonb_build_object(v_lang, jsonb_strip_nulls(jsonb_build_object(
        'title', case when v_title is not null then public.push_trigger_render(v_title, p_vars -> v_lang) end,
        'message', case when v_message is not null then public.push_trigger_render(v_message, p_vars -> v_lang) end
      )));
    end if;
  end loop;

  select count(*) into v_devices
    from public.push_subscriptions
   where user_id = p_user
     and (app_format is null or app_format = p_trigger.format);

  insert into public.push_notifications (
    studio_id, studio_ids, title, message, action_url, translations, segments,
    status, scheduled_at, sent_at, finished_at, recipients_count, devices_count, trigger_key
  )
  values (
    p_studio,
    array[p_studio],
    public.push_trigger_render(p_trigger.title, p_vars -> 'ru'),
    nullif(public.push_trigger_render(p_trigger.message, p_vars -> 'ru'), ''),
    p_trigger.action_url,
    v_tr,
    '{}'::text[],
    case when v_devices = 0 then 'sent' else 'sending' end,
    now(),
    now(),
    case when v_devices = 0 then now() end,
    1,
    v_devices,
    p_trigger.key
  )
  returning id into v_id;

  insert into public.push_recipients (notification_id, user_id) values (v_id, p_user);

  insert into public.push_deliveries (notification_id, subscription_id, user_id)
  select v_id, s.id, s.user_id
    from public.push_subscriptions s
   where s.user_id = p_user
     and (s.app_format is null or s.app_format = p_trigger.format)
  on conflict do nothing;

  update public.push_trigger_log
     set notification_id = v_id
   where trigger_key = p_trigger.key and user_id = p_user and ref = p_ref;
  return true;
end;
$$;

revoke all on function public.push_trigger_send(public.push_triggers, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.push_trigger_send(public.push_triggers, uuid, uuid, text, jsonb) to service_role;

-- Уведомление относится к приложению формата, если среди его клубов есть клуб
-- этого формата (у триггерного — один клуб, формат триггера).
create or replace function public.push_notification_in_format(p_studio_ids uuid[], p_format text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_format is null
      or exists (
        select 1 from public.studios s
         where s.id = any(coalesce(p_studio_ids, '{}'::uuid[])) and s.format = p_format
      )
$$;

revoke all on function public.push_notification_in_format(uuid[], text) from public, anon, authenticated;

-- Лента приложения: только его уведомления. Прежняя подпись (p_limit) —
-- удаляется: вызов с одним p_limit попадает в новую (формат не задан — все).
drop function if exists public.my_push_inbox(integer);

create or replace function public.my_push_inbox(p_limit integer default 100, p_app_format text default null)
returns table (
  notification_id uuid,
  title text,
  message text,
  action_url text,
  translations jsonb,
  sent_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.title, n.message, n.action_url, n.translations,
         coalesce(n.sent_at, r.created_at), r.read_at
    from public.push_recipients r
    join public.push_notifications n on n.id = r.notification_id
   where r.user_id = auth.uid()
     and public.push_notification_in_format(n.studio_ids, p_app_format)
   order by coalesce(n.sent_at, r.created_at) desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

revoke all on function public.my_push_inbox(integer, text) from public, anon;
grant execute on function public.my_push_inbox(integer, text) to authenticated;

-- «Прочитать все» — только в ленте своего приложения.
drop function if exists public.push_mark_read(uuid[]);

create or replace function public.push_mark_read(p_ids uuid[] default null, p_app_format text default null)
returns integer
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.push_recipients r
       set read_at = now()
      from public.push_notifications n
     where n.id = r.notification_id
       and r.user_id = auth.uid()
       and r.read_at is null
       and (p_ids is null or r.notification_id = any(p_ids))
       and public.push_notification_in_format(n.studio_ids, p_app_format)
    returning r.notification_id
  ),
  counts as (
    update public.push_notifications n
       set read_count = n.read_count + c.cnt
      from (select notification_id, count(*) as cnt from upd group by notification_id) c
     where n.id = c.notification_id
    returning n.id
  )
  select count(*)::integer from upd
$$;

revoke all on function public.push_mark_read(uuid[], text) from public, anon;
grant execute on function public.push_mark_read(uuid[], text) to authenticated;

-- Охват формы: «с включёнными уведомлениями» — телефон приложения формата
-- клуба, где карточка из выборки.
create or replace function public.push_audience_stats(p_studio_ids uuid[], p_segments text[])
returns table (clients integer, app_users integer, push_users integer)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (
    select s
      from unnest(coalesce(p_studio_ids, '{}'::uuid[])) s
     where public.has_admin_section(auth.uid(), 'app')
       and public.is_trainer(auth.uid(), s)
  ),
  cards as (
    select c.id, c.user_id, st.format
      from public.clients_with_status c
      join public.studios st on st.id = c.studio_id
     where c.studio_id in (select s from ids)
       and (
         cardinality(coalesce(p_segments, '{}'::text[])) = 0
         or 'all' = any(p_segments)
         or c.club_status = any(p_segments)
       )
  ),
  users as (
    select distinct user_id from cards where user_id is not null
  )
  select (select count(*) from cards)::integer,
         (select count(*) from users)::integer,
         (select count(*) from users u
           where exists (
             select 1 from public.push_subscriptions ps
              where ps.user_id = u.user_id
                and (
                  ps.app_format is null
                  or exists (
                    select 1 from public.studios st
                      join public.clients c on c.studio_id = st.id
                     where c.user_id = u.user_id
                       and st.id in (select s from ids)
                       and st.format = ps.app_format
                  )
                )
           ))::integer
$$;

revoke all on function public.push_audience_stats(uuid[], text[]) from public, anon;
grant execute on function public.push_audience_stats(uuid[], text[]) to authenticated;

-- 2. Проход по триггерам ------------------------------------------------------------

-- Возвращает, сколько уведомлений создано. p_now — для тестов (по умолчанию
-- сейчас). Кандидаты — без уже отправленного (push_trigger_log), не больше
-- 500 срабатываний триггера за проход — остальные уйдут в следующий.
create or replace function public.push_triggers_run(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.push_triggers;
  r record;
  v_sent integer := 0;
  v_today date := (p_now at time zone 'Asia/Tbilisi')::date;
  v_hour integer := extract(hour from (p_now at time zone 'Asia/Tbilisi'))::integer;
  -- Ночью не шлём необязательное — уйдёт утром (окна событий — сутки и больше).
  v_quiet boolean := v_hour < 9 or v_hour >= 22;
  v_daily boolean;
  v_n integer;
  v_since timestamptz;
  v_year text := extract(year from (p_now at time zone 'Asia/Tbilisi'))::integer::text;
begin
  -- Два сервера при выкатке: второй просто пропускает проход.
  if not pg_try_advisory_xact_lock(hashtext('push_triggers_run')) then
    return 0;
  end if;

  delete from public.push_trigger_log where created_at < p_now - interval '400 days';

  for t in
    select * from public.push_triggers pt
     where pt.enabled
       and exists (select 1 from public.studios s where s.format = pt.format)
     order by pt.format, pt.key
  loop
    v_daily := v_hour >= coalesce((t.params ->> 'send_hour')::integer, 11) and v_hour < 22;

    case t.key

    -- Напоминание о занятии за N часов (ночное — утром или накануне вечером).
    -- Записавшимся позже момента напоминания не шлём: они только что записались.
    when 'class_reminder' then
      v_n := coalesce((t.params ->> 'hours')::integer, 3);
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
         where b.status = 'booked'
           and e.cancelled_at is null
           and coalesce(e.kind, 'group') in ('group', 'personal', 'diagnostic')
           and e.starts_at > p_now
           and e.starts_at <= p_now + make_interval(hours => v_n + 13)
           and public.push_trigger_reminder_at(e.starts_at, v_n) <= p_now
           and coalesce(b.booked_at, b.created_at) <= public.push_trigger_reminder_at(e.starts_at, v_n)
           and u.user_id is not null
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = b.entry_id::text
           )
         order by u.user_id, b.entry_id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.entry_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Записал не сам клиент (администратор в админке).
    when 'booked_for_client' then
      v_since := greatest(t.active_since, p_now - interval '6 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id, x.ref
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
          cross join lateral (
            select b.id::text || ':' || floor(extract(epoch from b.booked_at))::bigint::text as ref
          ) x
         where b.status = 'booked'
           and b.booked_at >= v_since
           and b.booked_at <= p_now
           and b.booked_by is not null
           and b.booked_by is distinct from u.user_id
           and e.cancelled_at is null
           and e.starts_at > p_now
           and u.user_id is not null
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = x.ref
           )
         order by u.user_id, b.entry_id, b.booked_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Клуб отменил занятие: записи переведены в «Отменено» тем же
    -- cancel_schedule_entry (cancelled_at записи = cancelled_at занятия).
    when 'class_cancelled' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id, x.ref
          from public.schedule_entries e
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.schedule_bookings b on b.entry_id = e.id
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
          cross join lateral (
            select b.entry_id::text || ':' || floor(extract(epoch from e.cancelled_at))::bigint::text as ref
          ) x
         where e.cancelled_at >= v_since
           and e.cancelled_at <= p_now
           and e.starts_at > p_now
           and b.status = 'cancelled'
           and b.cancelled_at = e.cancelled_at
           and u.user_id is not null
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = x.ref
           )
         order by u.user_id, b.entry_id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Замена тренера — тем, кто записался до замены.
    when 'trainer_substitution' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id, x.ref
          from public.schedule_entry_substitutions su
          join public.schedule_entries e on e.id = su.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.schedule_bookings b on b.entry_id = e.id
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
          cross join lateral (select b.entry_id::text || ':' || su.trainer_id::text as ref) x
         where su.created_at >= v_since
           and su.created_at <= p_now
           and e.cancelled_at is null
           and e.starts_at > p_now
           and b.status = 'booked'
           and coalesce(b.booked_at, b.created_at) < su.created_at
           and u.user_id is not null
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = x.ref
           )
         order by u.user_id, b.entry_id, su.created_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Абонемент по продаже (в админке или в приложении) выдан.
    when 'membership_activated' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
         where cm.sale_id is not null
           and cm.created_at >= v_since
           and cm.created_at <= p_now
           and cm.status in ('active', 'pending')
           and c.user_id is not null
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = c.user_id and lg.ref = cm.id::text
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Срок абонемента кончается через N дней, продления нет (ни ждущего, ни
    -- автопродления). Пробный — не в счёт.
    when 'membership_expiring' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 3);
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id, cm.ends_at
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         where cm.status = 'active'
           and cm.ends_at between v_today and v_today + v_n
           and not coalesce(cm.auto_renew, false)
           and coalesce(m.kind, 'package') <> 'trial'
           and c.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
                and (nx.status = 'pending' or nx.ends_at is null or nx.ends_at > cm.ends_at)
           )
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = c.user_id and lg.ref = cm.id::text
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.ends_at,
               jsonb_build_object('days', (r.ends_at - v_today)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Срок абонемента вышел 1–3 дня назад, другого действующего нет.
    when 'membership_ended' then
      continue when not v_daily;
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id, cm.ends_at
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         where cm.status in ('active', 'expired')
           and cm.ends_at between v_today - 3 and v_today - 1
           -- Закончился по сроку: отхоженный (остаток 0) — не «срок вышел».
           and coalesce(case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end, 1) > 0
           and cm.ends_at >= (t.active_since at time zone 'Asia/Tbilisi')::date - 1
           and coalesce(m.kind, 'package') <> 'trial'
           and c.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
           )
           -- О закончившихся тренировках уже сказали.
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key in (t.key, 'visits_exhausted')
                and lg.user_id = c.user_id and lg.ref = cm.id::text
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.ends_at, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Пакетные: после списания осталось N тренировок или меньше (не ноль).
    when 'visits_low', 'visits_exhausted' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'left')::integer, 2);
      v_since := greatest(t.active_since, p_now - interval '3 days');
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id,
               case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end as balance
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         -- Пробное и разовое посещение (2026-10-15_zz_packages_single_visit.sql) — не в счёт.
         where coalesce(m.kind, 'package') not in ('trial', 'single')
           and c.user_id is not null
           and case when t.key = 'visits_low'
                    then cm.status = 'active'
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end)
                             between 1 and v_n
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end)
                             < coalesce(case when cm.balance_kind = 'personal' then m.personal_count else m.visits_count end, 0)
                    else cm.status in ('active', 'expired')
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end) = 0
               end
           -- Тренировка списана недавно (после включения триггера).
           and exists (
             select 1 from public.schedule_bookings b
               join public.schedule_entries e on e.id = b.entry_id
              where b.charged_membership_id = cm.id
                and b.status in ('attended', 'no_show')
                and coalesce(b.charged_balance, '') <> 'diagnostic'
                and e.starts_at >= v_since
                and e.starts_at <= p_now
           )
           -- Продление уже куплено.
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
           )
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = c.user_id and lg.ref = cm.id::text
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, null,
               jsonb_build_object('left', r.balance::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Через N часов после пробной тренировки, если абонемент ещё не купили.
    -- Окно — 48 часов после момента отправки (ночь его не съедает).
    when 'trial_followup' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'hours')::integer, 3);
      v_since := greatest(t.active_since, p_now - make_interval(hours => v_n + 48));
      for r in
        select distinct on (u.user_id, cm.id)
               u.user_id, cm.client_id, e.studio_id, cm.id as cm_id
          from public.schedule_bookings b
          join public.client_memberships cm on cm.id = b.charged_membership_id
          join public.memberships m on m.id = cm.membership_id and m.kind = 'trial'
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.clients c on c.id = cm.client_id
          cross join lateral (select coalesce(b.user_id, c.user_id) as user_id) u
         where b.status = 'attended'
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') >= v_since
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') + make_interval(hours => v_n) <= p_now
           and u.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
               join public.memberships nm on nm.id = nx.membership_id
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nm.kind, 'package') <> 'trial'
                and nx.created_at > cm.created_at
           )
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = cm.id::text
           )
         order by u.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Через N часов после посещения — оценить тренера (раз на тренера, пока
    -- клиент его не оценил). Окно — как у пробной.
    when 'rate_trainer' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'hours')::integer, 2);
      v_since := greatest(t.active_since, p_now - make_interval(hours => v_n + 48));
      for r in
        select distinct on (u.user_id, tr.trainer_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id, tr.trainer_id
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
          cross join lateral (
            select coalesce(
              (select su.trainer_id from public.schedule_entry_substitutions su
                where su.entry_id = e.id order by su.created_at desc limit 1),
              (select et.trainer_id from public.schedule_entry_trainers et
                 join public.trainers tt on tt.id = et.trainer_id
                where et.entry_id = e.id order by tt.full_name limit 1)
            ) as trainer_id
          ) tr
          join public.trainers trn on trn.id = tr.trainer_id
         where b.status = 'attended'
           and coalesce(trn.role, 'trainer') in ('trainer', 'masseur')
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') >= v_since
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') + make_interval(hours => v_n) <= p_now
           and u.user_id is not null
           and not exists (
             select 1 from public.trainer_reviews rv
              where rv.trainer_id = tr.trainer_id and rv.user_id = u.user_id
           )
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = u.user_id and lg.ref = tr.trainer_id::text
           )
         order by u.user_id, tr.trainer_id, e.starts_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.trainer_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Платёж по рассрочке через N дней (0 — в день платежа) или просрочен
    -- на N дней (неделю после — не напоминаем).
    when 'installment_due', 'installment_overdue' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 1);
      for r in
        select distinct on (c.user_id, i.id)
               c.user_id, c.id as client_id, sa.studio_id, i.id as installment_id,
               sa.membership_id, i.due_date, i.amount
          from public.sale_installments i
          join public.sales sa on sa.id = i.sale_id
          join public.clients c on c.id = sa.client_id
          join public.studios s on s.id = sa.studio_id and s.format = t.format
         where not i.paid
           and not coalesce(i.refunded, false)
           and c.user_id is not null
           and case when t.key = 'installment_due'
                    then i.due_date between v_today and v_today + v_n
                    else i.due_date between v_today - v_n - 7 and v_today - greatest(v_n, 1)
               end
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = c.user_id and lg.ref = i.id::text
           )
         order by c.user_id, i.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.installment_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.due_date,
               jsonb_build_object('amount', trim_scale(r.amount)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- С действующим абонементом, но без посещений N дней (неделю после — не
    -- пишем) и без будущих записей — в клубах формата триггера. Диагностика
    -- тела — не тренировка.
    when 'no_visits' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 14);
      for r in
        with live as (
          select distinct on (c.user_id)
                 c.user_id, c.id as client_id, c.studio_id
            from public.client_memberships cm
            join public.clients c on c.id = cm.client_id
            join public.studios s on s.id = c.studio_id and s.format = t.format
           where cm.status = 'active'
             and c.user_id is not null
           order by c.user_id, c.created_at
        ),
        -- Последнее посещение. Записи раньше окна не нужны: если последнее
        -- посещение раньше окна, клиент и так не подходит.
        visits as (
          select coalesce(b.user_id, bc.user_id) as user_id,
                 max((e.starts_at at time zone 'Asia/Tbilisi')::date) as visit_date
            from public.schedule_bookings b
            join public.schedule_entries e on e.id = b.entry_id
            join public.studios es on es.id = e.studio_id and es.format = t.format
            left join public.clients bc on bc.id = b.client_id
           where b.status = 'attended'
             and coalesce(e.kind, 'group') <> 'diagnostic'
             and e.starts_at >= ((v_today - v_n - 7)::timestamp at time zone 'Asia/Tbilisi')
           group by 1
        )
        select live.user_id, live.client_id, live.studio_id, v.visit_date,
               v.visit_date::text || ':' || t.format as ref
          from live
          join visits v on v.user_id = live.user_id
         where v.visit_date between v_today - v_n - 7 and v_today - v_n
           -- Уже писали (прежний ref — без формата).
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = live.user_id
                and lg.ref in (v.visit_date::text || ':' || t.format, v.visit_date::text)
           )
           and not exists (
             select 1 from public.schedule_bookings b
               join public.schedule_entries e on e.id = b.entry_id
               join public.studios es on es.id = e.studio_id and es.format = t.format
               left join public.clients bc on bc.id = b.client_id
              where b.status = 'booked'
                and e.starts_at > p_now
                and e.cancelled_at is null
                and coalesce(b.user_id, bc.user_id) = live.user_id
           )
         order by live.user_id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, r.visit_date,
               jsonb_build_object('days', (v_today - r.visit_date)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- День рождения: карточка клиента или анкета приложения. Раз в год в
    -- каждом приложении (прежний ref — год без формата).
    when 'birthday' then
      continue when not v_daily;
      for r in
        select distinct on (c.user_id)
               c.user_id, c.id as client_id, c.studio_id
          from public.clients c
          join public.studios s on s.id = c.studio_id and s.format = t.format
          left join public.member_profiles mp on mp.user_id = c.user_id
         where c.user_id is not null
           and to_char(coalesce(c.birthday, mp.birth_date), 'MM-DD') = to_char(v_today, 'MM-DD')
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = t.key and lg.user_id = c.user_id
                and lg.ref in (v_year || ':' || t.format, v_year)
           )
         order by c.user_id, c.created_at
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, v_year || ':' || t.format,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    else
      null;
    end case;
  end loop;

  return v_sent;
end;
$$;

revoke all on function public.push_triggers_run(timestamptz) from public, anon, authenticated;
grant execute on function public.push_triggers_run(timestamptz) to service_role;

notify pgrst, 'reload schema';
