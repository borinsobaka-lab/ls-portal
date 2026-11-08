-- ============================================================================
-- Видеозвонки в чатах портала (решение владельца 2026-11-08): кнопка
-- «Видеозвонок» в шапке личного чата и группы, у собеседников с открытой
-- вкладкой портала — звонок (звук и окно «Принять / Отклонить»), принявшие
-- подключаются к одной видеоконференции Kinescope Speak
-- (https://docs.kinescope.ru/api/speak/).
--
-- Звонок — `chat_calls` (один живой на чат: `chat_calls_live_uidx`),
-- участники — `chat_call_members` (ringing → joined / declined / missed →
-- left). Комнату Kinescope создаёт сервер портала (ключ API — только у него,
-- apps/admin/src/lib/chats/kinescope.server.ts): браузер зовёт серверную
-- функцию, та — `chat_call_start` от имени человека (проверки здесь), затем
-- создаёт комнату и сервис-ключом пишет её `chat_call_set_room` — с этого
-- момента у остальных звонит. Не вышло — `chat_call_fail`.
--
-- Сроки (функция `chat_call_settle`, лениво при каждом обращении и раз в
-- 15 секунд сервером — `chat_call_sweep`):
--   - звонит 45 секунд, не ответил — «пропущен» (`missed`);
--   - кто в звонке, отмечается раз в 20 секунд (`chat_call_ping`), молчит
--     75 секунд — закрыл вкладку, «вышел» (`left`);
--   - комната не создана за 60 секунд — звонок не состоялся (`failed`);
--   - никого в звонке и никому не звонит — звонок окончен; в личном чате —
--     и когда остался один (собеседник отклонил, не ответил или положил
--     трубку); в группе один без ответивших — тоже (никто не взял).
-- Окончен — комнату удаляет сервер (`chat_call_sweep` отдаёт её, отметка —
-- `chat_call_room_deleted`).
--
-- В переписке — одно системное сообщение на звонок
-- ({system: {type: 'call', call_id, state, reason, duration}}): «начал(а)
-- видеозвонок» и по окончании — итог (длительность, пропущенный,
-- отклонённый). Живое обновление — события `{type: 'call', call_id}` в
-- личные темы участников (chat_broadcast); без Realtime портал опрашивает
-- `chat_call_incoming`. Пуш тем, кто не смотрит на портал, — вид
-- `chat.call` (только пуш, без строки в ленте).
--
-- Таблицы закрыты браузеру: только RPC. Идемпотентно.
-- ============================================================================

-- 1. Таблицы -----------------------------------------------------------------

create table if not exists public.chat_calls (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  started_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Комната Kinescope Speak: id (удалить по окончании) и ссылка входа.
  room_id text,
  room_link text,
  -- Когда комната готова и у остальных зазвонило.
  rang_at timestamptz,
  -- Первый ответивший (не звонивший) подключился.
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text check (end_reason in ('finished', 'missed', 'declined', 'cancelled', 'failed')),
  room_deleted_at timestamptz,
  -- Системное сообщение звонка в переписке.
  message_seq bigint,
  error text check (error is null or char_length(error) <= 500)
);
create unique index if not exists chat_calls_live_uidx
  on public.chat_calls (chat_id) where ended_at is null;
create index if not exists chat_calls_sweep_idx
  on public.chat_calls (created_at) where ended_at is null or room_deleted_at is null;

create table if not exists public.chat_call_members (
  call_id uuid not null references public.chat_calls (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  state text not null check (state in ('ringing', 'joined', 'left', 'declined', 'missed')),
  joined_at timestamptz,
  left_at timestamptz,
  -- Последняя отметка «я в звонке».
  seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (call_id, user_id)
);
create index if not exists chat_call_members_user_idx
  on public.chat_call_members (user_id) where state in ('ringing', 'joined');

alter table public.chat_calls enable row level security;
alter table public.chat_call_members enable row level security;
revoke all on public.chat_calls, public.chat_call_members from anon, authenticated;

-- 2. Внутренние ----------------------------------------------------------------

-- Сообщение звонка в переписке: первое — вставка, дальше — правка того же.
create or replace function public.chat_call_message(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_calls;
  v_system jsonb;
  v_seq bigint;
  v_duration integer;
begin
  select * into c from public.chat_calls where id = p_call;
  if not found then
    return;
  end if;
  if c.ended_at is not null and c.answered_at is not null then
    v_duration := greatest(0, extract(epoch from (c.ended_at - c.answered_at))::int);
  end if;
  v_system := jsonb_build_object(
    'type', 'call',
    'call_id', c.id,
    'state', case when c.ended_at is null then 'live' else 'ended' end,
    'reason', c.end_reason,
    'duration', v_duration);

  if c.message_seq is null then
    update public.chat_chats set last_seq = last_seq + 1 where id = c.chat_id
    returning last_seq into v_seq;
    insert into public.chat_messages (chat_id, seq, author_id, kind, content, body_text)
    values (c.chat_id, v_seq, c.started_by, 'system', jsonb_build_object('system', v_system), '');
    update public.chat_calls set message_seq = v_seq where id = c.id;
    update public.chat_members set last_read_seq = greatest(last_read_seq, v_seq)
     where chat_id = c.chat_id and user_id = c.started_by;
    update public.chat_chats
       set last_message = jsonb_build_object('seq', v_seq, 'author_id', c.started_by,
                                             'kind', 'system', 'system', v_system, 'text', ''),
           last_message_at = now(), updated_at = now()
     where id = c.chat_id;
    perform public.chat_broadcast(c.chat_id, jsonb_build_object('type', 'message', 'seq', v_seq));
  else
    update public.chat_messages
       set content = jsonb_build_object('system', v_system)
     where chat_id = c.chat_id and seq = c.message_seq;
    update public.chat_chats
       set last_message = last_message || jsonb_build_object('system', v_system)
     where id = c.chat_id and (last_message->>'seq')::bigint = c.message_seq;
    perform public.chat_broadcast(c.chat_id, jsonb_build_object('type', 'edit', 'seq', c.message_seq));
    perform public.chat_broadcast(c.chat_id, jsonb_build_object('type', 'chat'));
  end if;
end;
$$;

-- Событие звонка участникам чата (и тем, кто был в звонке, но уже не в чате).
create or replace function public.chat_call_notify(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_calls;
begin
  select * into c from public.chat_calls where id = p_call;
  if found then
    perform public.chat_broadcast(c.chat_id, jsonb_build_object('type', 'call', 'call_id', c.id),
      null);
  end if;
end;
$$;

-- Сроки и окончание звонка. Возвращает, окончен ли он.
create or replace function public.chat_call_settle(p_call uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_calls;
  v_kind text;
  v_joined integer;
  v_ringing integer;
  v_declined integer;
  v_changed boolean := false;
  v_reason text;
  v_n integer;
begin
  select * into c from public.chat_calls where id = p_call for update;
  if not found then
    return true;
  end if;
  if c.ended_at is not null then
    return true;
  end if;
  select kind into v_kind from public.chat_chats where id = c.chat_id;

  -- Комната так и не создана.
  if c.room_link is null then
    if c.created_at < now() - interval '60 seconds' then
      v_reason := 'failed';
    else
      return false;
    end if;
  else
    update public.chat_call_members
       set state = 'missed', updated_at = now()
     where call_id = c.id and state = 'ringing'
       and c.rang_at < now() - interval '45 seconds';
    get diagnostics v_n = row_count;
    v_changed := v_n > 0;
    update public.chat_call_members
       set state = 'left', left_at = coalesce(seen_at, now()), updated_at = now()
     where call_id = c.id and state = 'joined'
       and coalesce(seen_at, joined_at) < now() - interval '75 seconds';
    get diagnostics v_n = row_count;
    v_changed := v_changed or v_n > 0;

    select count(*) filter (where state = 'joined'),
           count(*) filter (where state = 'ringing'),
           count(*) filter (where state = 'declined')
      into v_joined, v_ringing, v_declined
      from public.chat_call_members where call_id = c.id;

    if v_joined = 0 and v_ringing > 0 then
      -- Все положили трубку (позвонивший — до ответа): звонить больше некуда.
      v_reason := case when c.answered_at is not null then 'finished' else 'cancelled' end;
    elsif v_joined = 0 and v_ringing = 0 then
      v_reason := case when c.answered_at is not null then 'finished'
                       when v_declined > 0 then 'declined' else 'missed' end;
    elsif v_joined <= 1 and v_ringing = 0 and (c.answered_at is null or v_kind = 'direct') then
      v_reason := case when c.answered_at is not null then 'finished'
                       when v_declined > 0 and v_kind = 'direct' then 'declined' else 'missed' end;
    end if;
  end if;

  if v_reason is null then
    if v_changed then
      perform public.chat_call_notify(c.id);
    end if;
    return false;
  end if;

  update public.chat_call_members
     set state = case when state = 'ringing' then 'missed' else 'left' end,
         left_at = case when state = 'joined' then now() else left_at end,
         updated_at = now()
   where call_id = c.id and state in ('ringing', 'joined');
  update public.chat_calls set ended_at = now(), end_reason = v_reason where id = c.id;
  perform public.chat_call_message(c.id);
  perform public.chat_call_notify(c.id);
  return true;
end;
$$;

-- Звонок в JSON для браузера (участнику чата).
create or replace function public.chat_call_json(p_call uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'chat_id', c.chat_id,
    'chat_kind', ch.kind,
    'chat_title', ch.title,
    'started_by', c.started_by,
    'created_at', c.created_at,
    'ready', c.room_link is not null,
    -- Ссылка комнаты — участникам чата (вызывающего проверяют RPC).
    'link', c.room_link,
    'answered_at', c.answered_at,
    'ended_at', c.ended_at,
    'end_reason', c.end_reason,
    'my_state', (select m.state from public.chat_call_members m
                  where m.call_id = c.id and m.user_id = p_viewer),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'state', m.state)
                       order by m.joined_at nulls last, m.user_id)
        from public.chat_call_members m where m.call_id = c.id), '[]'::jsonb))
    from public.chat_calls c
    join public.chat_chats ch on ch.id = c.chat_id
   where c.id = p_call
$$;

-- Звонок, к которому у вызывающего есть доступ (участник чата).
create or replace function public.chat_call_require(p_call uuid)
returns public.chat_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls;
begin
  select * into c from public.chat_calls where id = p_call;
  if not found or public.chat_role(c.chat_id, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  return c;
end;
$$;

-- 3. Браузеру ------------------------------------------------------------------

-- Начать звонок в чате или присоединиться к уже идущему. Ответ:
-- {call: …, needs_room: boolean} — needs_room: комнату создаёт сервер.
create or replace function public.chat_call_start(p_chat uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  ch public.chat_chats;
  c public.chat_calls;
  v_needs boolean := false;
begin
  if public.chat_role(p_chat, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  -- Одновременное нажатие у двоих — по очереди.
  select * into ch from public.chat_chats where id = p_chat for update;
  if ch.kind = 'self' then
    raise exception 'chat_call_self' using errcode = '22023';
  end if;
  if ch.kind = 'direct' and (select count(*) from public.chat_members where chat_id = p_chat) < 2 then
    raise exception 'chat_call_no_peer' using errcode = '22023';
  end if;

  select * into c from public.chat_calls where chat_id = p_chat and ended_at is null;
  if found and public.chat_call_settle(c.id) then
    c := null;
  end if;

  if c.id is null then
    insert into public.chat_calls (chat_id, started_by) values (p_chat, v_uid) returning * into c;
    insert into public.chat_call_members (call_id, user_id, state, joined_at, seen_at)
    values (c.id, v_uid, 'joined', now(), now());
    insert into public.chat_call_members (call_id, user_id, state)
    select c.id, m.user_id, 'ringing'
      from public.chat_members m
     where m.chat_id = p_chat and m.user_id <> v_uid and public.is_portal_user(m.user_id);
    perform public.chat_call_message(c.id);
    v_needs := true;
  else
    -- Уже идёт: присоединяемся (как «Принять»).
    insert into public.chat_call_members (call_id, user_id, state, joined_at, seen_at)
    values (c.id, v_uid, 'joined', now(), now())
    on conflict (call_id, user_id) do update
       set state = 'joined', joined_at = coalesce(chat_call_members.joined_at, now()),
           seen_at = now(), left_at = null, updated_at = now();
    if c.room_link is not null and v_uid is distinct from c.started_by then
      update public.chat_calls set answered_at = coalesce(answered_at, now()) where id = c.id;
    end if;
    perform public.chat_call_notify(c.id);
  end if;

  return jsonb_build_object(
    'call', public.chat_call_json(c.id, v_uid),
    'needs_room', v_needs,
    'link', (select room_link from public.chat_calls where id = c.id));
end;
$$;

-- Принять (или подключиться к идущему звонку чата). Ответ — ссылка комнаты.
create or replace function public.chat_call_join(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls := public.chat_call_require(p_call);
begin
  if public.chat_call_settle(c.id) then
    raise exception 'chat_call_ended' using errcode = '22023';
  end if;
  select * into c from public.chat_calls where id = p_call;
  if c.room_link is null then
    raise exception 'chat_call_not_ready' using errcode = '22023';
  end if;
  insert into public.chat_call_members (call_id, user_id, state, joined_at, seen_at)
  values (c.id, v_uid, 'joined', now(), now())
  on conflict (call_id, user_id) do update
     set state = 'joined', joined_at = coalesce(chat_call_members.joined_at, now()),
         seen_at = now(), left_at = null, updated_at = now();
  if v_uid is distinct from c.started_by and c.answered_at is null then
    update public.chat_calls set answered_at = now() where id = c.id;
    perform public.chat_call_message(c.id);
  end if;
  perform public.chat_call_notify(c.id);
  return jsonb_build_object('call', public.chat_call_json(c.id, v_uid), 'link', c.room_link);
end;
$$;

-- Отклонить входящий.
create or replace function public.chat_call_decline(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls := public.chat_call_require(p_call);
begin
  update public.chat_call_members set state = 'declined', updated_at = now()
   where call_id = c.id and user_id = v_uid and state = 'ringing';
  if found and not public.chat_call_settle(c.id) then
    perform public.chat_call_notify(c.id);
  end if;
  return public.chat_call_json(c.id, v_uid);
end;
$$;

-- Выйти из звонка (положить трубку, закрыть окно звонка).
create or replace function public.chat_call_leave(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls := public.chat_call_require(p_call);
begin
  update public.chat_call_members
     set state = 'left', left_at = now(), updated_at = now()
   where call_id = c.id and user_id = v_uid and state = 'joined';
  if found and not public.chat_call_settle(c.id) then
    perform public.chat_call_notify(c.id);
  end if;
  return public.chat_call_json(c.id, v_uid);
end;
$$;

-- «Я в звонке» (раз в 20 секунд из окна звонка) и его состояние.
create or replace function public.chat_call_ping(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls := public.chat_call_require(p_call);
begin
  update public.chat_call_members set seen_at = now()
   where call_id = c.id and user_id = v_uid and state = 'joined';
  perform public.chat_call_settle(c.id);
  return public.chat_call_json(c.id, v_uid);
end;
$$;

-- Состояние звонка (без отметки «я в звонке»).
create or replace function public.chat_call_get(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.chat_calls := public.chat_call_require(p_call);
begin
  perform public.chat_call_settle(c.id);
  return public.chat_call_json(c.id, v_uid);
end;
$$;

-- Идущий звонок чата (плашка «Идёт видеозвонок — присоединиться»), null — нет.
create or replace function public.chat_call_active(p_chat uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid;
begin
  if public.chat_role(p_chat, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  select id into v_id from public.chat_calls where chat_id = p_chat and ended_at is null;
  if v_id is null or public.chat_call_settle(v_id) then
    return null;
  end if;
  return public.chat_call_json(v_id, v_uid);
end;
$$;

-- Входящие: мне звонят сейчас (комната готова, я ещё не ответил).
create or replace function public.chat_call_incoming()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  r record;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select c.id
      from public.chat_call_members m
      join public.chat_calls c on c.id = m.call_id
     where m.user_id = v_uid and m.state = 'ringing' and c.ended_at is null
       and c.room_link is not null
       and public.chat_role(c.chat_id, v_uid) is not null
     order by c.rang_at
  loop
    if not public.chat_call_settle(r.id)
       and exists (select 1 from public.chat_call_members
                    where call_id = r.id and user_id = v_uid and state = 'ringing') then
      v_out := v_out || jsonb_build_array(public.chat_call_json(r.id, v_uid));
    end if;
  end loop;
  return v_out;
end;
$$;

-- 4. Серверу портала (service_role) --------------------------------------------

-- Комната создана: звоним остальным.
create or replace function public.chat_call_set_room(p_call uuid, p_room_id text, p_link text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_calls;
  ch public.chat_chats;
  r record;
  v_caller text;
begin
  if p_link is null or p_link !~ '^https://' or char_length(p_link) > 500
     or char_length(coalesce(p_room_id, '')) not between 1 and 100 then
    raise exception 'chat_call_bad_room' using errcode = '22023';
  end if;
  update public.chat_calls
     set room_id = p_room_id, room_link = p_link, rang_at = now()
   where id = p_call and room_link is null and ended_at is null
  returning * into c;
  if not found then
    -- Звонок окончен раньше, чем создалась комната: комнату — в уборку.
    update public.chat_calls set room_id = p_room_id, room_deleted_at = null
     where id = p_call and room_id is null and ended_at is not null;
    return null;
  end if;
  select * into ch from public.chat_chats where id = c.chat_id;
  v_caller := public.chat_display_name(c.started_by);
  for r in
    select m.user_id from public.chat_call_members m
      join public.chat_members cm on cm.chat_id = c.chat_id and cm.user_id = m.user_id
     where m.call_id = c.id and m.state = 'ringing'
       and cm.notify <> 'none' and (cm.muted_until is null or cm.muted_until < now())
  loop
    perform public.notif_send_ex(r.user_id, 'chat.call',
      case when ch.kind = 'group' then 'Видеозвонок в «' || ch.title || '»'
           else 'Видеозвонок' end,
      case when ch.kind = 'group' then v_caller || ' начал(а) видеозвонок'
           else v_caller || ' звонит вам' end,
      '/chats/' || c.chat_id || '?call=' || c.id, c.started_by, 'call:' || c.id, false, false);
  end loop;
  perform public.chat_call_notify(c.id);
  return public.chat_call_json(c.id, c.started_by);
end;
$$;

-- Комнату создать не удалось.
create or replace function public.chat_call_fail(p_call uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_calls
     set ended_at = now(), end_reason = 'failed', error = left(p_error, 500),
         room_deleted_at = case when room_id is null then now() end
   where id = p_call and ended_at is null;
  if found then
    update public.chat_call_members
       set state = case when state = 'ringing' then 'missed' else 'left' end,
           left_at = case when state = 'joined' then now() else left_at end, updated_at = now()
     where call_id = p_call and state in ('ringing', 'joined');
    perform public.chat_call_message(p_call);
    perform public.chat_call_notify(p_call);
  end if;
end;
$$;

-- Раз в 15 секунд: сроки живых звонков; комнаты оконченных — удалить.
create or replace function public.chat_call_sweep()
returns table (call_id uuid, room_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select x.id from public.chat_calls x where x.ended_at is null loop
    perform public.chat_call_settle(r.id);
  end loop;
  -- Без комнаты удалять нечего.
  update public.chat_calls x set room_deleted_at = now()
   where x.ended_at is not null and x.room_deleted_at is null and x.room_id is null;
  return query
    select c.id, c.room_id from public.chat_calls c
     where c.ended_at is not null and c.room_deleted_at is null and c.room_id is not null
     order by c.ended_at
     limit 50;
end;
$$;

create or replace function public.chat_call_room_deleted(p_call uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.chat_calls set room_deleted_at = now() where id = p_call
$$;

-- 5. Права на функции ----------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.chat_call_message(uuid)',
    'public.chat_call_notify(uuid)',
    'public.chat_call_settle(uuid)',
    'public.chat_call_json(uuid, uuid)',
    'public.chat_call_require(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.chat_call_set_room(uuid, text, text)',
    'public.chat_call_fail(uuid, text)',
    'public.chat_call_sweep()',
    'public.chat_call_room_deleted(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chat_call_start(uuid)',
    'public.chat_call_join(uuid)',
    'public.chat_call_decline(uuid)',
    'public.chat_call_leave(uuid)',
    'public.chat_call_ping(uuid)',
    'public.chat_call_get(uuid)',
    'public.chat_call_active(uuid)',
    'public.chat_call_incoming()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
