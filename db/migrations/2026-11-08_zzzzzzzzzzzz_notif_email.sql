-- ============================================================================
-- Уведомления портала на почту (решение владельца 2026-11-08).
--
-- У каждого вида уведомления в настройках два включателя: «Пуш» (браузер и
-- телефон, как раньше) и «Почта». Можно одно, оба или ничего; лента портала
-- («Уведомления») получает всё, как раньше.
--
-- 1) portal_user_settings.prefs: {"<вид>": {"push": bool, "email": bool}} —
--    по-прежнему только отличия от умолчаний. Почта по умолчанию выключена у
--    всех видов (решение владельца: не засорять почту тем, кто её не читает)
--    — notif_email_allowed; пуш по умолчанию — notif_default_push, как был.
-- 2) portal_email_deliveries — очередь писем: снимок заголовка, текста и
--    ссылки на момент события и адрес. Ставит notif_send_ex, отправляет
--    сервер портала (lib/notifications/portal-email-worker.server.ts) по
--    SMTP — portal_email_claim / portal_email_finish (только service_role).
-- 3) Когда письмо НЕ ставится (кроме выключенного вида):
--    - человек сейчас смотрит на портал (активная вкладка, как у пуша) —
--      он и так видит уведомление;
--    - сгруппированное событие (новое сообщение того же чата, пока прошлое
--      не прочитано, — строка ленты получает count + 1): одно письмо на
--      непрочитанную пачку, а не на каждое сообщение;
--    - нет настоящей почты (учётные записи без почты —
--      nomail-…@no-email.invalid).
--    «Не беспокоить» и тихие часы письма не задерживают: письмо не звенит,
--    оно ждёт в ящике.
-- 4) notif_test_email — проверочное письмо себе (кнопка в настройках), не
--    чаще раза в минуту.
--
-- Актуальные определения portal_settings_save, notif_send_ex,
-- notif_housekeeping — здесь. Таблица закрыта браузеру. Идемпотентно.
-- ============================================================================

-- 1. Очередь писем -------------------------------------------------------------

create table if not exists public.portal_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- null — проверочное письмо (без строки ленты).
  notif_id uuid references public.notif_items (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  kind text not null check (char_length(kind) between 1 and 60),
  title text not null check (char_length(title) between 1 and 300),
  body text check (body is null or char_length(body) <= 1000),
  url text check (url is null or (char_length(url) <= 1000 and url like '/%')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists portal_email_deliveries_queue_idx
  on public.portal_email_deliveries (created_at) where status in ('pending', 'sending');
create index if not exists portal_email_deliveries_user_idx
  on public.portal_email_deliveries (user_id, created_at desc);

alter table public.portal_email_deliveries enable row level security;
revoke all on public.portal_email_deliveries from public, anon, authenticated;
grant all on public.portal_email_deliveries to service_role;

-- 2. Настройки -----------------------------------------------------------------

-- Почта человека для уведомлений: почта входа, иначе почта профиля; без
-- заглушек учётных записей без почты (…@no-email.invalid).
create or replace function public.notif_email_address(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select e
    from (
      select lower(btrim(u.email)) as e, 1 as ord from auth.users u where u.id = p_user
      union all
      select lower(btrim(p.email)), 2 from public.profiles p where p.id = p_user
    ) x
   where e is not null
     and e ~ '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$'
     and e not like '%.invalid'
   order by ord
   limit 1
$$;

-- Письмо по виду включено: только если человек включил сам (по умолчанию —
-- выключено у всех видов).
create or replace function public.notif_email_allowed(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select (s.prefs -> p_kind ->> 'email')::boolean
      from public.portal_user_settings s
     where s.user_id = p_user
       and jsonb_typeof(s.prefs -> p_kind -> 'email') = 'boolean'
  ), false)
$$;

-- Сохранить настройки: только переданные ключи. prefs — целиком (интерфейс
-- шлёт все отличия от умолчаний), значения — {"push": boolean, "email":
-- boolean}, любой из двух. Прежнее определение —
-- 2026-11-07_zz_portal_notifications.sql; актуальное — здесь.
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
    select coalesce(jsonb_object_agg(k, o), '{}'::jsonb)
      into v_prefs
      from (
        select k,
               jsonb_strip_nulls(jsonb_build_object(
                 'push', case when jsonb_typeof(v->'push') = 'boolean' then v->'push' end,
                 'email', case when jsonb_typeof(v->'email') = 'boolean' then v->'email' end
               )) as o
          from jsonb_each(p->'prefs') as e(k, v)
         where char_length(k) <= 60
           and jsonb_typeof(v) = 'object'
      ) x
     where o <> '{}'::jsonb;
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

-- Настройки + адрес, куда уйдут письма (null — почты нет).
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
    'quiet_weekends', coalesce(s.quiet_weekends, false),
    'email', public.notif_email_address(v_uid)
  );
end;
$$;

-- 3. Отправка: лента, пуш, письмо ---------------------------------------------
-- Прежнее определение — 2026-11-08_zz_tasks.sql; актуальное — здесь.
create or replace function public.notif_send_ex(
  p_user uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_url text,
  p_actor uuid,
  p_group_key text,
  p_force_push boolean,
  p_feed boolean
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
  v_watching boolean;
  v_push boolean;
  v_email text;
  v_grouped boolean := false;
begin
  if p_user is null or (p_actor is not null and p_actor = p_user) then
    return null;
  end if;
  if not public.is_portal_user(p_user) then
    return null;
  end if;
  v_watching := public.portal_is_watching(p_user);
  v_push := p_force_push
    or (public.notif_push_allowed(p_user, p_kind) and not v_watching);
  if not p_force_push and not v_watching and public.notif_email_allowed(p_user, p_kind) then
    v_email := public.notif_email_address(p_user);
  end if;
  if not p_feed and not v_push and v_email is null then
    return null;
  end if;

  if p_group_key is not null then
    update public.notif_items n
       set kind = p_kind,
           title = v_title,
           body = v_body,
           url = coalesce(v_url, n.url),
           actor_id = p_actor,
           count = n.count + 1,
           updated_at = now()
     where n.user_id = p_user and n.group_key = p_group_key and n.read_at is null
    returning n.id into v_id;
    v_grouped := v_id is not null;
  end if;

  if v_id is null then
    insert into public.notif_items (user_id, kind, title, body, url, actor_id, group_key, feed)
    values (p_user, p_kind, v_title, v_body, v_url, p_actor, left(p_group_key, 200), p_feed)
    returning id into v_id;
  end if;

  if v_push then
    insert into public.portal_push_deliveries (notif_id, subscription_id, user_id)
    select v_id, s.id, s.user_id
      from public.portal_push_subscriptions s
     where s.user_id = p_user;
  end if;

  -- Одно письмо на непрочитанную пачку: продолжение пачки — без письма.
  if v_email is not null and not v_grouped then
    insert into public.portal_email_deliveries (notif_id, user_id, email, kind, title, body, url)
    values (v_id, p_user, v_email, p_kind, v_title, v_body, v_url);
  end if;
  return v_id;
end;
$$;

-- Проверочное письмо себе (кнопка в настройках): без учёта настроек, не
-- чаще раза в минуту. Возвращает адрес.
create or replace function public.notif_test_email()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_email := public.notif_email_address(v_uid);
  if v_email is null then
    raise exception 'notif_no_email' using errcode = '22023';
  end if;
  if exists (select 1 from public.portal_email_deliveries
              where user_id = v_uid and kind = 'test' and created_at > now() - interval '1 minute') then
    raise exception 'notif_test_rate_limit' using errcode = '54000';
  end if;
  insert into public.portal_email_deliveries (user_id, email, kind, title, body, url)
  values (v_uid, v_email, 'test', 'Проверка уведомлений',
          'Если вы читаете это письмо — уведомления на почту работают.', '/notifications/settings');
  return v_email;
end;
$$;

-- 4. Очередь — сервер портала --------------------------------------------------

-- Пачка писем к отправке. Письмо старше суток уже не нужно — не берётся
-- (уборка отметит его неудачным). Зависшее «sending» дольше 10 минут —
-- повтор (до 3 попыток).
create or replace function public.portal_email_claim(p_limit integer default 20)
returns table (
  delivery_id uuid,
  email text,
  kind text,
  title text,
  body text,
  url text,
  user_name text
)
language sql
security definer
set search_path = public
as $$
  with picked as (
    select d.id
      from public.portal_email_deliveries d
     where d.created_at > now() - interval '1 day'
       and (d.status = 'pending'
            or (d.status = 'sending' and d.claimed_at < now() - interval '10 minutes' and d.attempts < 3))
     order by d.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 200))
     for update skip locked
  ),
  upd as (
    update public.portal_email_deliveries d
       set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
      from picked
     where d.id = picked.id
    returning d.*
  )
  select upd.id, upd.email, upd.kind, upd.title, upd.body, upd.url,
         nullif(btrim(p.full_name), '')
    from upd
    left join public.profiles p on p.id = upd.user_id
$$;

-- Итог пачки: [{"id": uuid, "result": "sent"|"retry"|"failed", "error": text}].
create or replace function public.portal_email_finish(p_results jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  with res as (
    select (x->>'id')::uuid as id, x->>'result' as result, left(x->>'error', 500) as error
      from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x
  )
  update public.portal_email_deliveries d
     set status = case
           when res.result = 'sent' then 'sent'
           when res.result = 'retry' and d.attempts < 3 then 'pending'
           else 'failed'
         end,
         sent_at = case when res.result = 'sent' then now() else d.sent_at end,
         error = case when res.result = 'sent' then null else res.error end
    from res
   where d.id = res.id and d.status = 'sending'
$$;

-- Уборка раз в сутки (сервер портала): + очередь писем — 30 дней, письма,
-- не ушедшие за сутки, — неудачные. Прежнее определение —
-- 2026-11-08_chats.sql; актуальное — здесь.
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
  -- Скрытые строки пушей чатов нужны только для группировки.
  delete from public.notif_items where not feed and updated_at < now() - interval '7 days';

  update public.portal_email_deliveries
     set status = 'failed', error = coalesce(error, 'Не отправлено за сутки')
   where status in ('pending', 'sending') and created_at < now() - interval '1 day';
  delete from public.portal_email_deliveries where created_at < now() - interval '30 days';
end;
$$;

-- 5. Доступ ----------------------------------------------------------------------

revoke all on function public.notif_email_address(uuid) from public, anon, authenticated;
revoke all on function public.notif_email_allowed(uuid, text) from public, anon, authenticated;
revoke all on function public.portal_email_claim(integer) from public, anon, authenticated;
revoke all on function public.portal_email_finish(jsonb) from public, anon, authenticated;
revoke all on function public.notif_housekeeping() from public, anon, authenticated;
revoke all on function public.notif_send_ex(uuid, text, text, text, text, uuid, text, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.portal_settings_get() from public, anon;
revoke all on function public.portal_settings_save(jsonb) from public, anon;
revoke all on function public.notif_test_email() from public, anon;

grant execute on function public.portal_settings_get() to authenticated;
grant execute on function public.portal_settings_save(jsonb) to authenticated;
grant execute on function public.notif_test_email() to authenticated;
grant execute on function public.notif_email_address(uuid) to service_role;
grant execute on function public.notif_email_allowed(uuid, text) to service_role;
grant execute on function public.portal_email_claim(integer) to service_role;
grant execute on function public.portal_email_finish(jsonb) to service_role;
grant execute on function public.notif_housekeeping() to service_role;
grant execute on function public.notif_send_ex(uuid, text, text, text, text, uuid, text, boolean, boolean)
  to service_role;

notify pgrst, 'reload schema';
