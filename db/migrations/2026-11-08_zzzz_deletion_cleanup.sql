-- ============================================================================
-- Окончательное удаление уносит файлы и всё связанное (решение владельца
-- 2026-11-08: «при окончательном удалении, а не архиве, файлы, картинки и
-- прочие сущности удаляются и на сервере, и в хранилище»).
--
-- Что было не так (аудит 2026-11-08):
-- • Чаты: удалённая группа, чат удалённого проекта, удалённое или
--   изменённое сообщение — строки уходили, файлы бакета `chat-files`
--   оставались навсегда. Оставались и папки пользователей со ссылкой на
--   удалённый чат и уведомления, ведущие в никуда.
-- • Звонки: удалили чат во время звонка — `chat_calls` уходил каскадом,
--   комнату Kinescope никто не удалял.
-- • Задачи: убранный файл задачи (`task_file_delete`) — строка уходила,
--   файл бакета `task-files` оставался. Картинки описания (`kb-media`,
--   `tasks/<задача>/`) из шаблона задачи уборка базы знаний не видела —
--   через неделю стёрла бы их у живого шаблона.
-- • Проект удалялся без задач («задачи остаются без проекта» — решение по
--   умолчанию вехи 4): теперь удаление проекта уносит его задачи с файлами,
--   чек-листами, историей, обсуждением и уведомлениями. Сохранить задачи —
--   «В архив».
-- • Аватарка человека портала (`avatars/staff/…`) после замены или
--   удаления учётной записи, логотип и картинка удалённого или
--   изменённого клуба (`studio-logos`), картинки удалённого поста
--   контент-плана (`an-content`) и выгрузки 1С (`an-onec`) — последние два
--   стирал браузер после ответа базы (закрыли вкладку — файл остался).
--
-- Как устроено:
-- • `storage_purge_queue` — что проверить и стереть (бакет + путь). Ставят
--   триггеры на удалении и замене (`storage_purge_enqueue` — файл,
--   `storage_purge_enqueue_prefix` — все файлы папки).
-- • Файл стирается, только если на него больше ничто не ссылается
--   (`storage_file_referenced`): пересланное сообщение держит файл
--   исходного чата (пересылка без копий), файл постановки «отдельно
--   каждому» — у всех задач постановки, картинка описания — и у шаблона.
-- • Сервер портала (`lib/storage-cleanup.server.ts`, раз в 5 минут)
--   забирает очередь (`storage_purge_due`) и стирает файлы API Storage
--   (строка `storage.objects` без файла на диске была бы мусором). Раз в
--   сутки — страховка: файлы управляемых бакетов без ссылок старше запаса
--   (`storage_gc_candidates`: загрузили и не сохранили, сбой посреди
--   удаления).
-- • База знаний и «Академия» — как раньше (`kb_file_purge`,
--   `kb_file_gc_candidates`); здесь в ссылки последней добавлены шаблоны
--   задач (актуальное определение — здесь).
--
-- Таблица закрыта браузеру, функции очереди — только service_role.
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1. Очередь ------------------------------------------------------------------

create table if not exists public.storage_purge_queue (
  bucket_id text not null,
  name text not null,
  queued_at timestamptz not null default now(),
  primary key (bucket_id, name)
);
create index if not exists storage_purge_queue_at_idx on public.storage_purge_queue (queued_at);

alter table public.storage_purge_queue enable row level security;
revoke all on public.storage_purge_queue from public, anon, authenticated;
grant all on public.storage_purge_queue to service_role;

create or replace function public.storage_purge_enqueue(p_bucket text, p_names text[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.storage_purge_queue (bucket_id, name)
  select p_bucket, n
    from unnest(coalesce(p_names, '{}'::text[])) n
   where coalesce(n, '') <> ''
  on conflict do nothing
$$;

-- Все файлы папки (префикс с «/» на конце).
create or replace function public.storage_purge_enqueue_prefix(p_bucket text, p_prefix text)
returns void
language sql
security definer
set search_path = public, storage
as $$
  insert into public.storage_purge_queue (bucket_id, name)
  select o.bucket_id, o.name
    from storage.objects o
   where o.bucket_id = p_bucket
     and coalesce(p_prefix, '') like '%/'
     and o.name like p_prefix || '%'
     and left(o.name, char_length(p_prefix)) = p_prefix
  on conflict do nothing
$$;

-- Держит ли что-то файл. Бакеты и папки, которые здесь не описаны, — «да»
-- (их не трогаем: у базы знаний и «Академии» своя уборка).
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
                      where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_name)));
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

-- Забрать очередь (сервер, раз в 5 минут): строки уходят из очереди, наружу
-- — существующие файлы без ссылок. Сбой стирания подберёт суточная уборка.
create or replace function public.storage_purge_due(p_limit integer default 500)
returns table (bucket_id text, name text)
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  return query
    with picked as (
      delete from public.storage_purge_queue q
       where (q.bucket_id, q.name) in (
               select x.bucket_id, x.name from public.storage_purge_queue x
                order by x.queued_at
                limit least(greatest(coalesce(p_limit, 500), 1), 1000)
                  for update skip locked)
      returning q.bucket_id, q.name
    )
    select p.bucket_id, p.name
      from picked p
     where exists (select 1 from storage.objects o where o.bucket_id = p.bucket_id and o.name = p.name)
       and not public.storage_file_referenced(p.bucket_id, p.name);
end;
$$;

-- Суточная страховка: файлы управляемых бакетов без ссылок старше запаса
-- (чаты и задачи — неделя: файл мог ждать в черновике сообщения или в
-- форме постановки; FitBase — 3 дня; прочие — 2 дня).
create or replace function public.storage_gc_candidates(p_limit integer default 1000)
returns table (bucket_id text, name text)
language sql
stable
security definer
set search_path = public, storage
as $$
  select o.bucket_id, o.name
    from storage.objects o
   where o.bucket_id in ('chat-files', 'task-files', 'avatars', 'studio-logos',
                         'an-onec', 'an-content', 'an-fitbase')
     and (o.bucket_id <> 'avatars' or o.name like 'staff/%')
     and o.created_at < now() - make_interval(days => case o.bucket_id
           when 'chat-files' then 7 when 'task-files' then 7 when 'studio-logos' then 7
           when 'an-fitbase' then 3 else 2 end)
     and not public.storage_file_referenced(o.bucket_id, o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_limit, 1000), 1), 5000)
$$;

-- 2. Чаты ---------------------------------------------------------------------

-- Сообщение удалено или из него убрали файл — проверить файлы.
create or replace function public.chat_messages_files_aud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text[];
  v_new text[] := '{}';
begin
  if jsonb_typeof(old.attachments) <> 'array' or jsonb_array_length(old.attachments) = 0 then
    return null;
  end if;
  v_old := array(select a->>'path' from jsonb_array_elements(old.attachments) a);
  if tg_op = 'UPDATE' and jsonb_typeof(new.attachments) = 'array' then
    v_new := array(select a->>'path' from jsonb_array_elements(new.attachments) a);
  end if;
  perform public.storage_purge_enqueue('chat-files',
    array(select x from unnest(v_old) x where not x = any (v_new)));
  return null;
end;
$$;
drop trigger if exists chat_messages_files_aud on public.chat_messages;
create trigger chat_messages_files_aud
  after update of attachments or delete on public.chat_messages
  for each row execute function public.chat_messages_files_aud();

-- Чат удалён (группа, последний вышел, чат проекта или задачи): файлы его
-- папки — на проверку (и загруженные, но не отправленные), из своих папок
-- и уведомлений — долой.
create or replace function public.chat_chats_cleanup_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_purge_enqueue_prefix('chat-files', old.id::text || '/');
  update public.chat_folders set chat_ids = array_remove(chat_ids, old.id)
   where old.id = any (chat_ids);
  delete from public.notif_items
   where url like '/chats/' || old.id::text || '%'
      or group_key in ('chat:' || old.id::text, 'chatmention:' || old.id::text);
  return null;
end;
$$;
drop trigger if exists chat_chats_cleanup_ad on public.chat_chats;
create trigger chat_chats_cleanup_ad
  after delete on public.chat_chats
  for each row execute function public.chat_chats_cleanup_ad();

-- 3. Звонки: комната удалённого звонка ---------------------------------------

create table if not exists public.chat_call_room_purge (
  call_id uuid primary key,
  room_id text not null,
  queued_at timestamptz not null default now()
);
alter table public.chat_call_room_purge enable row level security;
revoke all on public.chat_call_room_purge from public, anon, authenticated;
grant all on public.chat_call_room_purge to service_role;

create or replace function public.chat_calls_room_bd()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.room_id is not null and old.room_deleted_at is null then
    insert into public.chat_call_room_purge (call_id, room_id) values (old.id, old.room_id)
    on conflict do nothing;
  end if;
  return old;
end;
$$;
drop trigger if exists chat_calls_room_bd on public.chat_calls;
create trigger chat_calls_room_bd
  before delete on public.chat_calls
  for each row execute function public.chat_calls_room_bd();

-- Прежнее определение — 2026-11-08_zzz_chat_calls.sql; актуальное — здесь:
-- и комнаты звонков удалённых чатов.
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
    (select c.id, c.room_id from public.chat_calls c
      where c.ended_at is not null and c.room_deleted_at is null and c.room_id is not null
      order by c.ended_at
      limit 50)
    union all
    (select q.call_id, q.room_id from public.chat_call_room_purge q
      order by q.queued_at
      limit 50);
end;
$$;

create or replace function public.chat_call_room_deleted(p_call uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.chat_calls set room_deleted_at = now() where id = p_call;
  delete from public.chat_call_room_purge where call_id = p_call;
$$;

-- 4. Задачи -------------------------------------------------------------------

-- Убрали файл из задачи — проверить (у постановки «отдельно каждому» его
-- держат и другие задачи).
create or replace function public.task_files_purge_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_purge_enqueue('task-files', array[old.path]);
  return null;
end;
$$;
drop trigger if exists task_files_purge_ad on public.task_files;
create trigger task_files_purge_ad
  after delete on public.task_files
  for each row execute function public.task_files_purge_ad();

-- Задача удалена: файлы её папок, обсуждение, уведомления.
create or replace function public.tasks_cleanup_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_purge_enqueue_prefix('task-files', old.id::text || '/');
  perform public.storage_purge_enqueue_prefix('kb-media', 'tasks/' || old.id::text || '/');
  delete from public.notif_items
   where group_key = 'task:' || old.id::text
      or url = '/tasks/' || old.number
      or url like '/tasks/' || old.number || '?%';
  if old.chat_id is not null then
    perform public.chat_broadcast(old.chat_id, jsonb_build_object('type', 'removed'));
    delete from public.chat_chats where id = old.chat_id and kind = 'task';
  end if;
  return null;
end;
$$;
drop trigger if exists tasks_cleanup_ad on public.tasks;
create trigger tasks_cleanup_ad
  after delete on public.tasks
  for each row execute function public.tasks_cleanup_ad();

-- Прежнее определение — 2026-11-08_zzz_task_projects.sql («задачи остаются
-- без проекта»); актуальное — здесь: проект уходит со своими задачами
-- (файлы, чек-листы, история, обсуждения, напоминания, уведомления),
-- шаблонами, регулярными задачами, стадиями и чатом. Сохранить — «В архив».
create or replace function public.task_project_delete(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_chat uuid;
  r record;
begin
  if not (public.task_project_role(p_project, v_uid) = 'owner'
          or public.access_has_right(v_uid, 'tasks.admin')) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  select chat_id into v_chat from public.task_projects where id = p_project for update;
  for r in select id from public.tasks where project_id = p_project loop
    perform public.task_broadcast(r.id);
  end loop;
  delete from public.tasks where project_id = p_project;
  if v_chat is not null then
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'));
    delete from public.chat_chats where id = v_chat;
  end if;
  delete from public.task_projects where id = p_project;
end;
$$;

-- Картинки описаний задач — и в шаблонах задач. Прежнее определение —
-- 2026-11-08_zz_tasks.sql; актуальное — здесь.
create or replace function public.kb_file_gc_candidates(
  p_grace_days integer default 7, p_limit integer default 500
)
returns table (name text)
language sql
stable
security definer
set search_path = public, storage
as $$
  with docs as (
    select n.content::text as t from public.kb_nodes n where n.content is not null
    union all select d.content::text from public.kb_drafts d
    union all select v.content::text from public.kb_revisions v
    union all select tp.content::text from public.kb_templates tp
    union all select tr.payload::text from public.kb_trash tr
    union all select s.content::text from public.acad_steps s where s.content is not null
    union all select c.cover from public.acad_courses c where c.cover is not null
    union all select an.answer::text from public.acad_answers an
    union all select tk.description::text from public.tasks tk where tk.description is not null
    union all select tt.task::text from public.task_templates tt
  ),
  refs as (
    select distinct m[1] as path
      from docs, regexp_matches(docs.t, 'kbfile:([A-Za-z0-9._/-]+)', 'g') m
  )
  select o.name
    from storage.objects o
   where o.bucket_id = 'kb-media'
     and o.created_at < now() - make_interval(days => greatest(coalesce(p_grace_days, 7), 1))
     and not exists (select 1 from refs where refs.path = o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;

-- 5. Люди, клубы, «Аналитика» -------------------------------------------------

-- Аватарка человека портала заменена или учётная запись удалена.
create or replace function public.profiles_avatar_purge_aud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.avatar_url like 'staff/%'
     and (tg_op = 'DELETE' or new.avatar_url is distinct from old.avatar_url) then
    perform public.storage_purge_enqueue('avatars', array[old.avatar_url]);
  end if;
  return null;
end;
$$;
drop trigger if exists profiles_avatar_purge_aud on public.profiles;
create trigger profiles_avatar_purge_aud
  after update of avatar_url or delete on public.profiles
  for each row execute function public.profiles_avatar_purge_aud();

-- Клуб удалён (вся его папка) или сменил логотип / картинку.
create or replace function public.studios_files_purge_aud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.storage_purge_enqueue_prefix('studio-logos', old.id::text || '/');
  end if;
  perform public.storage_purge_enqueue('studio-logos', array(
    select regexp_replace(v, '^.*/studio-logos/', '')
      from unnest(array[old.logo_url, old.photo_url]) v
     where v is not null
       and (tg_op = 'DELETE' or v is distinct from new.logo_url and v is distinct from new.photo_url)));
  return null;
end;
$$;
drop trigger if exists studios_files_purge_aud on public.studios;
create trigger studios_files_purge_aud
  after update of logo_url, photo_url or delete on public.studios
  for each row execute function public.studios_files_purge_aud();

-- Пост контент-плана удалён — его картинки.
create or replace function public.an_content_media_purge_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_purge_enqueue('an-content', array[old.storage_path]);
  return null;
end;
$$;
drop trigger if exists an_content_media_purge_ad on public.an_content_post_media;
create trigger an_content_media_purge_ad
  after delete on public.an_content_post_media
  for each row execute function public.an_content_media_purge_ad();

-- Выгрузка 1С удалена или заменена новой с тем же именем.
create or replace function public.an_onec_files_purge_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_purge_enqueue('an-onec', array[old.path]);
  return null;
end;
$$;
drop trigger if exists an_onec_files_purge_ad on public.an_onec_files;
create trigger an_onec_files_purge_ad
  after delete on public.an_onec_files
  for each row execute function public.an_onec_files_purge_ad();

-- 6. Права на функции ---------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.storage_purge_enqueue(text, text[])',
    'public.storage_purge_enqueue_prefix(text, text)',
    'public.storage_file_referenced(text, text)',
    'public.storage_purge_due(integer)',
    'public.storage_gc_candidates(integer)',
    'public.chat_call_sweep()',
    'public.chat_call_room_deleted(uuid)',
    'public.kb_file_gc_candidates(integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chat_messages_files_aud()',
    'public.chat_chats_cleanup_ad()',
    'public.chat_calls_room_bd()',
    'public.task_files_purge_ad()',
    'public.tasks_cleanup_ad()',
    'public.profiles_avatar_purge_aud()',
    'public.studios_files_purge_aud()',
    'public.an_content_media_purge_ad()',
    'public.an_onec_files_purge_ad()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.task_project_delete(uuid) from public, anon';
  execute 'grant execute on function public.task_project_delete(uuid) to authenticated';
end $$;

notify pgrst, 'reload schema';
