-- ============================================================================
-- «Аналитика» → «Диалоги VK», часть 1 (ANALYTICS.md, «Диалоги VK»;
-- ANALYTICS_PLAN.md, §8.9): подключения сообществ, приём Callback API VK,
-- имена и аватарки клиентов, даты первых сообщений — их vk_inbox.py
-- (init_database, register_community, update_community_details,
-- save_confirmation_code, save_callback_secret, set_user_communities,
-- handle_callback, _store_message, refresh_missing_customer_profiles,
-- refresh_first_message_dates) и страницы /admin/vk-inbox/communities,
-- /admin/users/<id>/inbox-access (app.py).
--
-- Их vk_inbox_* → an_inbox_* (пользователи — uuid людей портала):
-- communities (токен сообщества — an_secrets kind 'vk_inbox', ref = id,
-- шифрует сервер портала; секрет Callback — только SHA-256, его считает
-- сервер; их content_community_id не переносится — связи с «Контентом» у
-- них не было: при подключении всегда None), user_communities, dialogs,
-- messages (raw_payload — сообщение VK как есть: по нему переписка
-- показывает картинки и стикеры), dialog_reads, user_read_baselines,
-- events, reply_templates (с visibility), first_messages. Их
-- vk_inbox_message_attachments и vk_inbox_assignments созданы, но не
-- пишутся ни одной функцией — не переносятся.
--
-- Новый портал получает сообщения сам — своим сервером Callback в каждом
-- сообществе (у сообщества их может быть несколько; старый остаётся).
-- Приём — публичный маршрут /api/analytics/vk-callback/<id>, граница —
-- секрет Callback сообщества, пишет сервер портала (service_role,
-- an_inbox_callback). Доступ (их inbox_scope): администратор аналитики —
-- все сообщества; с правом «Лид-менеджер: диалоги VK» (an.inbox) —
-- назначенные ему (an_inbox_user_communities, «Подключения»); прочим — нет.
-- Таблицы закрыты браузеру, всё — через RPC.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы -------------------------------------------------------------------------

create table if not exists public.an_inbox_communities (
  id bigint generated always as identity primary key,
  vk_community_id bigint not null unique check (vk_community_id > 0),
  display_name text not null check (char_length(display_name) between 1 and 1000),
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  city text not null check (char_length(city) between 1 and 1000),
  -- Их _hash_secret: SHA-256 секрета Callback (hex), сам секрет не хранится.
  callback_secret_hash text not null unique check (callback_secret_hash ~ '^[0-9a-f]{64}$'),
  -- Их [A-Za-z0-9_-]{4,256} (в регулярках Postgres повтор — не больше 255).
  callback_confirmation_code text not null
    check (callback_confirmation_code ~ '^[A-Za-z0-9_-]+$' and char_length(callback_confirmation_code) between 4 and 256),
  is_active boolean not null default true,
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  last_sync_at timestamptz
);
create index if not exists an_inbox_communities_active_idx
  on public.an_inbox_communities (is_active, brand, city);

create table if not exists public.an_inbox_user_communities (
  user_id uuid not null references auth.users(id) on delete cascade,
  community_id bigint not null references public.an_inbox_communities(id) on delete cascade,
  primary key (user_id, community_id)
);

create table if not exists public.an_inbox_dialogs (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.an_inbox_communities(id) on delete restrict,
  peer_id bigint not null,
  customer_vk_id bigint,
  customer_name text not null default '',
  customer_avatar_url text not null default '',
  status text not null default 'new' check (status in ('new', 'assigned', 'waiting_customer', 'closed')),
  assigned_user_id uuid references auth.users(id) on delete set null,
  first_incoming_at timestamptz,
  first_operator_reply_at timestamptz,
  last_message_at timestamptz,
  last_incoming_at timestamptz,
  last_outgoing_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, peer_id)
);
create index if not exists an_inbox_dialogs_queue_idx
  on public.an_inbox_dialogs (community_id, status, last_message_at desc);
create index if not exists an_inbox_dialogs_assignee_idx
  on public.an_inbox_dialogs (assigned_user_id, status, last_message_at desc);
create index if not exists an_inbox_dialogs_recent_idx
  on public.an_inbox_dialogs (last_message_at desc nulls last, id desc);
create index if not exists an_inbox_dialogs_community_recent_idx
  on public.an_inbox_dialogs (community_id, last_message_at desc nulls last, id desc);

create table if not exists public.an_inbox_messages (
  id bigint generated always as identity primary key,
  dialog_id bigint not null references public.an_inbox_dialogs(id) on delete cascade,
  community_id bigint not null references public.an_inbox_communities(id) on delete restrict,
  vk_message_id bigint not null,
  conversation_message_id bigint,
  direction text not null check (direction in ('incoming', 'outgoing', 'service')),
  body text not null default '',
  vk_sender_id bigint,
  portal_sender_user_id uuid references auth.users(id) on delete set null,
  sent_at timestamptz not null,
  edited_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (community_id, vk_message_id)
);
create index if not exists an_inbox_messages_dialog_time_idx
  on public.an_inbox_messages (dialog_id, sent_at desc);
create index if not exists an_inbox_messages_dialog_id_idx
  on public.an_inbox_messages (dialog_id, id desc);
create index if not exists an_inbox_messages_operator_time_idx
  on public.an_inbox_messages (sent_at, portal_sender_user_id)
  where portal_sender_user_id is not null;

create table if not exists public.an_inbox_dialog_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  dialog_id bigint not null references public.an_inbox_dialogs(id) on delete cascade,
  last_read_message_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, dialog_id)
);
create index if not exists an_inbox_dialog_reads_dialog_idx
  on public.an_inbox_dialog_reads (dialog_id, user_id);

create table if not exists public.an_inbox_user_read_baselines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  initialized_at timestamptz not null default now()
);

create table if not exists public.an_inbox_events (
  id bigint generated always as identity primary key,
  dialog_id bigint references public.an_inbox_dialogs(id) on delete cascade,
  message_id bigint references public.an_inbox_messages(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists an_inbox_events_time_idx on public.an_inbox_events (created_at desc);

create table if not exists public.an_inbox_reply_templates (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 100),
  body text not null check (char_length(body) between 1 and 4096),
  created_by uuid references auth.users(id) on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  visibility text not null default 'personal' check (visibility in ('personal', 'shared')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists an_inbox_templates_owner_idx on public.an_inbox_reply_templates (created_by);
create index if not exists an_inbox_templates_visibility_idx on public.an_inbox_reply_templates (visibility);

-- Их vk_inbox_first_messages: дата самого раннего сообщения переписки в VK
-- (только дата, текст не хранится); сверяет задача «inbox_first_messages».
create table if not exists public.an_inbox_first_messages (
  dialog_id bigint primary key references public.an_inbox_dialogs(id) on delete cascade,
  first_message_at timestamptz,
  checked_at timestamptz,
  retry_after timestamptz not null default now()
);
create index if not exists an_inbox_first_messages_retry_idx
  on public.an_inbox_first_messages (retry_after) where checked_at is null;

alter table public.an_inbox_communities enable row level security;
alter table public.an_inbox_user_communities enable row level security;
alter table public.an_inbox_dialogs enable row level security;
alter table public.an_inbox_messages enable row level security;
alter table public.an_inbox_dialog_reads enable row level security;
alter table public.an_inbox_user_read_baselines enable row level security;
alter table public.an_inbox_events enable row level security;
alter table public.an_inbox_reply_templates enable row level security;
alter table public.an_inbox_first_messages enable row level security;
revoke all on public.an_inbox_communities, public.an_inbox_user_communities, public.an_inbox_dialogs,
  public.an_inbox_messages, public.an_inbox_dialog_reads, public.an_inbox_user_read_baselines,
  public.an_inbox_events, public.an_inbox_reply_templates, public.an_inbox_first_messages
  from public, anon, authenticated;
grant all on public.an_inbox_communities, public.an_inbox_user_communities, public.an_inbox_dialogs,
  public.an_inbox_messages, public.an_inbox_dialog_reads, public.an_inbox_user_read_baselines,
  public.an_inbox_events, public.an_inbox_reply_templates, public.an_inbox_first_messages
  to service_role;

-- 2) Доступ -------------------------------------------------------------------------

-- Лид-менеджер: право an.inbox из ролей (их is_lead_manager).
create or replace function public.an_inbox_is_manager(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(_user_id, 'an.inbox')
$$;
revoke all on function public.an_inbox_is_manager(uuid) from public, anon, authenticated;
grant execute on function public.an_inbox_is_manager(uuid) to service_role;

-- Их inbox_scope: null — все сообщества (администратор), иначе назначенные
-- лид-менеджеру; без права — пусто.
create or replace function public.an_inbox_scope(_user_id uuid)
returns bigint[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if _user_id is null then
    return '{}';
  end if;
  if public.an_is_admin(_user_id) then
    return null;
  end if;
  if not public.an_inbox_is_manager(_user_id) then
    return '{}';
  end if;
  return array(select community_id from public.an_inbox_user_communities
                where user_id = _user_id order by community_id);
end;
$$;
revoke all on function public.an_inbox_scope(uuid) from public, anon, authenticated;
grant execute on function public.an_inbox_scope(uuid) to service_role;

-- 3) Подключения (администратор аналитики) --------------------------------------------

-- Их list_communities + лид-менеджеры с назначенными сообществами (их
-- users_page: «Доступ к VK Inbox» у лид-менеджера). Токены и секреты не
-- выходят из базы.
create or replace function public.an_inbox_communities()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'communities', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'vk_community_id', c.vk_community_id, 'display_name', c.display_name,
               'brand', c.brand, 'city', c.city, 'is_active', c.is_active,
               'connected_at', c.connected_at, 'last_verified_at', c.last_verified_at,
               'last_sync_at', c.last_sync_at,
               'has_token', exists (select 1 from public.an_secrets s
                                     where s.kind = 'vk_inbox' and s.ref = c.id::text and s.name = 'token'),
               'dialogs', (select count(*) from public.an_inbox_dialogs d where d.community_id = c.id))
             order by c.brand, c.city collate "C", c.display_name collate "C"), '[]')
        from public.an_inbox_communities c),
    'people', (
      select coalesce(jsonb_agg(public.an_person_json(x.id) || jsonb_build_object(
               'communities', (select coalesce(jsonb_agg(u.community_id order by u.community_id), '[]')
                                 from public.an_inbox_user_communities u where u.user_id = x.id),
               'manager', public.an_inbox_is_manager(x.id),
               'admin', public.an_is_admin(x.id))
             order by coalesce(nullif(btrim(p.full_name), ''), '') collate "C", x.id), '[]')
        from (select r.user_id as id from public.access_user_rights r
               where r.portal and 'an.inbox' = any (r.rights)
              union
              select user_id from public.an_inbox_user_communities) x
        left join public.profiles p on p.id = x.id
       where exists (select 1 from auth.users u where u.id = x.id)));
end;
$$;
revoke all on function public.an_inbox_communities() from public, anon;
grant execute on function public.an_inbox_communities() to authenticated;

-- Их register_community (тот же group_id — замена: токен, секрет, код,
-- снова активно, подтверждение заново). Секрет и токен готовит сервер
-- портала: сюда — SHA-256 секрета и шифртекст токена.
create or replace function public.an_inbox_community_register(
  p_vk_community_id bigint, p_display_name text, p_brand text, p_city text,
  p_confirmation_code text, p_secret_hash text, p_token_cipher text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
  v_city text := btrim(coalesce(p_city, ''));
  v_code text := btrim(coalesce(p_confirmation_code, ''));
  v_id bigint;
begin
  perform public.an_require_admin();
  if coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Укажите направление Lady Stretch или Lady Jump.' using errcode = '22023';
  end if;
  if v_name = '' or v_city = '' or coalesce(p_token_cipher, '') = '' then
    raise exception 'Заполните название, город и токен сообщений сообщества.' using errcode = '22023';
  end if;
  if char_length(v_name) > 1000 or char_length(v_city) > 1000 then
    raise exception 'Название и город — не длиннее 1000 символов.' using errcode = '22023';
  end if;
  if v_code !~ '^[A-Za-z0-9_-]+$' or char_length(v_code) not between 4 and 256 then
    raise exception 'Вставьте строку подтверждения, которую показывает VK в Callback API.' using errcode = '22023';
  end if;
  if p_vk_community_id is null or p_vk_community_id <= 0 then
    raise exception 'Укажите числовой ID группы VK или ссылку вида vk.ru/public123456.' using errcode = '22023';
  end if;
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Секрет не подготовлен — сохраните подключение через портал.' using errcode = '22023';
  end if;
  -- Шифртекст пустого ключа — 28 байт (38 знаков base64 и «==»).
  if p_token_cipher !~ '^[A-Za-z0-9+/]{38,}={0,2}$' then
    raise exception 'Ключ не зашифрован — сохраните его через портал.' using errcode = '22023';
  end if;
  insert into public.an_inbox_communities
    (vk_community_id, display_name, brand, city, callback_secret_hash, callback_confirmation_code)
  values (p_vk_community_id, v_name, p_brand, v_city, p_secret_hash, v_code)
  on conflict (vk_community_id) do update set
    display_name = excluded.display_name, brand = excluded.brand, city = excluded.city,
    callback_secret_hash = excluded.callback_secret_hash,
    callback_confirmation_code = excluded.callback_confirmation_code,
    is_active = true, last_verified_at = null
  returning id into v_id;
  insert into public.an_secrets (kind, ref, name, ciphertext, updated_at, updated_by)
  values ('vk_inbox', v_id::text, 'token', p_token_cipher, now(), auth.uid())
  on conflict (kind, ref, name) do update set
    ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform public.an_audit_add(auth.uid(), 'vk_inbox_community_connected',
    v_name || ' · ' || p_vk_community_id::text);
  return v_id;
end;
$$;
revoke all on function public.an_inbox_community_register(bigint, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.an_inbox_community_register(bigint, text, text, text, text, text, text)
  to authenticated;

-- Их update_community_details: только подписи, ключи и история остаются.
create or replace function public.an_inbox_community_update(p_id bigint, p_brand text, p_city text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand text := btrim(coalesce(p_brand, ''));
  v_city text := btrim(coalesce(p_city, ''));
begin
  perform public.an_require_admin();
  if v_brand not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Укажите направление Lady Stretch или Lady Jump.' using errcode = '22023';
  end if;
  if v_city = '' or char_length(v_city) > 200 or v_city ~ '[\x01-\x1f]' then
    raise exception 'Укажите город: от 1 до 200 символов, без переносов строк.' using errcode = '22023';
  end if;
  if coalesce(p_id, 0) <= 0 then
    raise exception 'Подключение сообщества не найдено.' using errcode = 'P0002';
  end if;
  update public.an_inbox_communities set brand = v_brand, city = v_city
   where id = p_id and is_active;
  if not found then
    raise exception 'Подключение сообщества не найдено.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'vk_inbox_community_details_updated', p_id::text);
end;
$$;
revoke all on function public.an_inbox_community_update(bigint, text, text) from public, anon;
grant execute on function public.an_inbox_community_update(bigint, text, text) to authenticated;

-- Их save_confirmation_code: новый код — подтверждение заново.
create or replace function public.an_inbox_confirmation_save(p_id bigint, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
begin
  perform public.an_require_admin();
  if v_code !~ '^[A-Za-z0-9_-]+$' or char_length(v_code) not between 4 and 256 then
    raise exception 'Вставьте код подтверждения, который показал VK.' using errcode = '22023';
  end if;
  update public.an_inbox_communities
     set callback_confirmation_code = v_code, last_verified_at = null
   where id = p_id and is_active;
  if not found then
    raise exception 'Подключение сообщества не найдено.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'vk_inbox_confirmation_code_saved', p_id::text);
end;
$$;
revoke all on function public.an_inbox_confirmation_save(bigint, text) from public, anon;
grant execute on function public.an_inbox_confirmation_save(bigint, text) to authenticated;

-- Их save_callback_secret: длину секрета (16–256) проверяет сервер портала,
-- сюда — только SHA-256.
create or replace function public.an_inbox_secret_save(p_id bigint, p_secret_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Вставьте текущий секретный ключ Callback API из VK.' using errcode = '22023';
  end if;
  update public.an_inbox_communities set callback_secret_hash = p_secret_hash
   where id = p_id and is_active;
  if not found then
    raise exception 'Подключение сообщества не найдено.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'vk_inbox_callback_secret_synced', p_id::text);
end;
$$;
revoke all on function public.an_inbox_secret_save(bigint, text) from public, anon;
grant execute on function public.an_inbox_secret_save(bigint, text) to authenticated;

-- Их /admin/users/<id>/inbox-access + set_user_communities: пустой список —
-- снять доступ.
create or replace function public.an_inbox_access_save(p_user uuid, p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := array(select distinct x from unnest(coalesce(p_ids, '{}')) x where x > 0 order by x);
  v_name text;
begin
  perform public.an_require_admin();
  select coalesce(nullif(btrim(p.full_name), ''), u.email::text) into v_name
    from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user;
  if not found then
    raise exception 'Пользователь не найден.' using errcode = 'P0002';
  end if;
  if public.an_is_admin(p_user) then
    raise exception 'У администратора уже есть доступ ко всем сообществам.' using errcode = '22023';
  end if;
  if not public.an_inbox_is_manager(p_user) then
    raise exception 'Сначала назначьте сотруднику роль «Лид-менеджер».' using errcode = '22023';
  end if;
  if not public.is_portal_user(p_user) then
    raise exception 'Сначала включите учётную запись сотрудника.' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 0
     and (select count(*) from public.an_inbox_communities c where c.id = any (v_ids) and c.is_active)
         <> cardinality(v_ids) then
    raise exception 'Выберите только активные сообщества VK.' using errcode = '22023';
  end if;
  delete from public.an_inbox_user_communities where user_id = p_user;
  insert into public.an_inbox_user_communities (user_id, community_id)
  select p_user, x from unnest(v_ids) x;
  perform public.an_audit_add(auth.uid(), 'vk_inbox_access_changed', v_name);
end;
$$;
revoke all on function public.an_inbox_access_save(uuid, bigint[]) from public, anon;
grant execute on function public.an_inbox_access_save(uuid, bigint[]) to authenticated;

-- 4) Приём Callback API (сервер портала, service_role) -------------------------------

-- Их _store_message: диалог и сообщение по ключам VK, повтор события не
-- задваивает; правка — новый текст и время правки; новое сообщение — событие
-- message_received / external_message. Значения сообщения уже разобраны
-- сервером (их int() / bool()); p_message — сообщение VK как есть.
create or replace function public.an_inbox_store_message(
  p_community bigint, p_event_type text, p_peer_id bigint, p_message_id bigint, p_sent_at bigint,
  p_sender_id bigint, p_outgoing boolean, p_conversation_message_id bigint, p_body text,
  p_message jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_direction text := case when p_outgoing then 'outgoing' else 'incoming' end;
  v_at timestamptz := to_timestamp(p_sent_at);
  v_dialog bigint;
  v_message bigint;
begin
  insert into public.an_inbox_dialogs as d
    (community_id, peer_id, customer_vk_id, first_incoming_at, last_message_at,
     last_incoming_at, last_outgoing_at, status)
  values (p_community, p_peer_id,
          case when not p_outgoing then p_sender_id
               when p_peer_id > 0 and p_peer_id < 2000000000 then p_peer_id end,
          case when v_direction = 'incoming' then v_at end,
          v_at,
          case when v_direction = 'incoming' then v_at end,
          case when v_direction = 'outgoing' then v_at end,
          case when v_direction = 'incoming' then 'new' else 'waiting_customer' end)
  on conflict (community_id, peer_id) do update set
    customer_vk_id = coalesce(d.customer_vk_id, excluded.customer_vk_id),
    first_incoming_at = coalesce(d.first_incoming_at, excluded.first_incoming_at),
    last_message_at = greatest(coalesce(d.last_message_at, excluded.last_message_at), excluded.last_message_at),
    last_incoming_at = coalesce(excluded.last_incoming_at, d.last_incoming_at),
    last_outgoing_at = coalesce(excluded.last_outgoing_at, d.last_outgoing_at),
    status = case when excluded.last_incoming_at is not null and d.status = 'closed' then 'new'
                  else d.status end,
    updated_at = now()
  returning id into v_dialog;
  insert into public.an_inbox_messages as m
    (dialog_id, community_id, vk_message_id, conversation_message_id, direction, body,
     vk_sender_id, sent_at, edited_at, raw_payload)
  values (v_dialog, p_community, p_message_id, p_conversation_message_id, v_direction,
          coalesce(p_body, ''), p_sender_id, v_at,
          case when p_event_type = 'message_edit' then now() end, coalesce(p_message, '{}'::jsonb))
  on conflict (community_id, vk_message_id) do update set
    body = excluded.body, edited_at = coalesce(excluded.edited_at, m.edited_at),
    raw_payload = excluded.raw_payload
  returning id into v_message;
  if p_event_type = 'message_new' then
    insert into public.an_inbox_events (dialog_id, message_id, event_type, payload_json)
    values (v_dialog, v_message,
            case when p_outgoing then 'external_message' else 'message_received' end,
            jsonb_build_object('vk_message_id', p_message_id));
  end if;
end;
$$;
revoke all on function public.an_inbox_store_message(bigint, text, bigint, bigint, bigint, bigint,
  boolean, bigint, text, jsonb) from public, anon, authenticated;

-- Их handle_callback: confirmation — строка подтверждения (и «подтверждено»),
-- иначе секрет сообщества; message_new / message_reply / message_edit —
-- сообщение в переписку; ответ VK — 'ok'. p_message — разобранное сервером
-- сообщение (null — события без сообщения или без peer_id / id).
create or replace function public.an_inbox_callback(
  p_id bigint, p_type text, p_secret_hash text, p_message jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.an_inbox_communities%rowtype;
begin
  select * into v_c from public.an_inbox_communities where id = p_id and is_active;
  if not found then
    raise exception 'Подключение сообщества не найдено или отключено.' using errcode = 'P0002';
  end if;
  if p_type = 'confirmation' then
    update public.an_inbox_communities set last_verified_at = now() where id = p_id;
    return v_c.callback_confirmation_code;
  end if;
  if coalesce(p_secret_hash, '') = '' or p_secret_hash is distinct from v_c.callback_secret_hash then
    raise exception 'Секрет Callback API не совпадает.' using errcode = '28000';
  end if;
  if p_type in ('message_new', 'message_reply', 'message_edit') and p_message is not null then
    perform public.an_inbox_store_message(p_id, p_type,
      (p_message->>'peer_id')::bigint, (p_message->>'id')::bigint, (p_message->>'date')::bigint,
      (p_message->>'from_id')::bigint, coalesce((p_message->>'out')::boolean, false),
      (p_message->>'conversation_message_id')::bigint, coalesce(p_message->>'text', ''),
      p_message->'raw');
  end if;
  return 'ok';
end;
$$;
revoke all on function public.an_inbox_callback(bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_inbox_callback(bigint, text, text, jsonb) to service_role;

-- 5) Имена и аватарки клиентов (их refresh_missing_customer_profiles) -----------------

-- Кандидаты: диалоги без имени или аватарки (личная переписка без входящего —
-- customer_vk_id = peer_id), свежие первыми. Токен сервер берёт из an_secrets.
create or replace function public.an_inbox_profiles_pending(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.an_inbox_dialogs set customer_vk_id = peer_id
   where customer_vk_id is null and peer_id > 0 and peer_id < 2000000000;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id, 'customer_vk_id', x.customer_vk_id, 'community_id', x.community_id,
             'has_name', x.customer_name <> '', 'has_avatar', x.customer_avatar_url <> '')
           order by x.updated_at desc, x.id), '[]')
      from (select d.id, d.customer_vk_id, d.community_id, d.customer_name, d.customer_avatar_url,
                   d.updated_at
              from public.an_inbox_dialogs d
              join public.an_inbox_communities c on c.id = d.community_id
             where (d.customer_name = '' or d.customer_avatar_url = '')
               and d.customer_vk_id is not null and d.customer_vk_id > 0
               and c.is_active
             order by d.updated_at desc
             limit greatest(1, least(coalesce(p_limit, 500), 500))) x);
end;
$$;
revoke all on function public.an_inbox_profiles_pending(integer) from public, anon, authenticated;
grant execute on function public.an_inbox_profiles_pending(integer) to service_role;

-- Найденные имена и аватарки: только в пустые поля (имя, которое ввёл
-- менеджер, остаётся). p_rows — [{id, name, avatar}].
create or replace function public.an_inbox_profiles_store(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.an_inbox_dialogs d
     set customer_name = case when d.customer_name = '' then r.name else d.customer_name end,
         customer_avatar_url = case when d.customer_avatar_url = '' then r.avatar else d.customer_avatar_url end,
         updated_at = now()
    from jsonb_to_recordset(coalesce(p_rows, '[]')) as r(id bigint, name text, avatar text)
   where d.id = r.id
     and ((d.customer_name = '' and coalesce(r.name, '') <> '')
          or (d.customer_avatar_url = '' and coalesce(r.avatar, '') <> ''));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.an_inbox_profiles_store(jsonb) from public, anon, authenticated;
grant execute on function public.an_inbox_profiles_store(jsonb) to service_role;

-- 6) Даты первых сообщений (их refresh_first_message_dates) ----------------------------

-- До 100 диалогов активных сообществ без сверенной даты, которым пора
-- (свежие первыми); p_skip — сообщества, у которых VK API недавно не
-- ответил (их _history_group_retry, на час).
create or replace function public.an_inbox_first_pending(p_skip bigint[], p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'peer_id', x.peer_id, 'community_id', x.community_id,
           'vk_community_id', x.vk_community_id, 'oldest_local', x.oldest_local)
         order by x.last_message_at desc nulls last, x.id desc), '[]')
    from (select d.id, d.peer_id, d.community_id, c.vk_community_id, d.last_message_at,
                 (select min(m.sent_at) from public.an_inbox_messages m where m.dialog_id = d.id) as oldest_local
            from public.an_inbox_dialogs d
            join public.an_inbox_communities c on c.id = d.community_id
            left join public.an_inbox_first_messages h on h.dialog_id = d.id
           where c.is_active and h.checked_at is null
             and not (c.id = any (coalesce(p_skip, '{}')))
             and (h.retry_after is null or h.retry_after <= now())
           order by d.last_message_at desc nulls last, d.id desc
           limit greatest(1, least(coalesce(p_limit, 100), 100))) x
$$;
revoke all on function public.an_inbox_first_pending(bigint[], integer) from public, anon, authenticated;
grant execute on function public.an_inbox_first_pending(bigint[], integer) to service_role;

-- Итог сверки: дата — «сверено»; без даты — повтор через сутки. Уже
-- сверенное не переписывается.
create or replace function public.an_inbox_first_store(p_dialog bigint, p_first_at timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_inbox_first_messages (dialog_id, first_message_at, checked_at, retry_after)
  values (p_dialog, p_first_at, case when p_first_at is not null then now() end, now() + interval '24 hours')
  on conflict (dialog_id) do update set
    first_message_at = excluded.first_message_at,
    checked_at = excluded.checked_at,
    retry_after = excluded.retry_after
  where public.an_inbox_first_messages.checked_at is null
$$;
revoke all on function public.an_inbox_first_store(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.an_inbox_first_store(bigint, timestamptz) to service_role;
