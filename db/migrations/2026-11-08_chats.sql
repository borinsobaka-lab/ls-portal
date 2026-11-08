-- ============================================================================
-- Чаты портала (TASKS_CHATS_PLAN.md, веха 2; решения владельца 2026-11-07:
-- переписку из Битрикс24 не переносим, партнёры пишут друг другу).
--
-- Чаты: личный (`direct`, пара людей — `direct_key`), группа (`group`),
-- «Избранное» (`self`, чат с собой). Сообщение — номер в чате `seq`
-- (1, 2, 3…): по нему считаются непрочитанные (`chat_members.last_read_seq`),
-- «кто прочитал» (участники с last_read_seq ≥ seq — без строк на каждое
-- сообщение) и дозапрос пропущенного. Текст — документ редактора
-- (`content`, JSON ProseMirror: абзацы, жирный, курсив, зачёркнутый, код,
-- ссылки, списки, цитата, упоминания) + чистый текст `body_text` для
-- поиска и превью. Файлы — `attachments` (jsonb: путь в бакете
-- `chat-files`, имя, тип, размер, размеры картинки); бакет закрытый: читать
-- — участнику чата папки или чата, где сообщение с этим файлом (пересылка).
--
-- Все таблицы закрыты браузеру: только RPC `chat_*` (security definer,
-- проверка участника — `chat_role`). Удаление сообщения — мягкое (текст и
-- файлы убираются, строка «Сообщение удалено» остаётся).
--
-- Уведомления (через notif_send_ex, 2026-11-07_zz_portal_notifications.sql):
-- упоминание и ответ на моё сообщение — в ленту «Уведомлений» и пушем
-- (`chat.mention`); личное сообщение и сообщение группы — только пушем
-- (`chat.direct` / `chat.group`, строка ленты скрыта — `notif_items.feed =
-- false`, нужна для группировки пушей одного чата), без строки, если пуш
-- не уйдёт. У участника — `notify` (all / mentions / none) и `muted_until`.
--
-- Живое обновление: каждое изменение чата шлёт участникам короткое событие
-- в их личную тему Realtime `user:<id>` (realtime.send, приватные каналы;
-- политика на realtime.messages — только своя тема), «печатает…» — тема
-- `chat:<id>` (только участники). Нет схемы realtime (тесты, Realtime не
-- поднят) — события не шлются, портал опрашивает базу сам.
--
-- Идемпотентно.
-- ============================================================================

-- 1. Таблицы -----------------------------------------------------------------

create table if not exists public.chat_chats (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group', 'self')),
  title text check (title is null or char_length(title) between 1 and 100),
  description text check (description is null or char_length(description) <= 1000),
  -- Личный: «<меньший uuid>:<больший uuid>», «Избранное»: «self:<uuid>».
  direct_key text unique,
  -- Настройки группы: pin — кто закрепляет (admins / all), post — кто пишет
  -- (all / admins), add — кто добавляет участников (admins / all).
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seq bigint not null default 0,
  last_message_at timestamptz,
  -- Превью последнего сообщения для списка: {seq, author_id, text, kind}.
  last_message jsonb
);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  -- С какого сообщения человек в чате: раньше его прихода история видна
  -- (как в Telegram), поле — для «кто прочитал».
  joined_seq bigint not null default 0,
  last_read_seq bigint not null default 0,
  notify text not null default 'all' check (notify in ('all', 'mentions', 'none')),
  muted_until timestamptz,
  -- Закреплён наверху своего списка.
  pinned_at timestamptz,
  primary key (chat_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members (user_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  seq bigint not null,
  author_id uuid references auth.users (id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'system')),
  content jsonb,
  body_text text not null default '',
  search tsvector,
  reply_to_seq bigint,
  -- Пересланное: {chat_id, seq, author_id, created_at}.
  forward jsonb,
  mentions uuid[] not null default '{}',
  mention_all boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  -- Повтор отправки (обрыв связи) не задваивает сообщение.
  client_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  unique (chat_id, seq),
  constraint chat_messages_lengths_check check (
    char_length(body_text) <= 10000
    and jsonb_typeof(attachments) = 'array'
    and jsonb_array_length(attachments) <= 20
  )
);
create unique index if not exists chat_messages_client_uidx
  on public.chat_messages (chat_id, client_id) where client_id is not null;
create index if not exists chat_messages_search_idx on public.chat_messages using gin (search);
create index if not exists chat_messages_attachments_idx
  on public.chat_messages using gin (attachments jsonb_path_ops);
create index if not exists chat_messages_mentions_idx on public.chat_messages using gin (mentions);

create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.chat_pins (
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  pinned_by uuid references auth.users (id) on delete set null,
  pinned_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

-- Свои папки человека (системные «Все», «Личные», «Группы» — в интерфейсе).
create table if not exists public.chat_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 40),
  sort_order integer not null default 0,
  chat_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists chat_folders_user_idx on public.chat_folders (user_id, sort_order);

do $$
declare t text;
begin
  foreach t in array array['chat_chats', 'chat_members', 'chat_messages', 'chat_reactions',
                           'chat_pins', 'chat_folders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Поиск: текст сообщения и имена файлов (русская морфология).
create or replace function public.chat_messages_search_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search := to_tsvector('russian'::regconfig,
    coalesce(new.body_text, '') || ' ' ||
    coalesce((select string_agg(a->>'name', ' ') from jsonb_array_elements(new.attachments) a), ''));
  return new;
end;
$$;
drop trigger if exists chat_messages_search_biu on public.chat_messages;
create trigger chat_messages_search_biu
  before insert or update of body_text, attachments on public.chat_messages
  for each row execute function public.chat_messages_search_biu();

-- 2. Уведомления: строка ленты без показа в ленте ---------------------------

alter table public.notif_items add column if not exists feed boolean not null default true;
create index if not exists notif_items_feed_unread_idx
  on public.notif_items (user_id) where read_at is null and feed;

-- notif_send с выбором: строка в ленте (feed) или только пуш. Без ленты и
-- без пуша — строки нет совсем (сообщения групп при выключенных пушах).
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
  v_push boolean;
begin
  if p_user is null or (p_actor is not null and p_actor = p_user) then
    return null;
  end if;
  if not public.is_portal_user(p_user) then
    return null;
  end if;
  v_push := p_force_push
    or (public.notif_push_allowed(p_user, p_kind) and not public.portal_is_watching(p_user));
  if not p_feed and not v_push then
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
  return v_id;
end;
$$;

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
language sql
security definer
set search_path = public
as $$
  select public.notif_send_ex(p_user, p_kind, p_title, p_body, p_url, p_actor, p_group_key,
                              p_force_push, true)
$$;

-- Лента и счётчик — только строки ленты.
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
     and n.feed
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
  select count(*)::int from public.notif_items
   where user_id = auth.uid() and read_at is null and feed
$$;

-- Значок на иконке приложения: непрочитанные уведомления + чаты с новым.
create or replace function public.portal_badge_count(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*)::int from public.notif_items
           where user_id = p_user and read_at is null and feed)
       + (select count(*)::int
            from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
           where cm.user_id = p_user and c.last_seq > cm.last_read_seq and cm.notify <> 'none'
             and (cm.muted_until is null or cm.muted_until < now()))
$$;

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
         public.portal_badge_count(upd.user_id)
    from upd
    join public.portal_push_subscriptions s on s.id = upd.subscription_id
    join public.notif_items n on n.id = upd.notif_id
$$;

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
end;
$$;

-- 3. Доступ ------------------------------------------------------------------

create or replace function public.chat_role(p_chat uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.chat_members where chat_id = p_chat and user_id = p_user
$$;

-- Тема Realtime «chat:<id>» («печатает…») — только участникам.
create or replace function public.chat_topic_member(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_topic is null or p_topic !~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (select 1 from public.chat_members
                  where chat_id = substr(p_topic, 6)::uuid and user_id = auth.uid());
end;
$$;

-- Файл бакета chat-files: участнику чата папки или чата, где есть сообщение
-- с этим файлом (пересланное).
create or replace function public.chat_file_allowed(p_name text, p_write boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return false;
  end if;
  if v_folder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and exists (select 1 from public.chat_members
                  where chat_id = v_folder::uuid and user_id = v_uid) then
    return true;
  end if;
  if p_write then
    return false;
  end if;
  return exists (
    select 1
      from public.chat_messages m
      join public.chat_members cm on cm.chat_id = m.chat_id and cm.user_id = v_uid
     where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_name))
       and m.deleted_at is null
  );
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 209715200)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "chat-files read" on storage.objects;
create policy "chat-files read" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and public.chat_file_allowed(name));

drop policy if exists "chat-files insert" on storage.objects;
create policy "chat-files insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and public.chat_file_allowed(name, true));

-- Realtime: своя тема и темы своих чатов. Схемы нет — Realtime не поднят.
do $$
begin
  if to_regclass('realtime.messages') is not null then
   begin
    execute 'drop policy if exists "portal user topic read" on realtime.messages';
    execute $p$create policy "portal user topic read" on realtime.messages
      for select to authenticated
      using ((select realtime.topic()) = 'user:' || (select auth.uid())::text)$p$;
    execute 'drop policy if exists "portal chat topic read" on realtime.messages';
    execute $p$create policy "portal chat topic read" on realtime.messages
      for select to authenticated
      using (public.chat_topic_member((select realtime.topic())))$p$;
    execute 'drop policy if exists "portal chat topic write" on realtime.messages';
    execute $p$create policy "portal chat topic write" on realtime.messages
      for insert to authenticated
      with check (public.chat_topic_member((select realtime.topic())))$p$;
   exception when insufficient_privilege then
    -- Владелец realtime.messages — служебная роль Supabase: без прав политики
    -- ставит администратор (DEPLOY.md); чаты работают опросом базы.
    raise notice 'Политики realtime.messages не созданы: нет прав (%)', sqlerrm;
   end;
  end if;
end $$;

-- Событие участникам чата (или только p_only). Сбой Realtime сообщение не
-- ломает.
create or replace function public.chat_broadcast(p_chat uuid, p_event jsonb, p_only uuid[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_event jsonb := coalesce(p_event, '{}'::jsonb) || jsonb_build_object('chat_id', p_chat);
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  begin
    for r in
      select user_id from public.chat_members
       where chat_id = p_chat and (p_only is null or user_id = any (p_only))
      union
      select u from unnest(coalesce(p_only, '{}'::uuid[])) u
    loop
      perform realtime.send(v_event, 'chat', 'user:' || r.user_id::text, true);
    end loop;
  exception when others then
    null;
  end;
end;
$$;

-- 4. Сообщение в JSON ---------------------------------------------------------

create or replace function public.chat_message_json(m public.chat_messages, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', m.id,
    'chat_id', m.chat_id,
    'seq', m.seq,
    'author_id', m.author_id,
    'kind', m.kind,
    'content', case when m.deleted_at is null then m.content end,
    'text', case when m.deleted_at is null then m.body_text else '' end,
    'attachments', case when m.deleted_at is null then m.attachments else '[]'::jsonb end,
    'mentions', to_jsonb(m.mentions),
    'mention_all', m.mention_all,
    'forward', m.forward,
    'reply', case when m.reply_to_seq is null then null else (
      select jsonb_build_object(
        'seq', r.seq,
        'author_id', r.author_id,
        'text', case when r.deleted_at is null then left(r.body_text, 200) else '' end,
        'files', case when r.deleted_at is null then jsonb_array_length(r.attachments) else 0 end,
        'deleted', r.deleted_at is not null)
        from public.chat_messages r
       where r.chat_id = m.chat_id and r.seq = m.reply_to_seq) end,
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object('emoji', x.emoji, 'count', x.cnt, 'mine', x.mine,
                                          'users', x.users) order by x.first_at)
        from (select r.emoji, count(*)::int as cnt, bool_or(r.user_id = p_viewer) as mine,
                     to_jsonb(array_agg(r.user_id order by r.created_at)) as users,
                     min(r.created_at) as first_at
                from public.chat_reactions r
               where r.message_id = m.id
               group by r.emoji) x), '[]'::jsonb),
    'pinned', exists (select 1 from public.chat_pins p where p.message_id = m.id),
    -- Свой client_id — браузер убирает по нему черновик отправки.
    'client_id', case when m.author_id = p_viewer then m.client_id end,
    'created_at', m.created_at,
    'edited_at', m.edited_at,
    'deleted', m.deleted_at is not null
  )
$$;

-- 5. Чтение -------------------------------------------------------------------

-- Мои чаты для списка.
create or replace function public.chat_list()
returns table (
  id uuid,
  kind text,
  title text,
  description text,
  settings jsonb,
  peer_id uuid,
  member_count integer,
  my_role text,
  notify text,
  muted_until timestamptz,
  pinned_at timestamptz,
  last_seq bigint,
  last_read_seq bigint,
  last_message jsonb,
  last_message_at timestamptz,
  unread integer,
  mentions integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select c.id, c.kind, c.title, c.description, c.settings,
         case when c.kind = 'direct' then (
           select o.user_id from public.chat_members o
            where o.chat_id = c.id and o.user_id <> v_uid limit 1) end,
         (select count(*)::int from public.chat_members x where x.chat_id = c.id),
         cm.role, cm.notify, cm.muted_until, cm.pinned_at,
         c.last_seq, cm.last_read_seq, c.last_message, c.last_message_at,
         case when c.last_seq <= cm.last_read_seq then 0 else (
           select count(*)::int from (
             select 1 from public.chat_messages m
              where m.chat_id = c.id and m.seq > cm.last_read_seq
                and m.author_id is distinct from v_uid and m.deleted_at is null
              limit 100) u) end,
         case when c.last_seq <= cm.last_read_seq then 0 else (
           select count(*)::int from public.chat_messages m
            where m.chat_id = c.id and m.seq > cm.last_read_seq and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (v_uid = any (m.mentions) or m.mention_all
                   or exists (select 1 from public.chat_messages r
                               where r.chat_id = m.chat_id and r.seq = m.reply_to_seq
                                 and r.author_id = v_uid))) end,
         c.created_at
    from public.chat_members cm
    join public.chat_chats c on c.id = cm.chat_id
   where cm.user_id = v_uid
   order by cm.pinned_at desc nulls last, coalesce(c.last_message_at, c.created_at) desc;
end;
$$;

-- Счётчик раздела в рейке: чаты с непрочитанным (без звука — не в счёт) и
-- упоминания.
create or replace function public.chat_unread_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'chats', count(*) filter (where c.last_seq > cm.last_read_seq and cm.notify <> 'none'
                                and (cm.muted_until is null or cm.muted_until < now())),
    'muted', count(*) filter (where c.last_seq > cm.last_read_seq and (cm.notify = 'none'
                                or cm.muted_until > now())))
    from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
   where cm.user_id = auth.uid()
$$;

-- Сообщения: последние (без параметров), старше p_before, новее p_after или
-- вокруг p_around. По возрастанию seq.
create or replace function public.chat_messages_page(
  p_chat uuid,
  p_before bigint default null,
  p_after bigint default null,
  p_around bigint default null,
  p_limit integer default 50
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if public.chat_role(p_chat, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if p_after is not null then
    return query
      select public.chat_message_json(m, v_uid) from public.chat_messages m
       where m.chat_id = p_chat and m.seq > p_after
       order by m.seq limit v_limit;
  elsif p_around is not null then
    return query
      select x.j from (
        (select m.seq, public.chat_message_json(m, v_uid) as j from public.chat_messages m
          where m.chat_id = p_chat and m.seq < p_around order by m.seq desc limit v_limit / 2)
        union all
        (select m.seq, public.chat_message_json(m, v_uid) from public.chat_messages m
          where m.chat_id = p_chat and m.seq >= p_around order by m.seq limit v_limit - v_limit / 2)
      ) x order by x.seq;
  else
    return query
      select x.j from (
        select m.seq, public.chat_message_json(m, v_uid) as j from public.chat_messages m
         where m.chat_id = p_chat and (p_before is null or m.seq < p_before)
         order by m.seq desc limit v_limit
      ) x order by x.seq;
  end if;
end;
$$;

create or replace function public.chat_members_list(p_chat uuid)
returns table (user_id uuid, role text, joined_at timestamptz, last_read_seq bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.chat_role(p_chat, auth.uid()) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return query
    select cm.user_id, cm.role, cm.joined_at, cm.last_read_seq
      from public.chat_members cm
     where cm.chat_id = p_chat
     order by case cm.role when 'owner' then 0 when 'admin' then 1 else 2 end, cm.joined_at;
end;
$$;

-- Кто прочитал сообщение (кроме автора) и сколько участников всего.
create or replace function public.chat_read_receipts(p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if not found or public.chat_role(m.chat_id, auth.uid()) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'read', coalesce((
      select jsonb_agg(cm.user_id order by cm.user_id)
        from public.chat_members cm
       where cm.chat_id = m.chat_id and cm.last_read_seq >= m.seq
         and cm.user_id is distinct from m.author_id), '[]'::jsonb),
    'total', (select count(*) from public.chat_members cm
               where cm.chat_id = m.chat_id and cm.user_id is distinct from m.author_id)
  );
end;
$$;

create or replace function public.chat_pinned(p_chat uuid)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if public.chat_role(p_chat, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return query
    select public.chat_message_json(m, v_uid)
      from public.chat_pins p join public.chat_messages m on m.id = p.message_id
     where p.chat_id = p_chat and m.deleted_at is null
     order by m.seq desc;
end;
$$;

-- Поиск по словам во всех моих чатах (или в одном). Фрагмент — с
-- найденным между ⟦ и ⟧, как в поиске базы знаний.
create or replace function public.chat_search(
  p_query text,
  p_chat uuid default null,
  p_limit integer default 50
)
returns table (
  message_id uuid,
  chat_id uuid,
  seq bigint,
  author_id uuid,
  created_at timestamptz,
  snippet text,
  has_files boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_q tsquery := public.kb_prefix_tsquery(p_query);
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_q is null then
    return;
  end if;
  return query
    select m.id, m.chat_id, m.seq, m.author_id, m.created_at,
           case when m.body_text = '' then
             coalesce((select string_agg(a->>'name', ', ') from jsonb_array_elements(m.attachments) a), '')
           else ts_headline('russian'::regconfig, m.body_text, v_q,
             'StartSel=⟦, StopSel=⟧, MaxWords=24, MinWords=8, MaxFragments=1') end,
           jsonb_array_length(m.attachments) > 0
      from public.chat_messages m
      join public.chat_members cm on cm.chat_id = m.chat_id and cm.user_id = v_uid
     where m.search @@ v_q
       and m.deleted_at is null
       and m.kind = 'text'
       and (p_chat is null or m.chat_id = p_chat)
     order by m.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

-- Файлы чата: media — картинки и видео, files — остальное. Свежие первыми.
create or replace function public.chat_files(
  p_chat uuid,
  p_kind text default 'files',
  p_before bigint default null,
  p_limit integer default 60
)
returns table (seq bigint, author_id uuid, created_at timestamptz, file jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.chat_role(p_chat, auth.uid()) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return query
    select m.seq, m.author_id, m.created_at, a
      from public.chat_messages m
      cross join lateral jsonb_array_elements(m.attachments) a
     where m.chat_id = p_chat and m.deleted_at is null
       and jsonb_array_length(m.attachments) > 0
       and (p_before is null or m.seq < p_before)
       and ((p_kind = 'media') = coalesce(a->>'mime', '') ~ '^(image|video)/')
     order by m.seq desc
     limit greatest(1, least(coalesce(p_limit, 60), 200));
end;
$$;

-- Ссылки из текста сообщений чата.
create or replace function public.chat_links(p_chat uuid, p_limit integer default 100)
returns table (seq bigint, author_id uuid, created_at timestamptz, url text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.chat_role(p_chat, auth.uid()) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return query
    select m.seq, m.author_id, m.created_at, u[1]
      from public.chat_messages m
      cross join lateral regexp_matches(m.body_text, '(https?://[^\s<>"«»]+)', 'g') u
     where m.chat_id = p_chat and m.deleted_at is null and m.body_text ~ 'https?://'
     order by m.seq desc
     limit greatest(1, least(coalesce(p_limit, 100), 300));
end;
$$;

-- 6. Создание чатов -----------------------------------------------------------

create or replace function public.chat_require_portal()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- «Избранное» — чат с собой.
create or replace function public.chat_open_self()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid;
begin
  select id into v_id from public.chat_chats where direct_key = 'self:' || v_uid;
  if v_id is null then
    insert into public.chat_chats (kind, direct_key, created_by)
    values ('self', 'self:' || v_uid, v_uid)
    on conflict (direct_key) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.chat_chats where direct_key = 'self:' || v_uid;
    else
      insert into public.chat_members (chat_id, user_id, role) values (v_id, v_uid, 'owner');
    end if;
  end if;
  return v_id;
end;
$$;

-- Личный чат с человеком портала: есть — тот же, нет — новый.
create or replace function public.chat_open_direct(p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_key text;
  v_id uuid;
begin
  if p_user = v_uid then
    return public.chat_open_self();
  end if;
  if p_user is null or not public.is_portal_user(p_user) then
    raise exception 'chat_user_unknown' using errcode = '22023';
  end if;
  v_key := least(v_uid::text, p_user::text) || ':' || greatest(v_uid::text, p_user::text);
  select id into v_id from public.chat_chats where direct_key = v_key;
  if v_id is null then
    insert into public.chat_chats (kind, direct_key, created_by)
    values ('direct', v_key, v_uid)
    on conflict (direct_key) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.chat_chats where direct_key = v_key;
    else
      insert into public.chat_members (chat_id, user_id, role)
      values (v_id, v_uid, 'member'), (v_id, p_user, 'member');
    end if;
  end if;
  return v_id;
end;
$$;

-- Системное сообщение группы (создана, добавлены, вышли, переименована).
-- content: {"system": {"type": …, "actor": uuid, "users": [uuid], "title": …}}.
create or replace function public.chat_system_message(p_chat uuid, p_actor uuid, p_system jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  update public.chat_chats set last_seq = last_seq + 1 where id = p_chat
  returning last_seq into v_seq;
  insert into public.chat_messages (chat_id, seq, author_id, kind, content, body_text)
  values (p_chat, v_seq, p_actor, 'system', jsonb_build_object('system', p_system), '');
  update public.chat_chats
     set last_message = jsonb_build_object('seq', v_seq, 'author_id', p_actor, 'kind', 'system',
                                           'system', p_system, 'text', ''),
         last_message_at = now(), updated_at = now()
   where id = p_chat;
  update public.chat_members set last_read_seq = v_seq
   where chat_id = p_chat and user_id = p_actor;
end;
$$;

create or replace function public.chat_create_group(
  p_title text,
  p_members uuid[],
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
  v_added uuid[];
begin
  if char_length(v_title) not between 1 and 100 then
    raise exception 'chat_title_invalid' using errcode = '22023';
  end if;
  insert into public.chat_chats (kind, title, description, created_by, settings)
  values ('group', v_title, nullif(btrim(coalesce(p_description, '')), ''), v_uid,
          '{"pin": "admins", "post": "all", "add": "admins"}'::jsonb)
  returning id into v_id;
  insert into public.chat_members (chat_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.chat_members (chat_id, user_id, role)
  select v_id, u, 'member'
    from (select distinct unnest(coalesce(p_members, '{}'::uuid[])) u) x
   where u <> v_uid and public.is_portal_user(u)
   limit 1000;
  select coalesce(array_agg(user_id), '{}') into v_added
    from public.chat_members where chat_id = v_id and user_id <> v_uid;
  perform public.chat_system_message(v_id, v_uid,
    jsonb_build_object('type', 'created', 'title', v_title, 'users', to_jsonb(v_added)));
  perform public.chat_broadcast(v_id, jsonb_build_object('type', 'chat'));
  return v_id;
end;
$$;

-- Название, описание, настройки группы — владелец и админы.
create or replace function public.chat_update(p_chat uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, auth.uid());
  c public.chat_chats;
  v_title text;
  v_settings jsonb;
begin
  select * into c from public.chat_chats where id = p_chat;
  if v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if c.kind <> 'group' or v_role = 'member' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  v_title := case when p ? 'title' then btrim(coalesce(p->>'title', '')) else c.title end;
  if char_length(v_title) not between 1 and 100 then
    raise exception 'chat_title_invalid' using errcode = '22023';
  end if;
  v_settings := c.settings;
  if p ? 'settings' then
    v_settings := v_settings || jsonb_strip_nulls(jsonb_build_object(
      'pin', case when p->'settings'->>'pin' in ('admins', 'all') then p->'settings'->>'pin' end,
      'post', case when p->'settings'->>'post' in ('admins', 'all') then p->'settings'->>'post' end,
      'add', case when p->'settings'->>'add' in ('admins', 'all') then p->'settings'->>'add' end));
  end if;
  update public.chat_chats
     set title = v_title,
         description = case when p ? 'description'
                             then left(nullif(btrim(coalesce(p->>'description', '')), ''), 1000)
                             else description end,
         settings = v_settings,
         updated_at = now()
   where id = p_chat;
  if v_title is distinct from c.title then
    perform public.chat_system_message(p_chat, v_uid,
      jsonb_build_object('type', 'renamed', 'title', v_title));
  end if;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'chat'));
end;
$$;

create or replace function public.chat_members_add(p_chat uuid, p_users uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
  c public.chat_chats;
  v_added uuid[];
begin
  select * into c from public.chat_chats where id = p_chat for update;
  if v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if c.kind <> 'group' or (v_role = 'member' and coalesce(c.settings->>'add', 'admins') <> 'all') then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  with ins as (
    insert into public.chat_members (chat_id, user_id, role, joined_seq, last_read_seq)
    select p_chat, u, 'member', c.last_seq, c.last_seq
      from (select distinct unnest(coalesce(p_users, '{}'::uuid[])) u) x
     where public.is_portal_user(u)
    on conflict do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into v_added from ins;
  if cardinality(v_added) > 0 then
    perform public.chat_system_message(p_chat, v_uid,
      jsonb_build_object('type', 'added', 'users', to_jsonb(v_added)));
    perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'members'));
  end if;
  return cardinality(v_added);
end;
$$;

-- Убрать участника (админ) или выйти самому. Владелец вышел — владельцем
-- становится старший админ, иначе самый давний участник; никого — группа
-- удаляется.
create or replace function public.chat_member_remove(p_chat uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
  v_target text := public.chat_role(p_chat, p_user);
  c public.chat_chats;
  v_next uuid;
begin
  select * into c from public.chat_chats where id = p_chat for update;
  if v_role is null or v_target is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if c.kind <> 'group' then
    raise exception 'chat_not_group' using errcode = '22023';
  end if;
  if p_user <> v_uid and (v_role = 'member' or v_target = 'owner'
                          or (v_role = 'admin' and v_target = 'admin')) then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'removed'), array[p_user]);
  delete from public.chat_members where chat_id = p_chat and user_id = p_user;
  delete from public.chat_folders f where f.user_id = p_user and p_chat = any (f.chat_ids);
  if not exists (select 1 from public.chat_members where chat_id = p_chat) then
    delete from public.chat_chats where id = p_chat;
    return;
  end if;
  if v_target = 'owner' then
    select user_id into v_next from public.chat_members
     where chat_id = p_chat
     order by case role when 'admin' then 0 else 1 end, joined_at
     limit 1;
    update public.chat_members set role = 'owner' where chat_id = p_chat and user_id = v_next;
  end if;
  perform public.chat_system_message(p_chat, v_uid,
    jsonb_build_object('type', case when p_user = v_uid then 'left' else 'removed' end,
                       'users', jsonb_build_array(p_user)));
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'members'));
end;
$$;

-- Роль участника группы: админ / участник (владелец — один, передаётся
-- только уходом).
create or replace function public.chat_member_set_role(p_chat uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if public.chat_role(p_chat, v_uid) <> 'owner' then
    raise exception 'chat_owner_only' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'member') or public.chat_role(p_chat, p_user) in ('owner') then
    raise exception 'chat_role_invalid' using errcode = '22023';
  end if;
  update public.chat_members set role = p_role where chat_id = p_chat and user_id = p_user;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'members'));
end;
$$;

-- Удалить группу целиком — владелец.
create or replace function public.chat_delete_group(p_chat uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if public.chat_role(p_chat, v_uid) is distinct from 'owner'
     or (select kind from public.chat_chats where id = p_chat) <> 'group' then
    raise exception 'chat_owner_only' using errcode = '42501';
  end if;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'removed'));
  update public.chat_folders set chat_ids = array_remove(chat_ids, p_chat)
   where p_chat = any (chat_ids);
  delete from public.chat_chats where id = p_chat;
end;
$$;

-- 7. Сообщения ------------------------------------------------------------------

-- Упоминания из документа редактора: узлы mention с attrs.id (uuid или «all»).
create or replace function public.chat_content_mentions(p_content jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(distinct x), '{}')
    from (
      select n->'attrs'->>'id' as x
        from jsonb_path_query(coalesce(p_content, '{}'::jsonb), 'strict $.** ? (@.type == "mention")') n
    ) s
   where x is not null
$$;

create or replace function public.chat_check_attachments(p_chat uuid, p_attachments jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  a jsonb;
  out jsonb := '[]'::jsonb;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
    return '[]'::jsonb;
  end if;
  if jsonb_array_length(p_attachments) > 20 then
    raise exception 'chat_too_many_files' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(a) <> 'object' or coalesce(a->>'path', '') not like p_chat::text || '/%'
       or char_length(a->>'path') > 500 or coalesce(a->>'name', '') = '' then
      raise exception 'chat_file_invalid' using errcode = '22023';
    end if;
    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'path', a->>'path',
      'name', left(a->>'name', 200),
      'mime', left(coalesce(a->>'mime', 'application/octet-stream'), 100),
      'size', case when jsonb_typeof(a->'size') = 'number' then (a->>'size')::bigint end,
      'width', case when jsonb_typeof(a->'width') = 'number' then (a->>'width')::int end,
      'height', case when jsonb_typeof(a->'height') = 'number' then (a->>'height')::int end)));
  end loop;
  return out;
end;
$$;

-- Превью для списка чатов и пуша.
create or replace function public.chat_preview_text(p_text text, p_attachments jsonb)
returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(p_text, '')) <> '' then left(regexp_replace(btrim(p_text), '\s+', ' ', 'g'), 200)
    when jsonb_array_length(coalesce(p_attachments, '[]')) = 0 then ''
    when (p_attachments->0->>'mime') like 'image/%' then 'Фото'
    when (p_attachments->0->>'mime') like 'video/%' then 'Видео'
    else 'Файл: ' || coalesce(p_attachments->0->>'name', '')
  end
$$;

create or replace function public.chat_display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(p.full_name), ''), 'Сотрудник')
    from (select 1) one left join public.profiles p on p.id = p_user
$$;

-- Уведомления участникам о новом сообщении.
create or replace function public.chat_notify_message(m public.chat_messages)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_chats;
  r record;
  v_author text := public.chat_display_name(m.author_id);
  v_preview text := public.chat_preview_text(m.body_text, m.attachments);
  v_url text := '/chats/' || m.chat_id || '?m=' || m.seq;
  v_reply_author uuid;
  v_title text;
begin
  select * into c from public.chat_chats where id = m.chat_id;
  if m.reply_to_seq is not null then
    select author_id into v_reply_author from public.chat_messages
     where chat_id = m.chat_id and seq = m.reply_to_seq;
  end if;
  for r in
    select cm.user_id, cm.notify, cm.muted_until
      from public.chat_members cm
     where cm.chat_id = m.chat_id and cm.user_id is distinct from m.author_id
  loop
    continue when r.notify = 'none';
    if r.user_id = any (m.mentions) or m.mention_all or r.user_id = v_reply_author then
      v_title := case when r.user_id = v_reply_author and not (r.user_id = any (m.mentions) or m.mention_all)
                      then 'Ответ от ' || v_author else 'Упоминание от ' || v_author end;
      perform public.notif_send_ex(r.user_id, 'chat.mention', v_title,
        case when c.kind = 'group' then '«' || c.title || '»: ' else '' end || v_preview,
        v_url, m.author_id, 'chatmention:' || m.chat_id, false, true);
    elsif r.notify = 'all' and (r.muted_until is null or r.muted_until < now()) then
      if c.kind = 'direct' then
        perform public.notif_send_ex(r.user_id, 'chat.direct', v_author, v_preview, v_url,
          m.author_id, 'chat:' || m.chat_id, false, false);
      elsif c.kind = 'group' then
        perform public.notif_send_ex(r.user_id, 'chat.group', c.title, v_author || ': ' || v_preview,
          v_url, m.author_id, 'chat:' || m.chat_id, false, false);
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.chat_send(
  p_chat uuid,
  p_content jsonb,
  p_text text,
  p_reply_to bigint default null,
  p_attachments jsonb default '[]'::jsonb,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
  c public.chat_chats;
  m public.chat_messages;
  v_text text := btrim(coalesce(p_text, ''));
  v_files jsonb;
  v_ids text[];
  v_mentions uuid[];
  v_all boolean;
begin
  if v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if p_client_id is not null then
    select * into m from public.chat_messages where chat_id = p_chat and client_id = p_client_id;
    if found then
      return public.chat_message_json(m, v_uid);
    end if;
  end if;
  select * into c from public.chat_chats where id = p_chat for update;
  if c.kind = 'group' and coalesce(c.settings->>'post', 'all') = 'admins' and v_role = 'member' then
    raise exception 'chat_post_admins_only' using errcode = '42501';
  end if;
  v_files := public.chat_check_attachments(p_chat, p_attachments);
  if v_text = '' and jsonb_array_length(v_files) = 0 then
    raise exception 'chat_message_empty' using errcode = '22023';
  end if;
  if char_length(v_text) > 10000 or pg_column_size(p_content) > 200000 then
    raise exception 'chat_message_too_long' using errcode = '22023';
  end if;
  v_ids := public.chat_content_mentions(p_content);
  v_all := 'all' = any (v_ids) and c.kind = 'group' and v_role in ('owner', 'admin');
  select coalesce(array_agg(cm.user_id), '{}') into v_mentions
    from public.chat_members cm
   where cm.chat_id = p_chat and cm.user_id::text = any (v_ids);

  insert into public.chat_messages (chat_id, seq, author_id, content, body_text, reply_to_seq,
                                    mentions, mention_all, attachments, client_id)
  values (p_chat, c.last_seq + 1, v_uid, p_content, v_text,
          case when p_reply_to is not null and exists (
                 select 1 from public.chat_messages r where r.chat_id = p_chat and r.seq = p_reply_to)
               then p_reply_to end,
          v_mentions, v_all, v_files, p_client_id)
  returning * into m;

  update public.chat_chats
     set last_seq = m.seq,
         last_message = jsonb_build_object('seq', m.seq, 'author_id', v_uid, 'kind', 'text',
                                           'text', public.chat_preview_text(v_text, v_files)),
         last_message_at = m.created_at,
         updated_at = now()
   where id = p_chat;
  update public.chat_members set last_read_seq = m.seq where chat_id = p_chat and user_id = v_uid;

  perform public.chat_notify_message(m);
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'message', 'seq', m.seq));
  return public.chat_message_json(m, v_uid);
end;
$$;

-- Превью чата заново (последнее сообщение изменили или удалили).
create or replace function public.chat_refresh_preview(p_chat uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.chat_chats c
     set last_message = (
       select jsonb_build_object('seq', m.seq, 'author_id', m.author_id, 'kind', m.kind,
                                 'text', case when m.deleted_at is null
                                              then public.chat_preview_text(m.body_text, m.attachments)
                                              else '' end,
                                 'deleted', m.deleted_at is not null,
                                 'system', m.content->'system')
         from public.chat_messages m
        where m.chat_id = c.id order by m.seq desc limit 1)
   where c.id = p_chat
$$;

create or replace function public.chat_edit(p_message uuid, p_content jsonb, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  v_text text := btrim(coalesce(p_text, ''));
  v_ids text[];
begin
  select * into m from public.chat_messages where id = p_message for update;
  if not found or public.chat_role(m.chat_id, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.author_id is distinct from v_uid or m.kind <> 'text' or m.deleted_at is not null then
    raise exception 'chat_edit_forbidden' using errcode = '42501';
  end if;
  if v_text = '' and jsonb_array_length(m.attachments) = 0 then
    raise exception 'chat_message_empty' using errcode = '22023';
  end if;
  if char_length(v_text) > 10000 or pg_column_size(p_content) > 200000 then
    raise exception 'chat_message_too_long' using errcode = '22023';
  end if;
  v_ids := public.chat_content_mentions(p_content);
  update public.chat_messages
     set content = p_content,
         body_text = v_text,
         mentions = (select coalesce(array_agg(cm.user_id), '{}') from public.chat_members cm
                      where cm.chat_id = m.chat_id and cm.user_id::text = any (v_ids)),
         edited_at = now()
   where id = p_message
  returning * into m;
  if m.seq = (select last_seq from public.chat_chats where id = m.chat_id) then
    perform public.chat_refresh_preview(m.chat_id);
  end if;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'edit', 'seq', m.seq));
  return public.chat_message_json(m, v_uid);
end;
$$;

-- Удалить: автор — своё, владелец и админы группы — любое.
create or replace function public.chat_delete_message(p_message uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  v_role text;
begin
  select * into m from public.chat_messages where id = p_message for update;
  v_role := public.chat_role(m.chat_id, v_uid);
  if not found or v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.kind <> 'text' or (m.author_id is distinct from v_uid and v_role = 'member')
     or (m.author_id is distinct from v_uid
         and (select kind from public.chat_chats where id = m.chat_id) <> 'group') then
    raise exception 'chat_delete_forbidden' using errcode = '42501';
  end if;
  if m.deleted_at is not null then
    return;
  end if;
  update public.chat_messages
     set deleted_at = now(), content = null, body_text = '', attachments = '[]'::jsonb,
         mentions = '{}', mention_all = false
   where id = p_message;
  delete from public.chat_pins where message_id = p_message;
  delete from public.chat_reactions where message_id = p_message;
  if m.seq = (select last_seq from public.chat_chats where id = m.chat_id) then
    perform public.chat_refresh_preview(m.chat_id);
  end if;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'delete', 'seq', m.seq));
end;
$$;

create or replace function public.chat_react(p_message uuid, p_emoji text, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  v_emoji text := btrim(coalesce(p_emoji, ''));
begin
  select * into m from public.chat_messages where id = p_message;
  if not found or public.chat_role(m.chat_id, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.deleted_at is not null or m.kind <> 'text' then
    raise exception 'chat_react_forbidden' using errcode = '22023';
  end if;
  if char_length(v_emoji) not between 1 and 16 then
    raise exception 'chat_emoji_invalid' using errcode = '22023';
  end if;
  if p_on then
    if (select count(distinct emoji) from public.chat_reactions where message_id = p_message) >= 20
       and not exists (select 1 from public.chat_reactions where message_id = p_message and emoji = v_emoji) then
      raise exception 'chat_too_many_reactions' using errcode = '22023';
    end if;
    insert into public.chat_reactions (message_id, user_id, emoji)
    values (p_message, v_uid, v_emoji) on conflict do nothing;
  else
    delete from public.chat_reactions
     where message_id = p_message and user_id = v_uid and emoji = v_emoji;
  end if;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'react', 'seq', m.seq));
  return public.chat_message_json(m, v_uid);
end;
$$;

-- Закрепить: в группе — по настройке (по умолчанию админы), в личном и
-- «Избранном» — любой.
create or replace function public.chat_pin(p_message uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  c public.chat_chats;
  v_role text;
begin
  select * into m from public.chat_messages where id = p_message;
  v_role := public.chat_role(m.chat_id, v_uid);
  if not found or v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  select * into c from public.chat_chats where id = m.chat_id;
  if c.kind = 'group' and coalesce(c.settings->>'pin', 'admins') = 'admins' and v_role = 'member' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  if p_on then
    if m.deleted_at is not null or m.kind <> 'text' then
      raise exception 'chat_pin_forbidden' using errcode = '22023';
    end if;
    insert into public.chat_pins (chat_id, message_id, pinned_by)
    values (m.chat_id, p_message, v_uid) on conflict do nothing;
  else
    delete from public.chat_pins where message_id = p_message;
  end if;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'pin', 'seq', m.seq));
end;
$$;

-- Переслать сообщения в другие чаты (по порядку). Файлы не копируются:
-- читать их позволяет chat_file_allowed (сообщение с этим файлом в чате
-- получателя).
create or replace function public.chat_forward(p_messages uuid[], p_to uuid[], p_comment jsonb default null,
                                               p_comment_text text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_to uuid;
  v_count integer := 0;
  src record;
begin
  if cardinality(coalesce(p_messages, '{}')) = 0 or cardinality(coalesce(p_messages, '{}')) > 100
     or cardinality(coalesce(p_to, '{}')) = 0 or cardinality(coalesce(p_to, '{}')) > 20 then
    raise exception 'chat_forward_invalid' using errcode = '22023';
  end if;
  if exists (select 1 from public.chat_messages m
              where m.id = any (p_messages)
                and (public.chat_role(m.chat_id, v_uid) is null or m.deleted_at is not null
                     or m.kind <> 'text')) then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  foreach v_to in array (select array_agg(distinct x) from unnest(p_to) x) loop
    if public.chat_role(v_to, v_uid) is null then
      raise exception 'chat_forbidden' using errcode = '42501';
    end if;
    if btrim(coalesce(p_comment_text, '')) <> '' then
      perform public.chat_send(v_to, p_comment, p_comment_text);
    end if;
    for src in
      select m.* from public.chat_messages m
       where m.id = any (p_messages) order by m.chat_id, m.seq
    loop
      perform public.chat_forward_one(v_to, v_uid, src.id);
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

create or replace function public.chat_forward_one(p_to uuid, p_uid uuid, p_message uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  src public.chat_messages;
  c public.chat_chats;
  m public.chat_messages;
begin
  select * into src from public.chat_messages where id = p_message;
  select * into c from public.chat_chats where id = p_to for update;
  if c.kind = 'group' and coalesce(c.settings->>'post', 'all') = 'admins'
     and public.chat_role(p_to, p_uid) = 'member' then
    raise exception 'chat_post_admins_only' using errcode = '42501';
  end if;
  insert into public.chat_messages (chat_id, seq, author_id, content, body_text, forward, attachments)
  values (p_to, c.last_seq + 1, p_uid, src.content, src.body_text,
          coalesce(src.forward, jsonb_build_object('chat_id', src.chat_id, 'seq', src.seq,
                                                   'author_id', src.author_id,
                                                   'created_at', src.created_at)),
          src.attachments)
  returning * into m;
  update public.chat_chats
     set last_seq = m.seq,
         last_message = jsonb_build_object('seq', m.seq, 'author_id', p_uid, 'kind', 'text',
                                           'text', public.chat_preview_text(m.body_text, m.attachments),
                                           'forward', true),
         last_message_at = m.created_at, updated_at = now()
   where id = p_to;
  update public.chat_members set last_read_seq = m.seq where chat_id = p_to and user_id = p_uid;
  perform public.chat_notify_message(m);
  perform public.chat_broadcast(p_to, jsonb_build_object('type', 'message', 'seq', m.seq));
end;
$$;

-- 8. Прочтение и личные настройки чата ---------------------------------------

create or replace function public.chat_mark_read(p_chat uuid, p_seq bigint default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_chats;
  v_old bigint;
  v_new bigint;
  v_members integer;
begin
  select * into c from public.chat_chats where id = p_chat;
  select last_read_seq into v_old from public.chat_members where chat_id = p_chat and user_id = v_uid;
  if not found then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  v_new := greatest(v_old, least(coalesce(p_seq, c.last_seq), c.last_seq));
  if v_new = v_old then
    return v_new;
  end if;
  update public.chat_members set last_read_seq = v_new where chat_id = p_chat and user_id = v_uid;
  if v_new >= c.last_seq then
    update public.notif_items set read_at = now()
     where user_id = v_uid and read_at is null
       and group_key in ('chat:' || p_chat, 'chatmention:' || p_chat);
  end if;
  -- «Прочитано» — собеседнику и небольшой группе (большой группе каждое
  -- прочтение каждого участника — лишний шум).
  select count(*) into v_members from public.chat_members where chat_id = p_chat;
  if v_members <= 30 then
    perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'read', 'seq', v_new,
                                                            'user_id', v_uid));
  else
    perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'read', 'seq', v_new,
                                                            'user_id', v_uid), array[v_uid]);
  end if;
  return v_new;
end;
$$;

-- «Прочитать всё» в папке.
create or replace function public.chat_mark_all_read(p_chats uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in
    select cm.chat_id from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
     where cm.user_id = v_uid and cm.chat_id = any (coalesce(p_chats, '{}'))
       and c.last_seq > cm.last_read_seq
  loop
    perform public.chat_mark_read(v_id, null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.chat_set_notify(p_chat uuid, p_notify text, p_muted_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if p_notify not in ('all', 'mentions', 'none') then
    raise exception 'chat_notify_invalid' using errcode = '22023';
  end if;
  update public.chat_members set notify = p_notify, muted_until = p_muted_until
   where chat_id = p_chat and user_id = v_uid;
  if not found then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.chat_set_pinned(p_chat uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  update public.chat_members set pinned_at = case when p_on then now() end
   where chat_id = p_chat and user_id = v_uid;
  if not found then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
end;
$$;

-- 9. Папки --------------------------------------------------------------------

create or replace function public.chat_folders_list()
returns table (id uuid, title text, sort_order integer, chat_ids uuid[])
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.title, f.sort_order,
         array(select x from unnest(f.chat_ids) x
                where exists (select 1 from public.chat_members cm
                               where cm.chat_id = x and cm.user_id = auth.uid()))
    from public.chat_folders f
   where f.user_id = auth.uid()
   order by f.sort_order, f.created_at
$$;

-- Новая (p_id null) или правка своей папки. Не больше 20 папок.
create or replace function public.chat_folder_save(p_id uuid, p_title text, p_chat_ids uuid[],
                                                   p_sort_order integer default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_title text := btrim(coalesce(p_title, ''));
  v_ids uuid[];
  v_id uuid;
begin
  if char_length(v_title) not between 1 and 40 then
    raise exception 'chat_folder_title_invalid' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids
    from unnest(coalesce(p_chat_ids, '{}')) x
   where exists (select 1 from public.chat_members cm where cm.chat_id = x and cm.user_id = v_uid);
  if p_id is null then
    if (select count(*) from public.chat_folders where user_id = v_uid) >= 20 then
      raise exception 'chat_too_many_folders' using errcode = '22023';
    end if;
    insert into public.chat_folders (user_id, title, chat_ids, sort_order)
    values (v_uid, v_title, v_ids,
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.chat_folders
                                     where user_id = v_uid)))
    returning id into v_id;
  else
    update public.chat_folders
       set title = v_title, chat_ids = v_ids, sort_order = coalesce(p_sort_order, sort_order)
     where id = p_id and user_id = v_uid
    returning id into v_id;
    if v_id is null then
      raise exception 'chat_forbidden' using errcode = '42501';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.chat_folder_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.chat_folders where id = p_id and user_id = auth.uid()
$$;

-- 10. Права на функции ----------------------------------------------------------

do $$
declare
  f text;
begin
  -- Внутренние: браузеру не выдаются.
  foreach f in array array[
    'public.notif_send_ex(uuid, text, text, text, text, uuid, text, boolean, boolean)',
    'public.portal_badge_count(uuid)',
    'public.chat_role(uuid, uuid)',
    'public.chat_broadcast(uuid, jsonb, uuid[])',
    'public.chat_message_json(public.chat_messages, uuid)',
    'public.chat_require_portal()',
    'public.chat_system_message(uuid, uuid, jsonb)',
    'public.chat_check_attachments(uuid, jsonb)',
    'public.chat_notify_message(public.chat_messages)',
    'public.chat_refresh_preview(uuid)',
    'public.chat_forward_one(uuid, uuid, uuid)',
    'public.chat_display_name(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- Браузеру (каждая проверяет вызывающего сама).
  foreach f in array array[
    'public.chat_topic_member(text)',
    'public.chat_file_allowed(text, boolean)',
    'public.chat_list()',
    'public.chat_unread_summary()',
    'public.chat_messages_page(uuid, bigint, bigint, bigint, integer)',
    'public.chat_members_list(uuid)',
    'public.chat_read_receipts(uuid)',
    'public.chat_pinned(uuid)',
    'public.chat_search(text, uuid, integer)',
    'public.chat_files(uuid, text, bigint, integer)',
    'public.chat_links(uuid, integer)',
    'public.chat_open_self()',
    'public.chat_open_direct(uuid)',
    'public.chat_create_group(text, uuid[], text)',
    'public.chat_update(uuid, jsonb)',
    'public.chat_members_add(uuid, uuid[])',
    'public.chat_member_remove(uuid, uuid)',
    'public.chat_member_set_role(uuid, uuid, text)',
    'public.chat_delete_group(uuid)',
    'public.chat_send(uuid, jsonb, text, bigint, jsonb, uuid)',
    'public.chat_edit(uuid, jsonb, text)',
    'public.chat_delete_message(uuid)',
    'public.chat_react(uuid, text, boolean)',
    'public.chat_pin(uuid, boolean)',
    'public.chat_forward(uuid[], uuid[], jsonb, text)',
    'public.chat_mark_read(uuid, bigint)',
    'public.chat_mark_all_read(uuid[])',
    'public.chat_set_notify(uuid, text, timestamptz)',
    'public.chat_set_pinned(uuid, boolean)',
    'public.chat_folders_list()',
    'public.chat_folder_save(uuid, text, uuid[], integer)',
    'public.chat_folder_delete(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  grant execute on function public.notif_send_ex(uuid, text, text, text, text, uuid, text, boolean, boolean)
    to service_role;
end $$;

notify pgrst, 'reload schema';
