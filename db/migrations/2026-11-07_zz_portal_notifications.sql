-- ============================================================================
-- Уведомления портала, пуши сотрудникам, «в сети» и справочник «Компания»
-- (решения владельца 2026-11-07, TASKS_CHATS_PLAN.md, веха 1).
--
-- Фундамент для чатов и задач: всё, что должно дойти до человека, идёт через
-- одну функцию notif_send — она пишет строку ленты (колокольчик в шапке) и,
-- если человек не против, ставит пуш на его устройства в очередь.
--
-- 1) portal_user_settings — личные настройки человека портала: часовой пояс
--    (по умолчанию Москва — сроки задач и «тихие часы» считаются в нём),
--    конец рабочего дня, пуши по видам событий (prefs: {"<вид>": {"push":
--    false}} — только отличия от умолчаний), «Не беспокоить» разово
--    (dnd_until) и по расписанию (quiet_*: с — до, и выходные).
-- 2) notif_items — лента уведомлений человека. group_key — одно
--    непрочитанное на ключ (новые сообщения одного чата не плодят строки:
--    count + 1, текст — последний). Хранится 90 дней (notif_housekeeping).
-- 3) portal_push_subscriptions — браузеры и телефоны сотрудников (Web Push,
--    тот же стандарт и те же ключи VAPID, что у клиентских приложений —
--    push_vapid_keys; клиентские подписки — push_subscriptions, у них своё
--    приложение и своя лента). Пишут только RPC portal_push_register /
--    portal_push_unregister; адрес — только служб браузеров
--    (push_endpoint_allowed), не больше 10 устройств.
-- 4) portal_push_deliveries — очередь доставки (уведомление × устройство):
--    сервер портала забирает пачками (portal_push_claim, skip locked) раз в
--    пару секунд и отчитывается portal_push_finish.
-- 5) portal_presence — пульс открытой вкладки (portal_ping раз в минуту):
--    «в сети» (последний пульс за 2 минуты), «был …», и активна ли вкладка
--    сейчас — тогда пуш не нужен, человек и так видит колокольчик.
-- 6) Справочник «Компания» — company_people (все действующие люди портала:
--    должность, подразделения, клубы и города, «в сети») и company_structure
--    (подразделения с руководителями, заместителями и составом). Партнёры
--    видят друг друга (решение владельца 2026-11-07) — любому человеку
--    портала.
--
-- Все таблицы закрыты браузеру, только RPC. Идемпотентно.
-- ============================================================================

-- 1. Личные настройки ---------------------------------------------------------

create table if not exists public.portal_user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'Europe/Moscow',
  workday_end time not null default '18:00',
  prefs jsonb not null default '{}'::jsonb,
  dnd_until timestamptz,
  quiet_enabled boolean not null default false,
  quiet_from time not null default '21:00',
  quiet_to time not null default '09:00',
  quiet_weekends boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint portal_user_settings_prefs_check check (jsonb_typeof(prefs) = 'object'),
  constraint portal_user_settings_tz_check check (char_length(timezone) between 1 and 64)
);

alter table public.portal_user_settings enable row level security;
revoke all on public.portal_user_settings from public, anon, authenticated;
grant all on public.portal_user_settings to service_role;

-- Часовой пояс есть в базе Postgres (иначе — Москва).
create or replace function public.portal_tz_valid(p_tz text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from pg_timezone_names where name = p_tz)
$$;

create or replace function public.portal_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s public.portal_user_settings;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into s from public.portal_user_settings where user_id = v_uid;
  return jsonb_build_object(
    'timezone', coalesce(s.timezone, 'Europe/Moscow'),
    'workday_end', to_char(coalesce(s.workday_end, '18:00'::time), 'HH24:MI'),
    'prefs', coalesce(s.prefs, '{}'::jsonb),
    'dnd_until', s.dnd_until,
    'quiet_enabled', coalesce(s.quiet_enabled, false),
    'quiet_from', to_char(coalesce(s.quiet_from, '21:00'::time), 'HH24:MI'),
    'quiet_to', to_char(coalesce(s.quiet_to, '09:00'::time), 'HH24:MI'),
    'quiet_weekends', coalesce(s.quiet_weekends, false)
  );
end;
$$;

-- Сохранить настройки: только переданные ключи. prefs — целиком (интерфейс
-- шлёт все отличия от умолчаний), значения — {"push": boolean}.
create or replace function public.portal_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prefs jsonb;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p ? 'timezone' and not public.portal_tz_valid(p->>'timezone') then
    raise exception 'bad_timezone' using errcode = '22023';
  end if;
  if p ? 'prefs' then
    if jsonb_typeof(p->'prefs') <> 'object' then
      raise exception 'bad_prefs' using errcode = '22023';
    end if;
    select coalesce(jsonb_object_agg(k, jsonb_build_object('push', (v->>'push')::boolean)), '{}'::jsonb)
      into v_prefs
      from jsonb_each(p->'prefs') as e(k, v)
     where char_length(k) <= 60
       and jsonb_typeof(v) = 'object'
       and jsonb_typeof(v->'push') = 'boolean';
  end if;

  insert into public.portal_user_settings (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  update public.portal_user_settings s
     set timezone = case when p ? 'timezone' then p->>'timezone' else s.timezone end,
         workday_end = case when p ? 'workday_end' then (p->>'workday_end')::time else s.workday_end end,
         prefs = case when p ? 'prefs' then v_prefs else s.prefs end,
         dnd_until = case when p ? 'dnd_until' then nullif(p->>'dnd_until', '')::timestamptz else s.dnd_until end,
         quiet_enabled = case when p ? 'quiet_enabled' then (p->>'quiet_enabled')::boolean else s.quiet_enabled end,
         quiet_from = case when p ? 'quiet_from' then (p->>'quiet_from')::time else s.quiet_from end,
         quiet_to = case when p ? 'quiet_to' then (p->>'quiet_to')::time else s.quiet_to end,
         quiet_weekends = case when p ? 'quiet_weekends' then (p->>'quiet_weekends')::boolean else s.quiet_weekends end,
         updated_at = now()
   where s.user_id = v_uid;

  return public.portal_settings_get();
end;
$$;

-- 2. «В сети» ------------------------------------------------------------------

create table if not exists public.portal_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  -- Последний пульс из активной (видимой и в фокусе) вкладки.
  last_active_at timestamptz
);

alter table public.portal_presence enable row level security;
revoke all on public.portal_presence from public, anon, authenticated;
grant all on public.portal_presence to service_role;

-- Пульс открытой вкладки портала: раз в минуту и при возврате во вкладку.
create or replace function public.portal_ping(p_active boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    return;
  end if;
  insert into public.portal_presence as pp (user_id, last_seen_at, last_active_at)
  values (v_uid, now(), case when p_active then now() end)
  on conflict (user_id) do update
    set last_seen_at = now(),
        last_active_at = case when p_active then now() else pp.last_active_at end;
end;
$$;

-- Человек сейчас смотрит на портал (активная вкладка за последние 70 секунд):
-- пуш не нужен.
create or replace function public.portal_is_watching(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.portal_presence
     where user_id = p_user and last_active_at > now() - interval '70 seconds'
  )
$$;

-- 3. Лента уведомлений ---------------------------------------------------------

create table if not exists public.notif_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 60),
  title text not null check (char_length(title) between 1 and 300),
  body text check (body is null or char_length(body) <= 1000),
  -- Путь внутри портала ('/chats/…', '/tasks/…').
  url text check (url is null or (char_length(url) <= 1000 and url like '/%')),
  actor_id uuid references auth.users (id) on delete set null,
  group_key text check (group_key is null or char_length(group_key) <= 200),
  count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notif_items_user_idx on public.notif_items (user_id, updated_at desc);
create index if not exists notif_items_unread_idx on public.notif_items (user_id) where read_at is null;
create unique index if not exists notif_items_group_uidx
  on public.notif_items (user_id, group_key) where read_at is null and group_key is not null;

alter table public.notif_items enable row level security;
revoke all on public.notif_items from public, anon, authenticated;
grant all on public.notif_items to service_role;

-- Пуш по умолчанию у вида события. Каталог видов и подписи — в админке
-- (apps/admin/src/lib/notifications/kinds.ts, тест сверяет умолчания с
-- этой функцией). Вид не из списка — пуш есть.
create or replace function public.notif_default_push(p_kind text)
returns boolean
language sql
immutable
as $$
  select p_kind not in ('chat.group')
$$;

-- Пуш сейчас разрешён человеку: вид не выключен, нет «Не беспокоить», не
-- тихие часы в его поясе.
create or replace function public.notif_push_allowed(p_user uuid, p_kind text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.portal_user_settings;
  v_local timestamp;
  v_t time;
begin
  select * into s from public.portal_user_settings where user_id = p_user;
  if not found then
    return public.notif_default_push(p_kind);
  end if;
  if not coalesce((s.prefs -> p_kind ->> 'push')::boolean, public.notif_default_push(p_kind)) then
    return false;
  end if;
  if s.dnd_until is not null and s.dnd_until > now() then
    return false;
  end if;
  if s.quiet_enabled then
    v_local := now() at time zone (case when public.portal_tz_valid(s.timezone) then s.timezone else 'Europe/Moscow' end);
    if s.quiet_weekends and extract(isodow from v_local) in (6, 7) then
      return false;
    end if;
    v_t := v_local::time;
    if s.quiet_from = s.quiet_to then
      return true;
    elsif s.quiet_from < s.quiet_to then
      if v_t >= s.quiet_from and v_t < s.quiet_to then return false; end if;
    else
      -- Через полночь: 21:00–09:00.
      if v_t >= s.quiet_from or v_t < s.quiet_to then return false; end if;
    end if;
  end if;
  return true;
end;
$$;

-- 4. Устройства для пушей ------------------------------------------------------

create table if not exists public.portal_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz
);

create index if not exists portal_push_subscriptions_user_idx
  on public.portal_push_subscriptions (user_id);

alter table public.portal_push_subscriptions enable row level security;
revoke all on public.portal_push_subscriptions from public, anon, authenticated;
grant all on public.portal_push_subscriptions to service_role;

create table if not exists public.portal_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notif_id uuid not null references public.notif_items (id) on delete cascade,
  subscription_id uuid not null references public.portal_push_subscriptions (id) on delete cascade,
  user_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists portal_push_deliveries_queue_idx
  on public.portal_push_deliveries (created_at) where status in ('pending', 'sending');
create index if not exists portal_push_deliveries_sub_idx
  on public.portal_push_deliveries (subscription_id);
create index if not exists portal_push_deliveries_notif_idx
  on public.portal_push_deliveries (notif_id);

alter table public.portal_push_deliveries enable row level security;
revoke all on public.portal_push_deliveries from public, anon, authenticated;
grant all on public.portal_push_deliveries to service_role;

-- Устройство вошедшего: новое или прежнее (тот же адрес — переходит к тому,
-- кто вошёл в браузере сейчас).
create or replace function public.portal_push_register(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.push_endpoint_allowed(p_endpoint) then
    raise exception 'push_endpoint_unknown' using errcode = '22023';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_+/=-]{80,100}$'
     or coalesce(p_auth, '') !~ '^[A-Za-z0-9_+/=-]{16,32}$' then
    raise exception 'push_keys_invalid' using errcode = '22023';
  end if;

  insert into public.portal_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        updated_at = now();

  delete from public.portal_push_subscriptions
   where user_id = v_uid
     and id not in (
       select id from public.portal_push_subscriptions
        where user_id = v_uid
        order by updated_at desc
        limit 10
     );
end;
$$;

create or replace function public.portal_push_unregister(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.portal_push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- Свои устройства (настройки уведомлений): без адресов и ключей.
create or replace function public.portal_push_devices()
returns table (id uuid, user_agent text, created_at timestamptz, last_sent_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_agent, s.created_at, s.last_sent_at
    from public.portal_push_subscriptions s
   where s.user_id = auth.uid()
   order by s.updated_at desc
$$;

create or replace function public.portal_push_device_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.portal_push_subscriptions where id = p_id and user_id = auth.uid()
$$;

-- 5. Отправить уведомление -----------------------------------------------------

-- Одна точка для всех разделов (чаты, задачи, база знаний, Академия…).
-- Вызывают другие функции базы — браузеру не выдана. Сам себе — не шлёт.
-- p_force_push — проверочный пуш: без учёта настроек и «в сети».
-- Возвращает id строки ленты (null — не отправлено).
create or replace function public.notif_send(
  p_user uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_url text default null,
  p_actor uuid default null,
  p_group_key text default null,
  p_force_push boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_title text := left(coalesce(nullif(btrim(p_title), ''), 'Уведомление'), 300);
  v_body text := left(nullif(btrim(p_body), ''), 1000);
  v_url text := case when p_url like '/%' then left(p_url, 1000) end;
begin
  if p_user is null or (p_actor is not null and p_actor = p_user) then
    return null;
  end if;
  if not public.is_portal_user(p_user) then
    return null;
  end if;

  if p_group_key is not null then
    update public.notif_items n
       set title = v_title,
           body = v_body,
           url = coalesce(v_url, n.url),
           actor_id = p_actor,
           count = n.count + 1,
           updated_at = now()
     where n.user_id = p_user and n.group_key = p_group_key and n.read_at is null
    returning n.id into v_id;
  end if;

  if v_id is null then
    insert into public.notif_items (user_id, kind, title, body, url, actor_id, group_key)
    values (p_user, p_kind, v_title, v_body, v_url, p_actor, left(p_group_key, 200))
    returning id into v_id;
  end if;

  if p_force_push
     or (public.notif_push_allowed(p_user, p_kind) and not public.portal_is_watching(p_user)) then
    insert into public.portal_push_deliveries (notif_id, subscription_id, user_id)
    select v_id, s.id, s.user_id
      from public.portal_push_subscriptions s
     where s.user_id = p_user;
  end if;
  return v_id;
end;
$$;

-- Проверочный пуш себе (кнопка в настройках уведомлений). Не чаще раза в 10
-- секунд.
create or replace function public.notif_test()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_devices integer;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.notif_items
              where user_id = v_uid and kind = 'test' and created_at > now() - interval '10 seconds') then
    raise exception 'notif_test_rate_limit' using errcode = '54000';
  end if;
  v_id := public.notif_send(v_uid, 'test', 'Проверка уведомлений',
                            'Если вы это видите — уведомления работают.', '/notifications',
                            null, null, true);
  select count(*)::int into v_devices from public.portal_push_deliveries where notif_id = v_id;
  return v_devices;
end;
$$;

-- 6. Лента: чтение и «прочитано» ------------------------------------------------

create or replace function public.notif_list(
  p_before timestamptz default null,
  p_limit integer default 50,
  p_unread_only boolean default false
)
returns table (
  id uuid,
  kind text,
  title text,
  body text,
  url text,
  actor_id uuid,
  actor_name text,
  actor_avatar text,
  count integer,
  created_at timestamptz,
  updated_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.kind, n.title, n.body, n.url, n.actor_id,
         nullif(btrim(p.full_name), ''), p.avatar_url,
         n.count, n.created_at, n.updated_at, n.read_at
    from public.notif_items n
    left join public.profiles p on p.id = n.actor_id
   where n.user_id = auth.uid()
     and (p_before is null or n.updated_at < p_before)
     and (not p_unread_only or n.read_at is null)
   order by n.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

create or replace function public.notif_unread_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.notif_items where user_id = auth.uid() and read_at is null
$$;

-- Прочитать: выбранные (p_ids) или все (null).
create or replace function public.notif_mark_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.notif_items
     set read_at = now()
   where user_id = auth.uid()
     and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 7. Очередь доставки — сервер портала ----------------------------------------

create or replace function public.portal_push_claim(p_limit integer default 200)
returns table (
  delivery_id uuid,
  notif_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  title text,
  body text,
  url text,
  tag text,
  unread integer
)
language sql
security definer
set search_path = public
as $$
  with picked as (
    select d.id
      from public.portal_push_deliveries d
     where d.status = 'pending'
        or (d.status = 'sending' and d.claimed_at < now() - interval '10 minutes' and d.attempts < 5)
     order by d.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update skip locked
  ),
  upd as (
    update public.portal_push_deliveries d
       set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
      from picked
     where d.id = picked.id
    returning d.id, d.notif_id, d.subscription_id, d.user_id
  )
  select upd.id, upd.notif_id, s.endpoint, s.p256dh, s.auth,
         case when n.count > 1 then n.title || ' (' || n.count || ')' else n.title end,
         n.body, n.url, coalesce(n.group_key, n.id::text),
         (select count(*)::int from public.notif_items u where u.user_id = upd.user_id and u.read_at is null)
    from upd
    join public.portal_push_subscriptions s on s.id = upd.subscription_id
    join public.notif_items n on n.id = upd.notif_id
$$;

-- Итог пачки: [{"id": uuid, "result": "sent"|"retry"|"failed"|"gone", "error": text}].
create or replace function public.portal_push_finish(p_results jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gone uuid[];
begin
  with res as (
    select (x->>'id')::uuid as id, x->>'result' as result, left(x->>'error', 500) as error
      from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x
  ),
  upd as (
    update public.portal_push_deliveries d
       set status = case
             when res.result = 'sent' then 'sent'
             when res.result = 'retry' and d.attempts < 5 then 'pending'
             else 'failed'
           end,
           sent_at = case when res.result = 'sent' then now() else d.sent_at end,
           error = case when res.result = 'sent' then null else res.error end
      from res
     where d.id = res.id and d.status = 'sending'
    returning d.subscription_id, d.status, res.result
  ),
  touched as (
    update public.portal_push_subscriptions s
       set last_sent_at = now()
     where s.id in (select subscription_id from upd where status = 'sent')
    returning s.id
  )
  select array_agg(distinct upd.subscription_id) filter (where upd.result = 'gone')
    into v_gone
    from upd;

  if v_gone is not null then
    delete from public.portal_push_subscriptions where id = any (v_gone);
  end if;
end;
$$;

-- Раз в сутки (сервер портала): лента — 90 дней, очередь — 7 дней,
-- зависшие после 5 попыток — неудачные.
create or replace function public.notif_housekeeping()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.portal_push_deliveries
     set status = 'failed', error = coalesce(error, 'Нет ответа')
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts >= 5;
  delete from public.portal_push_deliveries where created_at < now() - interval '7 days';
  delete from public.notif_items where updated_at < now() - interval '90 days';
end;
$$;

-- 8. Справочник «Компания» ------------------------------------------------------

-- Все действующие люди портала: для списка, фильтров и «в сети».
create or replace function public.company_people()
returns table (
  user_id uuid,
  full_name text,
  avatar_url text,
  email text,
  phone text,
  user_type text,
  position_id uuid,
  position_name text,
  units jsonb,
  clubs jsonb,
  cities text[],
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_portal_user(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  with people as (select distinct x.id from public.portal_people_ids() x(id)),
  clubs as (
    select c.user_id,
           jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'city', c.city)
                     order by c.name) as clubs,
           array_remove(array_agg(distinct c.city), null) as cities
      from (
        select distinct on (ur.user_id, s.id) ur.user_id, s.id, s.name, s.city, ur.role::text as role
          from public.user_roles ur
          join public.studios s on s.id = ur.studio_id
         where ur.role in ('owner', 'admin', 'trainer')
         order by ur.user_id, s.id,
                  case ur.role when 'owner' then 0 when 'admin' then 1 else 2 end
      ) c
     group by c.user_id
  ),
  owned as (
    select so.user_id, array_remove(array_agg(distinct s.city), null) as cities
      from public.studio_owners so join public.studios s on s.id = so.studio_id
     group by so.user_id
  ),
  units as (
    select m.user_id,
           jsonb_agg(jsonb_build_object('id', ou.id, 'name', ou.name, 'role', m.member_role)
                     order by m.member_role = 'member', ou.name) as units
      from public.org_unit_members m join public.org_units ou on ou.id = m.unit_id
     group by m.user_id
  )
  select u.id,
         coalesce(nullif(btrim(p.full_name), ''), u.email::text),
         p.avatar_url,
         case when u.email::text like '%@no-email.invalid' then null
              else coalesce(nullif(btrim(p.email), ''), u.email::text) end,
         nullif(btrim(p.phone), ''),
         pu.user_type,
         pu.position_id,
         pos.name,
         coalesce(un.units, '[]'::jsonb),
         coalesce(cl.clubs, '[]'::jsonb),
         (select array(select distinct c from unnest(coalesce(cl.cities, '{}') || coalesce(ow.cities, '{}')) c
                        where c is not null and btrim(c) <> '' order by c)),
         pr.last_seen_at
    from people pp
    join auth.users u on u.id = pp.id
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
    left join clubs cl on cl.user_id = u.id
    left join owned ow on ow.user_id = u.id
    left join units un on un.user_id = u.id
    left join public.portal_presence pr on pr.user_id = u.id
   order by 2;
end;
$$;

-- Оргструктура для просмотра: подразделения деревом (parent_id, порядок) и
-- состав (только действующие люди портала).
create or replace function public.company_structure()
returns table (
  id uuid,
  parent_id uuid,
  name text,
  description text,
  sort_order integer,
  members jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_portal_user(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select ou.id, ou.parent_id, ou.name, ou.description, ou.sort_order,
         coalesce((
           select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.member_role)
                            order by case m.member_role when 'head' then 0 when 'deputy' then 1 else 2 end,
                                     p.full_name)
             from public.org_unit_members m
             left join public.profiles p on p.id = m.user_id
            where m.unit_id = ou.id and public.is_portal_user(m.user_id)
         ), '[]'::jsonb)
    from public.org_units ou
   order by ou.sort_order, ou.name;
end;
$$;

-- 9. Права на функции ----------------------------------------------------------

revoke all on function public.portal_tz_valid(text) from public, anon;
revoke all on function public.portal_settings_get() from public, anon;
revoke all on function public.portal_settings_save(jsonb) from public, anon;
revoke all on function public.portal_ping(boolean) from public, anon;
revoke all on function public.portal_is_watching(uuid) from public, anon, authenticated;
revoke all on function public.notif_push_allowed(uuid, text) from public, anon, authenticated;
revoke all on function public.portal_push_register(text, text, text, text) from public, anon;
revoke all on function public.portal_push_unregister(text) from public, anon;
revoke all on function public.portal_push_devices() from public, anon;
revoke all on function public.portal_push_device_delete(uuid) from public, anon;
revoke all on function public.notif_send(uuid, text, text, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.notif_test() from public, anon;
revoke all on function public.notif_list(timestamptz, integer, boolean) from public, anon;
revoke all on function public.notif_unread_count() from public, anon;
revoke all on function public.notif_mark_read(uuid[]) from public, anon;
revoke all on function public.portal_push_claim(integer) from public, anon, authenticated;
revoke all on function public.portal_push_finish(jsonb) from public, anon, authenticated;
revoke all on function public.notif_housekeeping() from public, anon, authenticated;
revoke all on function public.company_people() from public, anon;
revoke all on function public.company_structure() from public, anon;

grant execute on function public.portal_tz_valid(text) to authenticated;
grant execute on function public.portal_settings_get() to authenticated;
grant execute on function public.portal_settings_save(jsonb) to authenticated;
grant execute on function public.portal_ping(boolean) to authenticated;
grant execute on function public.portal_push_register(text, text, text, text) to authenticated;
grant execute on function public.portal_push_unregister(text) to authenticated;
grant execute on function public.portal_push_devices() to authenticated;
grant execute on function public.portal_push_device_delete(uuid) to authenticated;
grant execute on function public.notif_test() to authenticated;
grant execute on function public.notif_list(timestamptz, integer, boolean) to authenticated;
grant execute on function public.notif_unread_count() to authenticated;
grant execute on function public.notif_mark_read(uuid[]) to authenticated;
grant execute on function public.company_people() to authenticated;
grant execute on function public.company_structure() to authenticated;
grant execute on function public.notif_send(uuid, text, text, text, text, uuid, text, boolean) to service_role;
grant execute on function public.portal_push_claim(integer) to service_role;
grant execute on function public.portal_push_finish(jsonb) to service_role;
grant execute on function public.notif_housekeeping() to service_role;
