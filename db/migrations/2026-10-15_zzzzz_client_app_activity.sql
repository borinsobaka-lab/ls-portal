-- ============================================================================
-- Клиентское приложение: устройства и активность клиента (решение владельца
-- 2026-10-15) — вкладка «Приложение» в карточке клиента админки
-- ============================================================================
-- Раньше база знала о клиенте в приложении только то, что он прошёл анкету, и
-- подписку на пуши (если включил уведомления; push_subscriptions — только
-- сервер). Для поддержки клиентов, управления приложением и продаж теперь
-- приложение само сообщает:
--
-- 1. app_devices — строка на устройство (установку приложения: id
--    устройства придумывает приложение и хранит на телефоне) × учётная
--    запись: платформа, система и её версия, модель (Android — из Client
--    Hints, iPhone — по размеру экрана), браузер, версия приложения,
--    установлено ли на экран «Домой», разрешение и подписка на уведомления,
--    язык приложения и устройства, часовой пояс, экран, тёмная тема, user
--    agent; первый и последний раз в приложении, сколько раз открывали
--    (новое открытие — после 30 минут без активности). Не больше 10
--    устройств на учётную запись: старые уходят первыми.
-- 2. app_activity_days — день (по Тбилиси) × учётная запись × приложение
--    (формат): сколько раз открывали и какие разделы смотрели
--    (screens: {"home": 3, "memberships": 1, …}). Хранится 400 дней — для
--    будущей статистики (активные за день/месяц, удержание, интерес к
--    абонементам). Рядом с этим — доли разделов в сводке карточки.
--
-- Пишет только RPC app_ping (вошедший клиент о своём устройстве; приложение
-- зовёт при запуске, при возвращении и раз в 5 минут, пока открыто). Читать
-- таблицы напрямую нельзя никому, кроме сервера: админка получает всё одной
-- RPC client_app_overview — только сотрудник клуба карточки (is_trainer),
-- и только данные приложения формата этого клуба (человек может быть
-- клиентом клубов обоих форматов — у каждого своё приложение). Там же —
-- вход (учётная запись GoTrue: создана — первый вход, последний вход по
-- коду, согласие с политикой), уведомления за 30 дней (получено, прочитано,
-- доставлено на телефон, открыто из пуша) и действия в приложении (записи
-- сам / записал администратор, покупки, оценки тренерам, заявки, NPS).
--
-- Последняя карточка клиента удалена — устройства и активность уходят
-- (clients_app_activity_cleanup_ad, как подписки на пуши); учётную запись
-- стирает wipe_client_app_account — вместе с ней каскадом.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Устройства ----------------------------------------------------------------

create table if not exists public.app_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  app_format text not null check (app_format in ('subscription', 'packages')),
  platform text check (platform in ('ios', 'android', 'other')),
  os_name text,
  os_version text,
  device_model text,
  browser text,
  browser_version text,
  app_version text,
  standalone boolean,
  push_permission text check (push_permission in ('granted', 'denied', 'default', 'unsupported')),
  push_subscribed boolean,
  locale text,
  device_language text,
  timezone text,
  screen text,
  dark_mode boolean,
  user_agent text,
  sessions_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_id)
);

create index if not exists app_devices_user_idx on public.app_devices(user_id, last_seen_at desc);
create index if not exists app_devices_seen_idx on public.app_devices(last_seen_at desc);

comment on table public.app_devices is
  'Устройства клиентского приложения (установка × учётная запись). Пишет только RPC app_ping, админка читает client_app_overview.';
comment on column public.app_devices.device_id is
  'Id установки — придумывает приложение и хранит на телефоне (localStorage).';
comment on column public.app_devices.sessions_count is
  'Сколько раз открывали приложение на устройстве (новое открытие — после 30 минут без активности).';

alter table public.app_devices enable row level security;
revoke all on public.app_devices from public, anon, authenticated;
grant all on public.app_devices to service_role;

-- 2. Активность по дням ------------------------------------------------------

create table if not exists public.app_activity_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  app_format text not null check (app_format in ('subscription', 'packages')),
  sessions integer not null default 1,
  screens jsonb not null default '{}'::jsonb,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (user_id, day, app_format)
);

create index if not exists app_activity_days_day_idx on public.app_activity_days(day, app_format);

comment on table public.app_activity_days is
  'День (по Тбилиси) × учётная запись × приложение: открытия и просмотры разделов (screens: {"раздел": раз}). 400 дней.';

alter table public.app_activity_days enable row level security;
revoke all on public.app_activity_days from public, anon, authenticated;
grant all on public.app_activity_days to service_role;

-- 3. Приложение сообщает о себе ---------------------------------------------

-- Текстовое поле устройства: пустое — null, длиннее n — обрезается.
create or replace function public.app_device_text(p jsonb, p_key text, p_max integer)
returns text
language sql
immutable
set search_path = public
as $$
  select left(nullif(btrim(case when jsonb_typeof(p -> p_key) in ('string', 'number')
                                then p ->> p_key end), ''), p_max)
$$;

revoke all on function public.app_device_text(jsonb, text, integer) from public, anon, authenticated;

create or replace function public.app_ping(
  p_device_id text,
  p_app_format text,
  p_device jsonb default '{}'::jsonb,
  p_screens jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_day date := (now() at time zone 'Asia/Tbilisi')::date;
  v_device jsonb := case when jsonb_typeof(p_device) = 'object' then p_device else '{}'::jsonb end;
  v_prev timestamptz;
  v_new_session boolean;
  v_screens jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_count numeric;
  v_bool_standalone boolean;
  v_bool_subscribed boolean;
  v_bool_dark boolean;
begin
  if v_uid is null then
    raise exception 'Нужен вход в приложение' using errcode = '42501';
  end if;
  if coalesce(p_device_id, '') !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Неверный id устройства' using errcode = '22023';
  end if;
  if p_app_format is null or p_app_format not in ('subscription', 'packages') then
    raise exception 'Неизвестное приложение' using errcode = '22023';
  end if;

  -- Просмотры разделов с прошлого раза: ключ — латиница, 1–1000 раз,
  -- не больше 30 разделов за раз (остальное отбрасывается).
  if jsonb_typeof(p_screens) = 'object' then
    for v_key, v_value in
      select key, value from jsonb_each(p_screens) order by key limit 30
    loop
      continue when v_key !~ '^[a-z][a-z0-9_-]{0,31}$' or jsonb_typeof(v_value) <> 'number';
      v_count := floor((v_value #>> '{}')::numeric);
      continue when v_count < 1;
      v_screens := v_screens || jsonb_build_object(v_key, least(v_count, 1000)::integer);
    end loop;
  end if;

  v_bool_standalone := case when jsonb_typeof(v_device -> 'standalone') = 'boolean'
                            then (v_device ->> 'standalone')::boolean end;
  v_bool_subscribed := case when jsonb_typeof(v_device -> 'push_subscribed') = 'boolean'
                            then (v_device ->> 'push_subscribed')::boolean end;
  v_bool_dark := case when jsonb_typeof(v_device -> 'dark_mode') = 'boolean'
                      then (v_device ->> 'dark_mode')::boolean end;

  select d.last_seen_at into v_prev
    from public.app_devices d
   where d.user_id = v_uid and d.device_id = p_device_id
   for update;
  -- Новое открытие — первый раз или после 30 минут без активности.
  v_new_session := v_prev is null or v_prev < v_now - interval '30 minutes';

  insert into public.app_devices as d (
    user_id, device_id, app_format, platform, os_name, os_version, device_model,
    browser, browser_version, app_version, standalone, push_permission,
    push_subscribed, locale, device_language, timezone, screen, dark_mode,
    user_agent, sessions_count, first_seen_at, last_seen_at
  ) values (
    v_uid,
    p_device_id,
    p_app_format,
    case when v_device ->> 'platform' in ('ios', 'android', 'other') then v_device ->> 'platform' end,
    public.app_device_text(v_device, 'os_name', 40),
    public.app_device_text(v_device, 'os_version', 40),
    public.app_device_text(v_device, 'device_model', 80),
    public.app_device_text(v_device, 'browser', 60),
    public.app_device_text(v_device, 'browser_version', 40),
    public.app_device_text(v_device, 'app_version', 20),
    v_bool_standalone,
    case when v_device ->> 'push_permission' in ('granted', 'denied', 'default', 'unsupported')
         then v_device ->> 'push_permission' end,
    v_bool_subscribed,
    case when v_device ->> 'locale' in ('en', 'ka', 'ru') then v_device ->> 'locale' end,
    public.app_device_text(v_device, 'device_language', 35),
    public.app_device_text(v_device, 'timezone', 60),
    public.app_device_text(v_device, 'screen', 40),
    v_bool_dark,
    public.app_device_text(v_device, 'user_agent', 400),
    1,
    v_now,
    v_now
  )
  on conflict (user_id, device_id) do update
    set app_format = excluded.app_format,
        platform = coalesce(excluded.platform, d.platform),
        os_name = coalesce(excluded.os_name, d.os_name),
        os_version = coalesce(excluded.os_version, d.os_version),
        device_model = coalesce(excluded.device_model, d.device_model),
        browser = coalesce(excluded.browser, d.browser),
        browser_version = coalesce(excluded.browser_version, d.browser_version),
        app_version = coalesce(excluded.app_version, d.app_version),
        standalone = coalesce(excluded.standalone, d.standalone),
        push_permission = coalesce(excluded.push_permission, d.push_permission),
        push_subscribed = coalesce(excluded.push_subscribed, d.push_subscribed),
        locale = coalesce(excluded.locale, d.locale),
        device_language = coalesce(excluded.device_language, d.device_language),
        timezone = coalesce(excluded.timezone, d.timezone),
        screen = coalesce(excluded.screen, d.screen),
        dark_mode = coalesce(excluded.dark_mode, d.dark_mode),
        user_agent = coalesce(excluded.user_agent, d.user_agent),
        sessions_count = d.sessions_count + case when v_new_session then 1 else 0 end,
        last_seen_at = v_now;

  -- День: первая активность за день — уже открытие (и в продолжение
  -- вчерашнего), дальше — каждое новое открытие; разделы складываются.
  insert into public.app_activity_days as a (user_id, day, app_format, sessions, screens, first_at, last_at)
  values (v_uid, v_day, p_app_format, 1, v_screens, v_now, v_now)
  on conflict (user_id, day, app_format) do update
    set sessions = a.sessions + case when v_new_session then 1 else 0 end,
        screens = (
          select coalesce(jsonb_object_agg(s.key, s.total), '{}'::jsonb)
            from (
              select key, sum(value::integer)::integer as total
                from (
                  select key, value from jsonb_each_text(a.screens)
                  union all
                  select key, value from jsonb_each_text(excluded.screens)
                ) both_sides
               group by key
            ) s
        ),
        last_at = v_now;

  -- Не больше 10 устройств на учётную запись, история — 400 дней.
  delete from public.app_devices
   where user_id = v_uid
     and id not in (
       select id from public.app_devices
        where user_id = v_uid
        order by last_seen_at desc
        limit 10
     );
  delete from public.app_activity_days
   where user_id = v_uid and day < v_day - 400;
end;
$$;

revoke all on function public.app_ping(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.app_ping(text, text, jsonb, jsonb) to authenticated;

-- 4. Сводка для карточки клиента -------------------------------------------

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
  if not public.is_trainer(auth.uid(), v_studio) then
    raise exception 'Нет доступа к клиенту' using errcode = '42501';
  end if;
  if v_user is null then
    return jsonb_build_object('has_account', false, 'app_format', v_format);
  end if;

  -- Карточки этого человека в клубах, где вызывающий — сотрудник.
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_cards
    from public.clients c
   where c.user_id = v_user and public.is_trainer(auth.uid(), c.studio_id);

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

-- 5. Последняя карточка удалена — устройства и активность уходят -------------

create or replace function public.clients_app_activity_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is not null
     and not exists (select 1 from public.clients where user_id = old.user_id) then
    delete from public.app_devices where user_id = old.user_id;
    delete from public.app_activity_days where user_id = old.user_id;
  end if;
  return old;
end;
$$;

revoke all on function public.clients_app_activity_cleanup() from public, anon, authenticated;

drop trigger if exists clients_app_activity_cleanup_ad on public.clients;
create trigger clients_app_activity_cleanup_ad
  after delete on public.clients
  for each row execute function public.clients_app_activity_cleanup();

notify pgrst, 'reload schema';
