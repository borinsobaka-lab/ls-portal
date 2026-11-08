-- ============================================================================
-- Чаты, этап 2 (TASKS_CHATS_PLAN.md, Д.6, 2.16, 2026-11-08): отложенные
-- сообщения и опросы.
--
-- Отложенное — `chat_scheduled` (текст, файлы, ответ, время отправки; свои
-- видит только автор). Запланировать — `chat_schedule` (те же проверки, что
-- у отправки: участник, «пишут только админы»; время — от минуты до года;
-- до 100 ждущих у человека). Отправляет сервер портала — `chat_scheduled_tick`
-- (только service_role, раз в 20 с): сообщение уходит обычной `chat_send`
-- от имени автора (`request.jwt.claim.sub` на время отправки, `client_id` —
-- id отложенного: повтор не задвоит); отправленное удаляется из очереди,
-- не получилось (вышел из чата, канал и т. п.) — `status = 'failed'` с
-- причиной и уведомление автору `chat.scheduled`. Автору — `chat_scheduled_list`,
-- `_reschedule`, `_delete`, `_send_now`. Файлы отложенного держит
-- `storage_file_referenced` (актуальное определение — здесь), удалённое —
-- в очередь стирания (`chat_scheduled_files_ad`).
--
-- Опрос — сообщение чата (`body_text` «Опрос: …» — превью и поиск) +
-- `chat_polls` (вопрос, 2–10 вариантов, несколько ответов, анонимный,
-- закрыт) и голоса `chat_poll_votes`. Создать — `chat_poll_create`
-- (как сообщение: участник, «пишут только админы»), голосовать —
-- `chat_poll_vote` (заменяет свои голоса; пусто — отозвать), закрыть —
-- `chat_poll_close` (автор, владелец, админ). В сообщении — `poll`
-- (`chat_message_json`, актуальное определение — здесь): варианты с числом
-- голосов и своим выбором, у неанонимного — кто голосовал.
--
-- Все таблицы закрыты браузеру. Идемпотентно.
-- ============================================================================

-- 1. Таблицы -----------------------------------------------------------------

create table if not exists public.chat_scheduled (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_chats (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  content jsonb,
  body_text text not null default '',
  reply_to_seq bigint,
  attachments jsonb not null default '[]'::jsonb,
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_scheduled_lengths_check check (
    char_length(body_text) <= 10000 and jsonb_typeof(attachments) = 'array'
    and jsonb_array_length(attachments) <= 20)
);
create index if not exists chat_scheduled_due_idx on public.chat_scheduled (send_at)
  where status = 'pending';
create index if not exists chat_scheduled_author_idx on public.chat_scheduled (author_id, chat_id);
create index if not exists chat_scheduled_attachments_idx
  on public.chat_scheduled using gin (attachments jsonb_path_ops);
alter table public.chat_scheduled enable row level security;

create table if not exists public.chat_polls (
  message_id uuid primary key references public.chat_messages (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 300),
  -- [{id: '1', text: '…'}]
  options jsonb not null,
  multiple boolean not null default false,
  anonymous boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null
);
alter table public.chat_polls enable row level security;

create table if not exists public.chat_poll_votes (
  message_id uuid not null references public.chat_polls (message_id) on delete cascade,
  option_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, option_id, user_id)
);
create index if not exists chat_poll_votes_user_idx on public.chat_poll_votes (message_id, user_id);
alter table public.chat_poll_votes enable row level security;

-- 2. Отложенные ------------------------------------------------------------------

create or replace function public.chat_scheduled_json(s public.chat_scheduled)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id, 'chat_id', s.chat_id, 'content', s.content, 'text', s.body_text,
    'reply_to_seq', s.reply_to_seq, 'attachments', s.attachments, 'send_at', s.send_at,
    'status', s.status, 'error', s.error, 'created_at', s.created_at)
$$;

-- Те же проверки, что у отправки: участник, «пишут только админы».
create or replace function public.chat_can_post(p_chat uuid, p_uid uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.chat_role(p_chat, p_uid);
  c public.chat_chats;
begin
  if v_role is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  select * into c from public.chat_chats where id = p_chat;
  if c.kind = 'group' and coalesce(c.settings->>'post', 'all') = 'admins' and v_role = 'member' then
    raise exception 'chat_post_admins_only' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.chat_schedule_check_time(p_at timestamptz)
returns void
language plpgsql
stable
as $$
begin
  if p_at is null or p_at < now() + interval '30 seconds' or p_at > now() + interval '366 days' then
    raise exception 'chat_schedule_time_invalid' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.chat_schedule(
  p_chat uuid,
  p_content jsonb,
  p_text text,
  p_send_at timestamptz,
  p_reply_to bigint default null,
  p_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_text text := btrim(coalesce(p_text, ''));
  v_files jsonb;
  s public.chat_scheduled;
begin
  perform public.chat_can_post(p_chat, v_uid);
  perform public.chat_schedule_check_time(p_send_at);
  v_files := public.chat_check_attachments(p_chat, p_attachments);
  if v_text = '' and jsonb_array_length(v_files) = 0 then
    raise exception 'chat_message_empty' using errcode = '22023';
  end if;
  if char_length(v_text) > 10000 or pg_column_size(p_content) > 200000 then
    raise exception 'chat_message_too_long' using errcode = '22023';
  end if;
  if (select count(*) from public.chat_scheduled where author_id = v_uid) >= 100 then
    raise exception 'chat_schedule_too_many' using errcode = '22023';
  end if;
  insert into public.chat_scheduled (chat_id, author_id, content, body_text, reply_to_seq,
                                     attachments, send_at)
  values (p_chat, v_uid, p_content, v_text, p_reply_to, v_files, p_send_at)
  returning * into s;
  return public.chat_scheduled_json(s);
end;
$$;

create or replace function public.chat_scheduled_list(p_chat uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  return coalesce((
    select jsonb_agg(public.chat_scheduled_json(s) order by s.send_at)
      from public.chat_scheduled s
     where s.author_id = v_uid and (p_chat is null or s.chat_id = p_chat)), '[]'::jsonb);
end;
$$;

create or replace function public.chat_scheduled_reschedule(p_id uuid, p_send_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  s public.chat_scheduled;
begin
  perform public.chat_schedule_check_time(p_send_at);
  update public.chat_scheduled
     set send_at = p_send_at, status = 'pending', error = null, updated_at = now()
   where id = p_id and author_id = v_uid
  returning * into s;
  if not found then
    raise exception 'chat_scheduled_not_found' using errcode = '42501';
  end if;
  return public.chat_scheduled_json(s);
end;
$$;

create or replace function public.chat_scheduled_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.chat_scheduled where id = p_id and author_id = public.chat_require_portal();
end;
$$;

-- Отправить одно отложенное от имени автора. true — ушло, false — не вышло
-- (причина — в строке).
create or replace function public.chat_scheduled_deliver(p_id uuid, p_notify boolean default true)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.chat_scheduled;
  v_prev text := current_setting('request.jwt.claim.sub', true);
  v_err text;
begin
  select * into s from public.chat_scheduled where id = p_id for update skip locked;
  if not found then
    return false;
  end if;
  perform set_config('request.jwt.claim.sub', s.author_id::text, true);
  begin
    perform public.chat_send(s.chat_id, s.content, s.body_text, s.reply_to_seq, s.attachments, s.id);
    perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
    delete from public.chat_scheduled where id = s.id;
    return true;
  exception when others then
    v_err := sqlerrm;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
  update public.chat_scheduled
     set status = 'failed', error = left(v_err, 200), updated_at = now()
   where id = s.id;
  if p_notify then
    perform public.notif_send_ex(s.author_id, 'chat.scheduled', 'Отложенное сообщение не отправлено',
      public.chat_preview_text(s.body_text, s.attachments),
      '/chats/' || s.chat_id || '?scheduled=1', null, 'chatscheduled:' || s.chat_id, false, true);
  end if;
  return false;
end;
$$;

create or replace function public.chat_scheduled_send_now(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_err text;
begin
  if not exists (select 1 from public.chat_scheduled where id = p_id and author_id = v_uid) then
    raise exception 'chat_scheduled_not_found' using errcode = '42501';
  end if;
  if public.chat_scheduled_deliver(p_id, false) then
    return true;
  end if;
  select error into v_err from public.chat_scheduled where id = p_id;
  raise exception '%', coalesce(v_err, 'chat_scheduled_failed');
end;
$$;

-- Сервер портала: отправить наступившие.
create or replace function public.chat_scheduled_tick(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id from public.chat_scheduled
     where status = 'pending' and send_at <= now()
     order by send_at limit p_limit
  loop
    if public.chat_scheduled_deliver(r.id) then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- Удалённое отложенное (отправлено, отменено, чат удалён) — файлы в очередь
-- стирания; файлы отправленного держит сообщение.
create or replace function public.chat_scheduled_files_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_array_length(old.attachments) > 0 and to_regclass('public.storage_purge_queue') is not null then
    perform public.storage_purge_enqueue('chat-files',
      array(select a->>'path' from jsonb_array_elements(old.attachments) a));
  end if;
  return old;
end;
$$;
drop trigger if exists chat_scheduled_files_ad on public.chat_scheduled;
create trigger chat_scheduled_files_ad
  after delete on public.chat_scheduled
  for each row execute function public.chat_scheduled_files_ad();

-- Файлы отложенных — тоже ссылки. Прежнее определение — 2026-11-08_zzzz_deletion_cleanup.sql.
create or replace function public.storage_file_referenced(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  case p_bucket
    when 'chat-files' then
      return exists (select 1 from public.chat_messages m
                      where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_name)))
          or exists (select 1 from public.chat_scheduled s
                      where s.attachments @> jsonb_build_array(jsonb_build_object('path', p_name)));
    when 'task-files' then
      return exists (select 1 from public.task_files f where f.path = p_name);
    when 'kb-media' then
      if p_name not like 'tasks/%' then
        return true;
      end if;
      return exists (select 1 from public.tasks t
                      where t.description is not null
                        and strpos(t.description::text, 'kbfile:' || p_name) > 0)
          or exists (select 1 from public.task_templates tt
                      where strpos(tt.task::text, 'kbfile:' || p_name) > 0);
    when 'avatars' then
      if p_name not like 'staff/%' then
        return true;
      end if;
      return exists (select 1 from public.profiles p where p.avatar_url = p_name);
    when 'studio-logos' then
      return exists (select 1 from public.studios s
                      where s.logo_url = p_name or s.photo_url = p_name
                         or s.logo_url like '%/studio-logos/' || p_name
                         or s.photo_url like '%/studio-logos/' || p_name);
    when 'an-onec' then
      return exists (select 1 from public.an_onec_files f where f.path = p_name);
    when 'an-content' then
      return exists (select 1 from public.an_content_post_media m where m.storage_path = p_name);
    when 'an-fitbase' then
      return exists (select 1 from public.an_fb_incremental i where i.object_path = p_name)
          or exists (select 1 from public.an_fb_connections c where c.checks_path = p_name);
    else
      return true;
  end case;
end;
$$;

-- 3. Опросы ----------------------------------------------------------------------------

create or replace function public.chat_poll_create(
  p_chat uuid,
  p_question text,
  p_options jsonb,
  p_multiple boolean default false,
  p_anonymous boolean default false,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_q text := btrim(coalesce(p_question, ''));
  v_opts jsonb := '[]'::jsonb;
  v_text text;
  v_seen text[] := '{}';
  o text;
  i integer := 0;
  v_msg jsonb;
  m public.chat_messages;
begin
  if char_length(v_q) not between 1 and 300 then
    raise exception 'chat_poll_invalid' using errcode = '22023';
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception 'chat_poll_invalid' using errcode = '22023';
  end if;
  for o in select btrim(x) from jsonb_array_elements_text(p_options) x loop
    continue when o = '';
    if char_length(o) > 100 or lower(o) = any (v_seen) then
      raise exception 'chat_poll_invalid' using errcode = '22023';
    end if;
    i := i + 1;
    v_seen := v_seen || lower(o);
    v_opts := v_opts || jsonb_build_array(jsonb_build_object('id', i::text, 'text', o));
  end loop;
  if i not between 2 and 10 then
    raise exception 'chat_poll_invalid' using errcode = '22023';
  end if;
  v_text := 'Опрос: ' || v_q;
  v_msg := public.chat_send(p_chat,
    jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object(
      'type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text))))),
    v_text, null, '[]'::jsonb, p_client_id);
  insert into public.chat_polls (message_id, question, options, multiple, anonymous, created_by)
  values ((v_msg->>'id')::uuid, v_q, v_opts, coalesce(p_multiple, false), coalesce(p_anonymous, false), v_uid)
  on conflict (message_id) do nothing;
  select * into m from public.chat_messages where id = (v_msg->>'id')::uuid;
  return public.chat_message_json(m, v_uid);
end;
$$;

create or replace function public.chat_poll_vote(p_message uuid, p_options text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.chat_messages;
  p public.chat_polls;
  v_opts text[] := array(select distinct x from unnest(coalesce(p_options, '{}'::text[])) x);
begin
  select * into m from public.chat_messages where id = p_message;
  if not found or m.deleted_at is not null or public.chat_role(m.chat_id, v_uid) is null then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  select * into p from public.chat_polls where message_id = p_message for update;
  if not found then
    raise exception 'chat_poll_invalid' using errcode = '22023';
  end if;
  if p.closed_at is not null then
    raise exception 'chat_poll_closed' using errcode = '22023';
  end if;
  if (not p.multiple and cardinality(v_opts) > 1)
     or exists (select 1 from unnest(v_opts) x
                 where not exists (select 1 from jsonb_array_elements(p.options) o where o->>'id' = x)) then
    raise exception 'chat_poll_invalid' using errcode = '22023';
  end if;
  delete from public.chat_poll_votes where message_id = p_message and user_id = v_uid;
  insert into public.chat_poll_votes (message_id, option_id, user_id)
  select p_message, x, v_uid from unnest(v_opts) x;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'edit', 'seq', m.seq));
  return public.chat_message_json(m, v_uid);
end;
$$;

create or replace function public.chat_poll_close(p_message uuid)
returns jsonb
language plpgsql
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
  if v_role is null or not exists (select 1 from public.chat_polls where message_id = p_message) then
    raise exception 'chat_forbidden' using errcode = '42501';
  end if;
  if m.author_id is distinct from v_uid and v_role = 'member' then
    raise exception 'chat_admin_only' using errcode = '42501';
  end if;
  update public.chat_polls set closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, v_uid)
   where message_id = p_message;
  perform public.chat_broadcast(m.chat_id, jsonb_build_object('type', 'edit', 'seq', m.seq));
  return public.chat_message_json(m, v_uid);
end;
$$;

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
                       where a.message_id = m.id and a.user_id = p_viewer)) end,
    -- Опрос: варианты с голосами; у неанонимного — кто голосовал (до 50 на вариант).
    'poll', (select jsonb_build_object(
               'question', p.question, 'multiple', p.multiple, 'anonymous', p.anonymous,
               'closed', p.closed_at is not null,
               'voters', (select count(distinct v.user_id) from public.chat_poll_votes v
                           where v.message_id = m.id),
               'options', (select jsonb_agg(jsonb_build_object(
                                     'id', o->>'id', 'text', o->>'text',
                                     'count', (select count(*) from public.chat_poll_votes v
                                                where v.message_id = m.id and v.option_id = o->>'id'),
                                     'mine', exists (select 1 from public.chat_poll_votes v
                                                      where v.message_id = m.id and v.option_id = o->>'id'
                                                        and v.user_id = p_viewer),
                                     'users', case when not p.anonymous then coalesce((
                                       select jsonb_agg(x.user_id) from (
                                         select v.user_id from public.chat_poll_votes v
                                          where v.message_id = m.id and v.option_id = o->>'id'
                                          order by v.created_at limit 50) x), '[]'::jsonb) end)
                                   order by e.ord)
                             from jsonb_array_elements(p.options) with ordinality as e(o, ord)))
               from public.chat_polls p where p.message_id = m.id and m.deleted_at is null)
  )
$$;

-- 4. Права на функции ---------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.chat_scheduled_json(public.chat_scheduled)',
    'public.chat_can_post(uuid, uuid)',
    'public.chat_schedule_check_time(timestamptz)',
    'public.chat_scheduled_deliver(uuid, boolean)',
    'public.chat_scheduled_tick(integer)',
    'public.chat_scheduled_files_ad()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chat_schedule(uuid, jsonb, text, timestamptz, bigint, jsonb)',
    'public.chat_scheduled_list(uuid)',
    'public.chat_scheduled_reschedule(uuid, timestamptz)',
    'public.chat_scheduled_delete(uuid)',
    'public.chat_scheduled_send_now(uuid)',
    'public.chat_poll_create(uuid, text, jsonb, boolean, boolean, uuid)',
    'public.chat_poll_vote(uuid, text[])',
    'public.chat_poll_close(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
