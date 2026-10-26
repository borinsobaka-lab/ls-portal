-- ============================================================================
-- Пуш-уведомления: настоящая рассылка (решение владельца 2026-10-15).
--
-- Стандарт Web Push (RFC 8030/8291/8292) с ключами VAPID — без сторонних
-- сервисов: браузеры сами держат свои службы доставки (Google — Chrome и
-- Android, Apple — iOS 16.4+ для приложений «На экран „Домой“»). Отправляет
-- сервер админки (apps/admin/src/lib/push/), он же раз в 15 секунд берёт
-- запланированные.
--
-- 1) push_vapid_keys — пара ключей VAPID (одна строка). Создаёт сервер
--    админки при первом запуске; закрытый ключ — только service_role,
--    открытый клиенты читают RPC push_public_key(). Ключи не менять: все
--    подписки устройств привязаны к открытому ключу.
-- 2) push_subscriptions — подписка устройства (адрес службы доставки и ключи
--    шифрования): строка на устройство, язык приложения на нём (en/ka/ru —
--    на нём и придёт пуш) и формат приложения. Пишет только RPC
--    register_push_subscription / unregister_push_subscription; адрес —
--    только известных служб (push_endpoint_allowed), не больше 10 устройств
--    на учётную запись.
-- 3) push_notifications: статус 'sending' (идёт рассылка), счётчики
--    recipients_count (клиентов в выборке с приложением), devices_count
--    (устройств), failed_count (не принято службой), finished_at. Статус
--    sending/sent и счётчики ставит только сервер (триггер
--    push_notifications_guard): из админки — черновик или запланированное
--    («Отправить сейчас» = запланировано на сейчас), отправленное не меняется
--    (кроме своих клубов в списке).
-- 4) push_recipients — кому ушло уведомление (снимок выборки на момент
--    отправки) и когда прочитано: лента «Уведомления» приложения
--    (RPC my_push_inbox, push_mark_read).
-- 5) push_deliveries — очередь доставки (уведомление × устройство): сервер
--    забирает пачками (push_claim_deliveries, skip locked — два контейнера
--    при выкатке не отправят дважды), отчитывается push_finish_deliveries;
--    устройство подтверждает показ и нажатие (push_delivery_ack через
--    /api/push-ack клиентского приложения).
-- 6) При удалении последней карточки клиента — его подписки и лента
--    (clients_push_cleanup_ad).
--
-- Разово: прежние «запланированные» (рассылки не было — это проверки формы)
-- становятся черновиками, иначе сервер разослал бы их сразу после выкатки.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Ключи VAPID -------------------------------------------------------------

create table if not exists public.push_vapid_keys (
  id boolean primary key default true check (id),
  -- base64url несжатой точки P-256 (65 байт) — applicationServerKey подписки.
  public_key text not null,
  -- Закрытый ключ ECDSA P-256 в JWK — подпись токена VAPID.
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.push_vapid_keys enable row level security;
revoke all on public.push_vapid_keys from public, anon, authenticated;
grant all on public.push_vapid_keys to service_role;

create or replace function public.push_public_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public_key from public.push_vapid_keys where id
$$;

revoke all on function public.push_public_key() from public;
grant execute on function public.push_public_key() to anon, authenticated, service_role;

-- 2. Подписки устройств ------------------------------------------------------

-- Службы доставки браузеров: Google (Chrome, Android, Samsung Internet),
-- Apple (iOS, Safari), Mozilla, Microsoft. Чужой адрес сервер не трогает —
-- иначе любой вошедший заставил бы его слать запросы куда угодно.
create or replace function public.push_endpoint_allowed(_endpoint text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    length(_endpoint) <= 1024
    and _endpoint ~* '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)(:443)?/',
    false
  )
$$;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  locale text not null default 'en' check (locale in ('en', 'ka', 'ru')),
  app_format text check (app_format in ('subscription', 'packages')),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant all on public.push_subscriptions to service_role;

-- Устройство вошедшего: новое или прежнее (адрес тот же — переходит к
-- тому, кто вошёл на телефоне сейчас; язык обновляется).
create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_locale text,
  p_app_format text default null,
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
  if v_uid is null then
    raise exception 'Нужен вход в приложение' using errcode = '42501';
  end if;
  if not public.push_endpoint_allowed(p_endpoint) then
    raise exception 'Неизвестная служба уведомлений' using errcode = '22023';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_+/=-]{80,100}$'
     or coalesce(p_auth, '') !~ '^[A-Za-z0-9_+/=-]{16,32}$' then
    raise exception 'Неверные ключи подписки' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, locale, app_format, user_agent)
  values (
    v_uid,
    p_endpoint,
    p_p256dh,
    p_auth,
    case when p_locale in ('en', 'ka', 'ru') then p_locale else 'en' end,
    case when p_app_format in ('subscription', 'packages') then p_app_format end,
    left(p_user_agent, 300)
  )
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        locale = excluded.locale,
        app_format = excluded.app_format,
        user_agent = excluded.user_agent,
        updated_at = now();

  -- Не больше 10 устройств: старые подписки отваливаются первыми.
  delete from public.push_subscriptions
   where user_id = v_uid
     and id not in (
       select id from public.push_subscriptions
        where user_id = v_uid
        order by updated_at desc
        limit 10
     );
end;
$$;

revoke all on function public.register_push_subscription(text, text, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text, text, text) to authenticated;

-- Выход из приложения: устройство больше не получает пуши этого человека.
create or replace function public.unregister_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid()
$$;

revoke all on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.unregister_push_subscription(text) to authenticated;

-- 3. Уведомления: статус рассылки и счётчики --------------------------------

do $$
begin
  -- Первый запуск миграции: «запланированные» до неё — проверки формы.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'push_notifications'
       and column_name = 'recipients_count'
  ) then
    update public.push_notifications set status = 'draft' where status = 'scheduled';
  end if;
end;
$$;

alter table public.push_notifications
  add column if not exists recipients_count integer not null default 0,
  add column if not exists devices_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists finished_at timestamptz;

alter table public.push_notifications drop constraint if exists push_notifications_status_check;
alter table public.push_notifications
  add constraint push_notifications_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent'));

create index if not exists push_notifications_due_idx
  on public.push_notifications(scheduled_at) where status = 'scheduled';

comment on column public.push_notifications.recipients_count is
  'Клиентов в выборке с учётной записью приложения (на момент отправки).';
comment on column public.push_notifications.devices_count is
  'Устройств с включёнными уведомлениями у этих клиентов.';
comment on column public.push_notifications.sent_count is
  'Устройств, чья служба доставки приняла пуш.';
comment on column public.push_notifications.delivered_count is
  'Устройств, показавших пуш (подтверждение от приложения).';
comment on column public.push_notifications.read_count is
  'Клиентов, открывших уведомление: нажали на пуш или открыли в ленте приложения.';

-- Запись из админки (роль authenticated): статусы рассылки и счётчики ведёт
-- только сервер. Функция без security definer: current_user — роль запроса
-- (authenticated из PostgREST; владелец функции — в RPC рассылки и в
-- триггерах, service_role — сервер).
create or replace function public.push_notifications_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'scheduled') then
      raise exception 'Новое уведомление сохраняется черновиком или запланированным'
        using errcode = '22023';
    end if;
    new.sent_at := null;
    new.finished_at := null;
    new.recipients_count := 0;
    new.devices_count := 0;
    new.sent_count := 0;
    new.delivered_count := 0;
    new.read_count := 0;
    new.failed_count := 0;
  else
    new.sent_at := old.sent_at;
    new.finished_at := old.finished_at;
    new.recipients_count := old.recipients_count;
    new.devices_count := old.devices_count;
    new.sent_count := old.sent_count;
    new.delivered_count := old.delivered_count;
    new.read_count := old.read_count;
    new.failed_count := old.failed_count;

    if old.status in ('sending', 'sent') then
      if new.status is distinct from old.status
         or new.title is distinct from old.title
         or new.message is distinct from old.message
         or new.action_url is distinct from old.action_url
         or new.translations is distinct from old.translations
         or new.segments is distinct from old.segments
         or new.scheduled_at is distinct from old.scheduled_at then
        raise exception 'Уведомление уже отправлено — изменить его нельзя'
          using errcode = '22023';
      end if;
    elsif new.status not in ('draft', 'scheduled') then
      raise exception 'Уведомления отправляет сервер: сохраните уведомление запланированным'
        using errcode = '22023';
    end if;
  end if;

  if new.status = 'scheduled' and new.scheduled_at is null then
    new.scheduled_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists push_notifications_guard on public.push_notifications;
create trigger push_notifications_guard
  before insert or update on public.push_notifications
  for each row execute function public.push_notifications_guard();

-- 4. Получатели (лента «Уведомления» приложения) ------------------------------

create table if not exists public.push_recipients (
  notification_id uuid not null references public.push_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (notification_id, user_id)
);

create index if not exists push_recipients_user_idx
  on public.push_recipients(user_id, created_at desc);

alter table public.push_recipients enable row level security;
revoke all on public.push_recipients from public, anon, authenticated;
grant all on public.push_recipients to service_role;

-- 5. Очередь доставки ---------------------------------------------------------

create table if not exists public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.push_notifications(id) on delete cascade,
  -- Подписка удалена (служба ответила «устройства больше нет», выход) —
  -- строка уходит вместе с ней.
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (notification_id, subscription_id)
);

create index if not exists push_deliveries_queue_idx
  on public.push_deliveries(created_at) where status in ('pending', 'sending');
create index if not exists push_deliveries_subscription_idx
  on public.push_deliveries(subscription_id);

alter table public.push_deliveries enable row level security;
revoke all on public.push_deliveries from public, anon, authenticated;
grant all on public.push_deliveries to service_role;

-- Наступившие запланированные → выборка получателей и очередь доставки.
-- Возвращает, сколько уведомлений начато. Только сервер.
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

    insert into public.push_deliveries (notification_id, subscription_id, user_id)
    select r.id, s.id, s.user_id
      from public.push_recipients pr
      join public.push_subscriptions s on s.user_id = pr.user_id
     where pr.notification_id = r.id
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

-- Пачка доставок серверу: ждущие и зависшие (сервер упал посреди пачки —
-- через 10 минут их заберёт снова, не больше 5 попыток). skip locked — два
-- сервера берут разные строки.
create or replace function public.push_claim_deliveries(p_limit integer default 200)
returns table (
  delivery_id uuid,
  notification_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  locale text,
  app_format text
)
language sql
security definer
set search_path = public
as $$
  with picked as (
    select d.id
      from public.push_deliveries d
     where d.status = 'pending'
        or (d.status = 'sending' and d.claimed_at < now() - interval '10 minutes' and d.attempts < 5)
     order by d.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update skip locked
  ),
  upd as (
    update public.push_deliveries d
       set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
      from picked
     where d.id = picked.id
    returning d.id, d.notification_id, d.subscription_id
  )
  select upd.id, upd.notification_id, s.endpoint, s.p256dh, s.auth, s.locale, s.app_format
    from upd
    join public.push_subscriptions s on s.id = upd.subscription_id
$$;

-- Итог пачки: [{"id": uuid, "result": "sent"|"retry"|"failed"|"gone", "error": text}].
-- gone — устройства больше нет (404/410): подписка удаляется.
create or replace function public.push_finish_deliveries(p_results jsonb)
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
    update public.push_deliveries d
       set status = case
             when res.result = 'sent' then 'sent'
             when res.result = 'retry' and d.attempts < 5 then 'pending'
             else 'failed'
           end,
           sent_at = case when res.result = 'sent' then now() else d.sent_at end,
           error = case when res.result = 'sent' then null else res.error end
      from res
     where d.id = res.id and d.status = 'sending'
    returning d.notification_id, d.subscription_id, d.status, res.result
  ),
  counts as (
    update public.push_notifications n
       set sent_count = n.sent_count + c.sent,
           failed_count = n.failed_count + c.failed
      from (
        select upd.notification_id,
               count(*) filter (where upd.status = 'sent') as sent,
               count(*) filter (where upd.status = 'failed') as failed
          from upd
         group by upd.notification_id
      ) c
     where n.id = c.notification_id
    returning n.id
  )
  select array_agg(distinct upd.subscription_id) filter (where upd.result = 'gone')
    into v_gone
    from upd;

  if v_gone is not null then
    delete from public.push_subscriptions where id = any(v_gone);
  end if;

  perform public.push_finalize();
end;
$$;

-- Рассылки без ждущих доставок — отправлены. Зависшие после 5 попыток —
-- неудачные.
create or replace function public.push_finalize()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done integer;
begin
  with dead as (
    update public.push_deliveries
       set status = 'failed', error = coalesce(error, 'Нет ответа')
     where status = 'sending'
       and claimed_at < now() - interval '10 minutes'
       and attempts >= 5
    returning notification_id
  )
  update public.push_notifications n
     set failed_count = n.failed_count + c.cnt
    from (select notification_id, count(*) as cnt from dead group by notification_id) c
   where n.id = c.notification_id;

  update public.push_notifications n
     set status = 'sent', finished_at = now(), updated_at = now()
   where n.status = 'sending'
     and not exists (
       select 1 from public.push_deliveries d
        where d.notification_id = n.id and d.status in ('pending', 'sending')
     );
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

revoke all on function public.push_start_due() from public, anon, authenticated;
revoke all on function public.push_claim_deliveries(integer) from public, anon, authenticated;
revoke all on function public.push_finish_deliveries(jsonb) from public, anon, authenticated;
revoke all on function public.push_finalize() from public, anon, authenticated;
grant execute on function public.push_start_due() to service_role;
grant execute on function public.push_claim_deliveries(integer) to service_role;
grant execute on function public.push_finish_deliveries(jsonb) to service_role;
grant execute on function public.push_finalize() to service_role;

-- Подтверждение с устройства (service worker → /api/push-ack клиентского
-- приложения): пуш показан / на него нажали. id доставки — случайный uuid из
-- самого пуша, он и есть пропуск; повтор ничего не меняет.
create or replace function public.push_delivery_ack(p_id uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notification uuid;
  v_user uuid;
begin
  if p_id is null or p_event not in ('delivered', 'clicked') then
    return;
  end if;

  update public.push_deliveries
     set delivered_at = now()
   where id = p_id and delivered_at is null
  returning notification_id into v_notification;
  if found then
    update public.push_notifications
       set delivered_count = delivered_count + 1
     where id = v_notification;
  end if;

  if p_event = 'clicked' then
    update public.push_deliveries
       set clicked_at = coalesce(clicked_at, now())
     where id = p_id
    returning notification_id, user_id into v_notification, v_user;
    if found then
      update public.push_recipients
         set read_at = now()
       where notification_id = v_notification and user_id = v_user and read_at is null;
      if found then
        update public.push_notifications
           set read_count = read_count + 1
         where id = v_notification;
      end if;
    end if;
  end if;
end;
$$;

revoke all on function public.push_delivery_ack(uuid, text) from public;
grant execute on function public.push_delivery_ack(uuid, text) to anon, authenticated, service_role;

-- 6. Лента клиента ------------------------------------------------------------

create or replace function public.my_push_inbox(p_limit integer default 100)
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
   order by coalesce(n.sent_at, r.created_at) desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

revoke all on function public.my_push_inbox(integer) from public, anon;
grant execute on function public.my_push_inbox(integer) to authenticated;

-- Прочитано в ленте: перечисленные (null — все). Возвращает, сколько отмечено.
create or replace function public.push_mark_read(p_ids uuid[] default null)
returns integer
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.push_recipients
       set read_at = now()
     where user_id = auth.uid()
       and read_at is null
       and (p_ids is null or notification_id = any(p_ids))
    returning notification_id
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

revoke all on function public.push_mark_read(uuid[]) from public, anon;
grant execute on function public.push_mark_read(uuid[]) to authenticated;

-- 7. Охват для формы админки ---------------------------------------------------

-- Сколько клиентов попадёт в рассылку: карточек в выборке, из них с
-- приложением, из них с включёнными уведомлениями. Только свои клубы и
-- только с разделом «Мобильное приложение».
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
    select c.id, c.user_id
      from public.clients_with_status c
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
           where exists (select 1 from public.push_subscriptions ps where ps.user_id = u.user_id))::integer
$$;

revoke all on function public.push_audience_stats(uuid[], text[]) from public, anon;
grant execute on function public.push_audience_stats(uuid[], text[]) to authenticated;

-- 8. Удаление клиента ----------------------------------------------------------

-- Последняя карточка удалена — подписки устройств и лента уходят (учётная
-- запись могла остаться — у сотрудника).
create or replace function public.clients_push_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is not null
     and not exists (select 1 from public.clients where user_id = old.user_id) then
    delete from public.push_subscriptions where user_id = old.user_id;
    delete from public.push_recipients where user_id = old.user_id;
  end if;
  return old;
end;
$$;

drop trigger if exists clients_push_cleanup_ad on public.clients;
create trigger clients_push_cleanup_ad
  after delete on public.clients
  for each row execute function public.clients_push_cleanup();

notify pgrst, 'reload schema';
