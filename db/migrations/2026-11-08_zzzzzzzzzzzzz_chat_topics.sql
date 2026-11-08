-- ============================================================================
-- Темы в группах (TASKS_CHATS_PLAN.md, этап 2, Д.5 — «как в Telegram»;
-- 2026-11-08). В группе (не в канале) админы включают «Темы»: переписка
-- делится на темы — «Отчёты», «Акции», «Вопросы по 1С»…; прежняя
-- переписка группы остаётся темой «Общая» (это сам чат группы).
--
-- Тема — отдельный чат `chat_chats.kind = 'topic'` с `parent_id` = группа:
-- сообщения, файлы (папка темы в `chat-files`), прочтение, реакции,
-- закрепы, поиск и звонки работают как в любом чате. Участники темы — все
-- участники группы с теми же ролями: строки `chat_members` темы ведёт
-- триггер `chat_members_topics_sync` (добавили или убрали человека в
-- группе, сменили роль — так же во всех темах; новенький видит историю, но
-- не получает её непрочитанной). У каждого в теме — своё «прочитано» и свои
-- уведомления; уведомления группы действуют и на её темы (тишина группы —
-- тишина тем, кроме упоминаний).
--
-- Настройки группы: `settings.topics` (включены), `settings.topic_create`
-- (`admins` — темы заводят владелец и админы, `all` — все). У темы —
-- `settings.color` (ключ набора цветов) и `settings.closed` (закрыта: пишут
-- только владелец и админы группы). Писать в тему нельзя, если в группе
-- «пишут только админы» или тема закрыта (триггер `chat_messages_topic_guard`
-- — ни один путь отправки его не обойдёт). Темы не выключаются, пока они
-- есть (`chat_topics_exist`). Удалить группу — с темами; удалить тему —
-- её автор или админы (чат темы уходит с файлами — уборка чатов).
--
-- RPC: `chat_topics_enable`, `chat_topic_create`, `chat_topic_update`,
-- `chat_topic_delete`. `chat_list` — с `parent_id` (темы — строками, их
-- сворачивает в группу портал); счётчики `chat_unread_summary` и
-- `portal_badge_count` считают группу с темами одним чатом. Актуальные
-- определения `chat_list`, `chat_unread_summary`, `portal_badge_count`,
-- `chat_notify_message` — здесь. Идемпотентно.
-- ============================================================================

-- 1. Тема — чат внутри группы ----------------------------------------------------

alter table public.chat_chats add column if not exists parent_id uuid
  references public.chat_chats (id) on delete cascade;
create index if not exists chat_chats_parent_idx on public.chat_chats (parent_id) where parent_id is not null;

alter table public.chat_chats drop constraint if exists chat_chats_kind_check;
alter table public.chat_chats add constraint chat_chats_kind_check
  check (kind in ('direct', 'group', 'self', 'task', 'project', 'event', 'topic'));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_chats_topic_parent_check') then
    alter table public.chat_chats add constraint chat_chats_topic_parent_check
      check ((kind = 'topic') = (parent_id is not null));
  end if;
end $$;

-- Группа с темами: да / нет.
create or replace function public.chat_has_topics(p_chat uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select kind = 'group' and coalesce((settings->>'topics')::boolean, false)
                     from public.chat_chats where id = p_chat), false)
$$;

-- 2. Участники тем = участники группы ------------------------------------------------

create or replace function public.chat_members_topics_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid := coalesce(new.chat_id, old.chat_id);
begin
  if not public.chat_has_topics(v_chat) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    delete from public.chat_members tm
     using public.chat_chats t
     where t.parent_id = v_chat and tm.chat_id = t.id and tm.user_id = old.user_id;
  else
    insert into public.chat_members (chat_id, user_id, role, joined_seq, last_read_seq)
    select t.id, new.user_id, new.role, t.last_seq, t.last_seq
      from public.chat_chats t
     where t.parent_id = v_chat
    on conflict (chat_id, user_id) do update set role = excluded.role;
  end if;
  return null;
end;
$$;
drop trigger if exists chat_members_topics_sync_aiud on public.chat_members;
create trigger chat_members_topics_sync_aiud
  after insert or delete or update of role on public.chat_members
  for each row execute function public.chat_members_topics_sync();

-- 3. Кто пишет в тему: закрытая тема и «пишут только админы» группы ------------

create or replace function public.chat_messages_topic_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.chat_chats;
  g public.chat_chats;
begin
  if new.kind <> 'text' then
    return new;
  end if;
  select * into t from public.chat_chats where id = new.chat_id;
  if t.kind is distinct from 'topic' then
    return new;
  end if;
  if public.chat_role(new.chat_id, new.author_id) in ('owner', 'admin') then
    return new;
  end if;
  select * into g from public.chat_chats where id = t.parent_id;
  if coalesce((t.settings->>'closed')::boolean, false) then
    raise exception 'chat_topic_closed' using errcode = '42501';
  end if;
  if coalesce(g.settings->>'post', 'all') = 'admins' then
    raise exception 'chat_post_admins_only' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists chat_messages_topic_guard_bi on public.chat_messages;
create trigger chat_messages_topic_guard_bi
  before insert on public.chat_messages
  for each row execute function public.chat_messages_topic_guard();

-- 4. Включить, завести, изменить, удалить ------------------------------------------

create or replace function public.chat_topics_enable(p_chat uuid, p_on boolean, p_create text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_chats;
begin
  select * into c from public.chat_chats where id = p_chat for update;
  if not found or public.chat_role(p_chat, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if c.kind <> 'group' or coalesce((c.settings->>'channel')::boolean, false) then
    raise exception 'chat_topics_group_only' using errcode = '22023';
  end if;
  if public.chat_role(p_chat, v_uid) not in ('owner', 'admin') then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  if not coalesce(p_on, false) and exists (select 1 from public.chat_chats where parent_id = p_chat) then
    raise exception 'chat_topics_exist' using errcode = '22023';
  end if;
  update public.chat_chats
     set settings = settings || jsonb_build_object(
           'topics', coalesce(p_on, false),
           'topic_create', case when p_create in ('admins', 'all') then p_create
                                else coalesce(settings->>'topic_create', 'admins') end),
         updated_at = now()
   where id = p_chat;
  if coalesce(p_on, false) is distinct from coalesce((c.settings->>'topics')::boolean, false) then
    perform public.chat_system_message(p_chat, v_uid,
      jsonb_build_object('type', case when p_on then 'topics_on' else 'topics_off' end));
  end if;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'chat'));
end;
$$;

create or replace function public.chat_topic_create(p_chat uuid, p_title text, p_color text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
  c public.chat_chats;
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
begin
  select * into c from public.chat_chats where id = p_chat for update;
  if not found or v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if not public.chat_has_topics(p_chat) then
    raise exception 'chat_topics_off' using errcode = '22023';
  end if;
  if v_role = 'member' and coalesce(c.settings->>'topic_create', 'admins') <> 'all' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  if char_length(v_title) not between 1 and 100 then
    raise exception 'chat_title_invalid' using errcode = '22023';
  end if;
  if (select count(*) from public.chat_chats where parent_id = p_chat) >= 100 then
    raise exception 'chat_topics_limit' using errcode = '22023';
  end if;
  insert into public.chat_chats (kind, parent_id, title, created_by, settings)
  values ('topic', p_chat, v_title, v_uid,
          jsonb_build_object('pin', 'all', 'post', 'all', 'add', 'admins',
                             'color', coalesce(nullif(p_color, ''), 'blue'), 'closed', false))
  returning id into v_id;
  insert into public.chat_members (chat_id, user_id, role)
  select v_id, m.user_id, m.role from public.chat_members m where m.chat_id = p_chat
  on conflict do nothing;
  perform public.chat_system_message(v_id, v_uid,
    jsonb_build_object('type', 'topic_created', 'title', v_title));
  perform public.chat_broadcast(v_id, jsonb_build_object('type', 'chat'));
  return v_id;
end;
$$;

-- Автор темы или владелец и админы группы.
create or replace function public.chat_topic_manager(p_topic uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select t.created_by = p_uid
           or coalesce(public.chat_role(t.parent_id, p_uid) in ('owner', 'admin'), false)
      from public.chat_chats t
     where t.id = p_topic and t.kind = 'topic'
       and public.chat_role(t.parent_id, p_uid) is not null), false)
$$;

-- p: title, color, closed (закрыть / открыть — автор и админы).
create or replace function public.chat_topic_update(p_topic uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  t public.chat_chats;
  v_title text;
  v_closed boolean;
begin
  select * into t from public.chat_chats where id = p_topic and kind = 'topic' for update;
  if not found or not public.chat_topic_manager(p_topic, v_uid) then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  v_title := case when p ? 'title' then btrim(coalesce(p->>'title', '')) else t.title end;
  if char_length(v_title) not between 1 and 100 then
    raise exception 'chat_title_invalid' using errcode = '22023';
  end if;
  v_closed := case when p ? 'closed' then coalesce((p->>'closed')::boolean, false)
                   else coalesce((t.settings->>'closed')::boolean, false) end;
  update public.chat_chats
     set title = v_title,
         settings = settings || jsonb_strip_nulls(jsonb_build_object(
           'color', case when p ? 'color' then nullif(p->>'color', '') end,
           'closed', v_closed)),
         updated_at = now()
   where id = p_topic;
  if v_title is distinct from t.title then
    perform public.chat_system_message(p_topic, v_uid, jsonb_build_object('type', 'topic_renamed', 'title', v_title));
  end if;
  if v_closed is distinct from coalesce((t.settings->>'closed')::boolean, false) then
    perform public.chat_system_message(p_topic, v_uid,
      jsonb_build_object('type', case when v_closed then 'topic_closed' else 'topic_reopened' end));
  end if;
  perform public.chat_broadcast(p_topic, jsonb_build_object('type', 'chat'));
end;
$$;

create or replace function public.chat_topic_delete(p_topic uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if not exists (select 1 from public.chat_chats where id = p_topic and kind = 'topic') then
    return;
  end if;
  if not public.chat_topic_manager(p_topic, v_uid) then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  perform public.chat_broadcast(p_topic, jsonb_build_object('type', 'removed'));
  update public.chat_folders set chat_ids = array_remove(chat_ids, p_topic)
   where p_topic = any (chat_ids);
  delete from public.chat_chats where id = p_topic;
end;
$$;

-- 5. Список и счётчики ---------------------------------------------------------------

-- Мои чаты для списка (+ parent_id: темы портал сворачивает в группу;
-- created_by — автор темы правит её).
drop function if exists public.chat_list();
create function public.chat_list()
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
  created_at timestamptz,
  parent_id uuid,
  created_by uuid
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
         c.created_at,
         c.parent_id,
         c.created_by
    from public.chat_members cm
    join public.chat_chats c on c.id = cm.chat_id
   where cm.user_id = v_uid
   order by cm.pinned_at desc nulls last, coalesce(c.last_message_at, c.created_at) desc;
end;
$$;

-- Есть новое: в самом чате или в его темах (с уведомлениями темы и группы).
create or replace function public.chat_has_new(p_chat uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_chats t
      join public.chat_members tm on tm.chat_id = t.id and tm.user_id = p_user
     where t.parent_id = p_chat and t.last_seq > tm.last_read_seq and tm.notify <> 'none'
       and (tm.muted_until is null or tm.muted_until < now()))
$$;

create or replace function public.chat_unread_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select (c.last_seq > cm.last_read_seq
            or (c.kind = 'group' and public.chat_has_new(c.id, cm.user_id))) as has_new,
           cm.notify <> 'none' and (cm.muted_until is null or cm.muted_until < now()) as loud
      from public.chat_members cm join public.chat_chats c on c.id = cm.chat_id
     where cm.user_id = auth.uid() and c.kind <> 'topic'
  )
  select jsonb_build_object(
    'chats', count(*) filter (where has_new and loud),
    'muted', count(*) filter (where has_new and not loud))
    from mine
$$;

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
           where cm.user_id = p_user and c.kind <> 'topic' and cm.notify <> 'none'
             and (cm.muted_until is null or cm.muted_until < now())
             and (c.last_seq > cm.last_read_seq
                  or (c.kind = 'group' and public.chat_has_new(c.id, p_user))))
$$;

-- 6. Уведомления: тема — «Группа › Тема», тишина группы действует на тему ------
-- Прежнее определение — 2026-11-08_zzzzzzzzzzz_calendar.sql; актуальное — здесь.
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
  v_name text;
  v_notify text;
  v_muted boolean;
begin
  select * into c from public.chat_chats where id = m.chat_id;
  v_name := case when c.kind = 'topic'
                 then coalesce((select g.title from public.chat_chats g where g.id = c.parent_id), 'Группа')
                      || ' › ' || c.title
                 else c.title end;
  if m.reply_to_seq is not null then
    select author_id into v_reply_author from public.chat_messages
     where chat_id = m.chat_id and seq = m.reply_to_seq;
  end if;
  for r in
    select cm.user_id, cm.notify, cm.muted_until, pm.notify as parent_notify, pm.muted_until as parent_muted
      from public.chat_members cm
      left join public.chat_members pm on c.kind = 'topic' and pm.chat_id = c.parent_id and pm.user_id = cm.user_id
     where cm.chat_id = m.chat_id and cm.user_id is distinct from m.author_id
  loop
    -- Тема: строже из двух — уведомления темы и группы.
    v_notify := case when 'none' in (r.notify, coalesce(r.parent_notify, 'all')) then 'none'
                     when 'mentions' in (r.notify, coalesce(r.parent_notify, 'all')) then 'mentions'
                     else 'all' end;
    v_muted := (r.muted_until is not null and r.muted_until >= now())
               or (r.parent_muted is not null and r.parent_muted >= now());
    continue when v_notify = 'none';
    if r.user_id = any (m.mentions) or m.mention_all or r.user_id = v_reply_author then
      v_title := case when r.user_id = v_reply_author and not (r.user_id = any (m.mentions) or m.mention_all)
                      then 'Ответ от ' || v_author else 'Упоминание от ' || v_author end;
      perform public.notif_send_ex(r.user_id, 'chat.mention', v_title,
        case when c.kind in ('group', 'task', 'project', 'event', 'topic') then '«' || v_name || '»: ' else '' end
          || v_preview,
        v_url, m.author_id, 'chatmention:' || m.chat_id, false, true);
    elsif v_notify = 'all' and not v_muted then
      if c.kind = 'group' and coalesce((c.settings->>'channel')::boolean, false) then
        perform public.notif_send_ex(r.user_id, 'chat.channel', c.title, v_preview, v_url,
          m.author_id, 'chatchannel:' || m.chat_id, false, true);
      elsif c.kind = 'direct' then
        perform public.notif_send_ex(r.user_id, 'chat.direct', v_author, v_preview, v_url,
          m.author_id, 'chat:' || m.chat_id, false, false);
      elsif c.kind in ('group', 'task', 'project', 'event', 'topic') then
        perform public.notif_send_ex(r.user_id, 'chat.group', v_name, v_author || ': ' || v_preview,
          v_url, m.author_id, 'chat:' || m.chat_id, false, false);
      end if;
    end if;
  end loop;
end;
$$;

-- 7. Права на функции ---------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.chat_has_topics(uuid)',
    'public.chat_members_topics_sync()',
    'public.chat_messages_topic_guard()',
    'public.chat_topic_manager(uuid, uuid)',
    'public.chat_has_new(uuid, uuid)',
    'public.portal_badge_count(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chat_topics_enable(uuid, boolean, text)',
    'public.chat_topic_create(uuid, text, text)',
    'public.chat_topic_update(uuid, jsonb)',
    'public.chat_topic_delete(uuid)',
    'public.chat_list()',
    'public.chat_unread_summary()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
