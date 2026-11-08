-- ============================================================================
-- Чаты, этап 2 (TASKS_CHATS_PLAN.md, 2.3, 2.5, 3.3, 2026-11-08): каналы с
-- «Прочитал» и чаты с составом из оргструктуры.
--
-- Строится на группах (`kind = 'group'`): все настройки, роли, закрепы,
-- поиск и папки работают как у группы.
--
-- Канал — группа с `settings.channel = true`: пишут только владелец и
-- админы (`post = 'admins'` держит триггер `chat_chats_channel_biu`), у
-- каждого поста — «Прочитал» (`chat_messages.ack_required` ставит триггер
-- `chat_messages_ack_bi`; отметки — `chat_message_acks`, RPC `chat_ack`;
-- кто отметил и кто нет — `chat_ack_list` автору и админам; «Напомнить» —
-- `chat_ack_remind`, уведомление `chat.ack` не отметившим, не чаще раза в
-- час). Пост канала приходит участникам в ленту и пушем (вид
-- `chat.channel`; актуальное определение `chat_notify_message` — здесь).
-- Создаёт канал право `chats.announce` (новое, «Управление порталом»;
-- суперадминистратор — тоже).
--
-- Состав из оргструктуры: источники `chat_member_sources` — вся компания
-- (`all`: все действующие люди портала — `portal_people_ids`; только с
-- `chats.announce`) или подразделение (`unit`: все или руководители и
-- заместители, с подразделениями ниже или без; право `chats.announce` или
-- руководитель / заместитель этого подразделения или подразделения выше).
-- Участники из источников — `chat_members.source = 'auto'`: добавляются и
-- уходят сами при смене оргструктуры и людей портала (`chat_sync_sources`,
-- триггеры на `org_unit_members`, `org_units`, `access_user_rights`,
-- `user_roles`), вручную их не убрать и сами не выйдут (`chat_auto_member`) —
-- только «без звука». Добавленные вручную — как в обычной группе.
-- `settings.auto` — у чата есть источники (иконка в списке).
--
-- RPC: `chat_create_ex` (группа или канал с источниками), `chat_sources_get`
-- / `chat_sources_save`, `chat_source_options` (что человек может
-- привязать), `chat_ack`, `chat_ack_list`, `chat_ack_remind`;
-- `chat_members_list` — с `source`. Актуальные определения
-- `chat_message_json`, `chat_notify_message`, `chat_members_list` — здесь.
-- Все таблицы закрыты браузеру. Идемпотентно.
-- ============================================================================

-- 1. Право ----------------------------------------------------------------------

insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('chats.announce', 'admin', 'Каналы и чаты подразделений',
   'Создаёт каналы компании (пишут только админы, у постов «Прочитал») и чаты с составом из всей компании или любого подразделения.',
   'network', '{on}', null, 345)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

create or replace function public.chat_can_announce(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(p_uid, 'chats.announce') or public.access_has_right(p_uid, 'portal.admin')
$$;

-- 2. Таблицы и колонки ---------------------------------------------------------------

alter table public.chat_members add column if not exists source text not null default 'manual';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_members_source_check') then
    alter table public.chat_members add constraint chat_members_source_check
      check (source in ('manual', 'auto'));
  end if;
end $$;

create table if not exists public.chat_member_sources (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  kind text not null check (kind in ('all', 'unit')),
  unit_id uuid references public.org_units (id) on delete cascade,
  scope text not null default 'all' check (scope in ('all', 'heads')),
  with_subunits boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chat_member_sources_unit_check check ((kind = 'unit') = (unit_id is not null))
);
create index if not exists chat_member_sources_chat_idx on public.chat_member_sources (chat_id);
create index if not exists chat_member_sources_unit_idx on public.chat_member_sources (unit_id)
  where unit_id is not null;
alter table public.chat_member_sources enable row level security;

alter table public.chat_messages add column if not exists ack_required boolean not null default false;
alter table public.chat_messages add column if not exists ack_reminded_at timestamptz;

create table if not exists public.chat_message_acks (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.chat_message_acks enable row level security;

-- 3. Канал: пишут админы, у постов «Прочитал» ----------------------------------------

create or replace function public.chat_chats_channel_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce((new.settings->>'channel')::boolean, false) then
    new.settings := new.settings || '{"post": "admins"}'::jsonb;
  end if;
  return new;
end;
$$;
drop trigger if exists chat_chats_channel_biu on public.chat_chats;
create trigger chat_chats_channel_biu
  before insert or update of settings on public.chat_chats
  for each row execute function public.chat_chats_channel_biu();

create or replace function public.chat_messages_ack_bi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'text' and exists (
       select 1 from public.chat_chats c
        where c.id = new.chat_id and c.kind = 'group'
          and coalesce((c.settings->>'channel')::boolean, false)) then
    new.ack_required := true;
  end if;
  return new;
end;
$$;
drop trigger if exists chat_messages_ack_bi on public.chat_messages;
create trigger chat_messages_ack_bi
  before insert on public.chat_messages
  for each row execute function public.chat_messages_ack_bi();

-- 4. Состав из оргструктуры -------------------------------------------------------------

-- Кто входит в чат по его источникам.
create or replace function public.chat_source_users(p_chat uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p from public.portal_people_ids() p
   where exists (select 1 from public.chat_member_sources s where s.chat_id = p_chat and s.kind = 'all')
  union
  select m.user_id
    from public.chat_member_sources s
    join public.org_units sub on sub.id = s.unit_id or (s.with_subunits and s.unit_id = any (sub.path))
    join public.org_unit_members m on m.unit_id = sub.id
   where s.chat_id = p_chat and s.kind = 'unit'
     and (s.scope = 'all' or m.member_role in ('head', 'deputy'))
     and public.is_portal_user(m.user_id)
$$;

-- Участников из источников — добавить недостающих, убрать ушедших (только
-- source = 'auto'; добавленных вручную не трогает; сообщений в чат нет).
create or replace function public.chat_sync_sources(p_chat uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_chats;
  v_target uuid[];
  v_changed integer := 0;
  n integer;
  v_auto boolean;
begin
  select * into c from public.chat_chats where id = p_chat;
  if not found then
    return;
  end if;
  select coalesce(array_agg(u), '{}') into v_target from public.chat_source_users(p_chat) u;
  insert into public.chat_members (chat_id, user_id, role, source, joined_seq, last_read_seq)
  select p_chat, u, 'member', 'auto', c.last_seq, c.last_seq
    from unnest(v_target) u
  on conflict (chat_id, user_id) do nothing;
  get diagnostics n = row_count;
  v_changed := v_changed + n;
  perform set_config('chat.syncing', 'on', true);
  delete from public.chat_members cm
   where cm.chat_id = p_chat and cm.source = 'auto' and cm.role <> 'owner'
     and not (cm.user_id = any (v_target));
  get diagnostics n = row_count;
  perform set_config('chat.syncing', 'off', true);
  v_changed := v_changed + n;
  v_auto := exists (select 1 from public.chat_member_sources s where s.chat_id = p_chat);
  if coalesce((c.settings->>'auto')::boolean, false) is distinct from v_auto then
    update public.chat_chats set settings = settings || jsonb_build_object('auto', v_auto)
     where id = p_chat;
  end if;
  if v_changed > 0 then
    perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'members'));
  end if;
end;
$$;

-- Участника из подразделения или «всей компании» не убрать и самому не выйти.
create or replace function public.chat_members_auto_bd()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.source = 'auto'
     and coalesce(current_setting('chat.syncing', true), '') <> 'on'
     and exists (select 1 from public.chat_chats where id = old.chat_id)
     and exists (select 1 from auth.users where id = old.user_id) then
    raise exception 'chat_auto_member' using errcode = '42501';
  end if;
  return old;
end;
$$;
drop trigger if exists chat_members_auto_bd on public.chat_members;
create trigger chat_members_auto_bd
  before delete on public.chat_members
  for each row execute function public.chat_members_auto_bd();

-- Оргструктура или люди портала изменились — пересчитать чаты с источниками.
create or replace function public.chat_sources_resync_units()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select distinct chat_id from public.chat_member_sources where kind = 'unit' loop
    perform public.chat_sync_sources(r.chat_id);
  end loop;
  return null;
end;
$$;

create or replace function public.chat_sources_resync_all()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select distinct chat_id from public.chat_member_sources loop
    perform public.chat_sync_sources(r.chat_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists chat_sources_resync_aiud on public.org_unit_members;
create trigger chat_sources_resync_aiud
  after insert or update or delete on public.org_unit_members
  for each statement execute function public.chat_sources_resync_units();
drop trigger if exists chat_sources_resync_units_au on public.org_units;
create trigger chat_sources_resync_units_au
  after update of parent_id, path on public.org_units
  for each statement execute function public.chat_sources_resync_units();
drop trigger if exists chat_sources_resync_rights_aiud on public.access_user_rights;
create trigger chat_sources_resync_rights_aiud
  after insert or update or delete on public.access_user_rights
  for each statement execute function public.chat_sources_resync_all();
drop trigger if exists chat_sources_resync_roles_aiud on public.user_roles;
create trigger chat_sources_resync_roles_aiud
  after insert or update or delete on public.user_roles
  for each statement execute function public.chat_sources_resync_all();

-- Что человек может привязать: всю компанию (chats.announce) и подразделения
-- (все — с chats.announce; иначе свои как руководителя или заместителя и ниже).
create or replace function public.chat_source_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_announce boolean := public.chat_can_announce(v_uid);
begin
  return jsonb_build_object(
    'announce', v_announce,
    'units', coalesce((
      select jsonb_agg(u.id order by cardinality(u.path), u.sort_order, u.name)
        from public.org_units u
       where v_announce or exists (
               select 1 from public.org_unit_members m
                where m.user_id = v_uid and m.member_role in ('head', 'deputy')
                  and (m.unit_id = u.id or m.unit_id = any (u.path)))), '[]'::jsonb));
end;
$$;

-- Источники из jsonb — проверить и привести к виду; p_keep — уже бывшие
-- в чате (их можно оставлять без прав).
create or replace function public.chat_sources_parse(p_uid uuid, p jsonb, p_keep jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb := '[]'::jsonb;
  e jsonb;
  v_item jsonb;
  v_opts jsonb;
  v_announce boolean := public.chat_can_announce(p_uid);
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    return v_out;
  end if;
  if jsonb_array_length(p) > 20 then
    raise exception 'chat_sources_invalid' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p) loop
    if e->>'kind' = 'all' then
      v_item := jsonb_build_object('kind', 'all', 'unit_id', null, 'scope', 'all', 'with_subunits', true);
    elsif e->>'kind' = 'unit' and exists (select 1 from public.org_units where id = (e->>'unit_id')::uuid) then
      v_item := jsonb_build_object('kind', 'unit', 'unit_id', e->>'unit_id',
        'scope', case when e->>'scope' = 'heads' then 'heads' else 'all' end,
        'with_subunits', coalesce((e->>'with_subunits')::boolean, true));
    else
      raise exception 'chat_sources_invalid' using errcode = '22023';
    end if;
    if not exists (select 1 from jsonb_array_elements(p_keep) k
                    where k->>'kind' = v_item->>'kind'
                      and k->>'unit_id' is not distinct from v_item->>'unit_id') then
      if v_item->>'kind' = 'all' and not v_announce then
        raise exception 'chat_sources_forbidden' using errcode = '42501';
      end if;
      if v_item->>'kind' = 'unit' and not v_announce then
        v_opts := public.chat_source_options();
        if not (v_opts->'units') ? (v_item->>'unit_id') then
          raise exception 'chat_sources_forbidden' using errcode = '42501';
        end if;
      end if;
    end if;
    if not exists (select 1 from jsonb_array_elements(v_out) o
                    where o->>'kind' = v_item->>'kind'
                      and o->>'unit_id' is not distinct from v_item->>'unit_id') then
      v_out := v_out || jsonb_build_array(v_item);
    end if;
  end loop;
  return v_out;
end;
$$;

create or replace function public.chat_sources_write(p_chat uuid, p_uid uuid, p_sources jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.chat_member_sources where chat_id = p_chat;
  insert into public.chat_member_sources (chat_id, kind, unit_id, scope, with_subunits, created_by)
  select p_chat, e->>'kind', nullif(e->>'unit_id', '')::uuid, e->>'scope',
         (e->>'with_subunits')::boolean, p_uid
    from jsonb_array_elements(p_sources) e;
  perform public.chat_sync_sources(p_chat);
end;
$$;

-- Группа или канал с источниками состава.
-- p: {title, description, channel, members: [uuid], sources: [{kind, unit_id, scope, with_subunits}]}
create or replace function public.chat_create_ex(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_title text := btrim(coalesce(p->>'title', ''));
  v_channel boolean := coalesce((p->>'channel')::boolean, false);
  v_sources jsonb;
  v_id uuid;
begin
  if char_length(v_title) not between 1 and 100 then
    raise exception 'chat_title_invalid' using errcode = '22023';
  end if;
  if v_channel and not public.chat_can_announce(v_uid) then
    raise exception 'chat_sources_forbidden' using errcode = '42501';
  end if;
  v_sources := public.chat_sources_parse(v_uid, p->'sources');
  insert into public.chat_chats (kind, title, description, created_by, settings)
  values ('group', v_title, left(nullif(btrim(coalesce(p->>'description', '')), ''), 1000), v_uid,
          case when v_channel
               then '{"pin": "admins", "post": "admins", "add": "admins", "channel": true}'::jsonb
               else '{"pin": "admins", "post": "all", "add": "admins"}'::jsonb end)
  returning id into v_id;
  insert into public.chat_members (chat_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.chat_members (chat_id, user_id, role)
  select v_id, u, 'member'
    from (select distinct x::uuid as u
            from jsonb_array_elements_text(case when jsonb_typeof(p->'members') = 'array'
                                                then p->'members' else '[]' end) x) z
   where u <> v_uid and public.is_portal_user(u)
   limit 1000;
  perform public.chat_system_message(v_id, v_uid,
    jsonb_build_object('type', case when v_channel then 'channel_created' else 'created' end,
                       'title', v_title));
  perform public.chat_sources_write(v_id, v_uid, v_sources);
  perform public.chat_broadcast(v_id, jsonb_build_object('type', 'chat'));
  return v_id;
end;
$$;

create or replace function public.chat_sources_get(p_chat uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
begin
  if v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'unit_id', s.unit_id, 'scope', s.scope,
                                          'with_subunits', s.with_subunits,
                                          'unit_name', (select u.name from public.org_units u
                                                         where u.id = s.unit_id))
                       order by s.created_at)
        from public.chat_member_sources s where s.chat_id = p_chat), '[]'::jsonb),
    'can_edit', v_role in ('owner', 'admin')
                and (select kind from public.chat_chats where id = p_chat) = 'group');
end;
$$;

create or replace function public.chat_sources_save(p_chat uuid, p_sources jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_role text := public.chat_role(p_chat, v_uid);
  v_keep jsonb;
begin
  if v_role is null or v_role = 'member'
     or (select kind from public.chat_chats where id = p_chat) <> 'group' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'unit_id', s.unit_id)), '[]'::jsonb)
    into v_keep from public.chat_member_sources s where s.chat_id = p_chat;
  perform public.chat_sources_write(p_chat, v_uid, public.chat_sources_parse(v_uid, p_sources, v_keep));
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'chat'));
end;
$$;

-- 5. «Прочитал» ------------------------------------------------------------------------

create or replace function public.chat_ack(p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
begin
  select * into m from public.chat_messages where id = p_message;
  if not found or public.chat_role(m.chat_id, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if not m.ack_required or m.deleted_at is not null then
    raise exception 'chat_ack_not_needed' using errcode = '22023';
  end if;
  if m.author_id is distinct from v_uid then
    insert into public.chat_message_acks (message_id, user_id) values (p_message, v_uid)
    on conflict do nothing;
    update public.chat_members set last_read_seq = greatest(last_read_seq, m.seq)
     where chat_id = m.chat_id and user_id = v_uid;
    -- Счётчик видят автор и админы — им и событие.
    perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'edit', 'seq', m.seq),
      array(select cm.user_id from public.chat_members cm
             where cm.chat_id = m.chat_id
               and (cm.user_id = m.author_id or cm.role in ('owner', 'admin') or cm.user_id = v_uid)));
  end if;
  return public.chat_message_json(m, v_uid);
end;
$$;

-- Кто отметил и кто ещё нет — автору поста, владельцу и админам.
create or replace function public.chat_ack_list(p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  v_role text;
begin
  select * into m from public.chat_messages where id = p_message;
  v_role := case when found then public.chat_role(m.chat_id, v_uid) end;
  if v_role is null or not m.ack_required then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.author_id is distinct from v_uid and v_role = 'member' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'acked', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'at', a.created_at) order by a.created_at)
        from public.chat_message_acks a where a.message_id = m.id), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(cm.user_id order by cm.joined_at)
        from public.chat_members cm
       where cm.chat_id = m.chat_id and cm.joined_seq < m.seq
         and cm.user_id is distinct from m.author_id
         and not exists (select 1 from public.chat_message_acks a
                          where a.message_id = m.id and a.user_id = cm.user_id)), '[]'::jsonb),
    'reminded_at', m.ack_reminded_at);
end;
$$;

-- Напомнить не отметившим — не чаще раза в час.
create or replace function public.chat_ack_remind(p_message uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  c public.chat_chats;
  v_role text;
  v_count integer := 0;
  r record;
begin
  select * into m from public.chat_messages where id = p_message for update;
  v_role := case when found then public.chat_role(m.chat_id, v_uid) end;
  if v_role is null or not m.ack_required or m.deleted_at is not null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.author_id is distinct from v_uid and v_role = 'member' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  if m.ack_reminded_at > now() - interval '1 hour' then
    raise exception 'chat_ack_remind_soon' using errcode = '22023';
  end if;
  select * into c from public.chat_chats where id = m.chat_id;
  for r in
    select cm.user_id from public.chat_members cm
     where cm.chat_id = m.chat_id and cm.joined_seq < m.seq
       and cm.user_id is distinct from m.author_id
       and not exists (select 1 from public.chat_message_acks a
                        where a.message_id = m.id and a.user_id = cm.user_id)
  loop
    perform public.notif_send_ex(r.user_id, 'chat.ack', 'Отметьте «Прочитал»',
      '«' || c.title || '»: ' || public.chat_preview_text(m.body_text, m.attachments),
      '/chats/' || m.chat_id || '?m=' || m.seq, v_uid, 'chatack:' || m.id, false, true);
    v_count := v_count + 1;
  end loop;
  update public.chat_messages set ack_reminded_at = now() where id = m.id;
  return v_count;
end;
$$;

-- 6. Сообщение в JSON, уведомления, участники -------------------------------------------

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
    'deleted', m.deleted_at is not null,
    -- «Прочитал» (пост канала): сколько отметили из тех, кто был в чате.
    'ack', case when m.ack_required and m.deleted_at is null then jsonb_build_object(
      'count', (select count(*) from public.chat_message_acks a where a.message_id = m.id),
      'total', (select count(*) from public.chat_members cm
                 where cm.chat_id = m.chat_id and cm.joined_seq < m.seq
                   and cm.user_id is distinct from m.author_id),
      'mine', exists (select 1 from public.chat_message_acks a
                       where a.message_id = m.id and a.user_id = p_viewer)) end
  )
$$;

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
        case when c.kind in ('group', 'task', 'project') then '«' || c.title || '»: ' else '' end || v_preview,
        v_url, m.author_id, 'chatmention:' || m.chat_id, false, true);
    elsif r.notify = 'all' and (r.muted_until is null or r.muted_until < now()) then
      if c.kind = 'group' and coalesce((c.settings->>'channel')::boolean, false) then
        -- Пост канала — объявление: в ленте и пушем (вид chat.channel).
        perform public.notif_send_ex(r.user_id, 'chat.channel', c.title, v_preview, v_url,
          m.author_id, 'chatchannel:' || m.chat_id, false, true);
      elsif c.kind = 'direct' then
        perform public.notif_send_ex(r.user_id, 'chat.direct', v_author, v_preview, v_url,
          m.author_id, 'chat:' || m.chat_id, false, false);
      elsif c.kind in ('group', 'task', 'project') then
        perform public.notif_send_ex(r.user_id, 'chat.group', c.title, v_author || ': ' || v_preview,
          v_url, m.author_id, 'chat:' || m.chat_id, false, false);
      end if;
    end if;
  end loop;
end;
$$;

drop function if exists public.chat_members_list(uuid);
create function public.chat_members_list(p_chat uuid)
returns table (user_id uuid, role text, joined_at timestamptz, last_read_seq bigint, source text)
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
    select cm.user_id, cm.role, cm.joined_at, cm.last_read_seq, cm.source
      from public.chat_members cm
     where cm.chat_id = p_chat
     order by case cm.role when 'owner' then 0 when 'admin' then 1 else 2 end, cm.joined_at;
end;
$$;

-- 7. Права на функции -------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.chat_can_announce(uuid)',
    'public.chat_chats_channel_biu()',
    'public.chat_messages_ack_bi()',
    'public.chat_source_users(uuid)',
    'public.chat_sync_sources(uuid)',
    'public.chat_members_auto_bd()',
    'public.chat_sources_resync_units()',
    'public.chat_sources_resync_all()',
    'public.chat_sources_parse(uuid, jsonb, jsonb)',
    'public.chat_sources_write(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chat_source_options()',
    'public.chat_create_ex(jsonb)',
    'public.chat_sources_get(uuid)',
    'public.chat_sources_save(uuid, jsonb)',
    'public.chat_ack(uuid)',
    'public.chat_ack_list(uuid)',
    'public.chat_ack_remind(uuid)',
    'public.chat_members_list(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
