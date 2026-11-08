-- ============================================================================
-- Задачи портала (TASKS_CHATS_PLAN.md, веха 3, 2026-11-08) — замена задач
-- Битрикс24.
--
-- Задача — `tasks`: сквозной номер `number` (#1234, ссылка /tasks/1234),
-- название, описание (документ BlockNote — редактор базы знаний; чистый
-- текст и поиск считает база), статус (new → in_progress → (review) → done,
-- плюс deferred и cancelled; «просрочена» — признак, не статус), срочность,
-- срок (момент времени; показывает портал в поясе человека), «Требует
-- проверки», `batch_id` — «отдельная задача каждому» одной постановкой.
--
-- Люди — `task_members`: постановщик (кто создал, принимает работу; один),
-- исполнитель (один), соисполнители, наблюдатели. У человека кроме роли
-- постановщика — не больше одной роли. Видят задачу участники, руководители
-- и заместители подразделений участников (и выше) и право `tasks.admin`;
-- руководитель и `tasks.admin` правят как постановщик.
--
-- Кто что меняет (план, 4.2): название, описание, срочность, проверка,
-- участники — постановщик; срок — постановщик свободно, исполнитель — с
-- причиной (правило срока портала, `task_deadline_rule`); чек-листы и файлы —
-- постановщик, исполнитель, соисполнители; делегировать — исполнитель
-- (прежний становится наблюдателем); завершить — исполнитель (при «Требует
-- проверки» — «На проверку») и постановщик; принять / вернуть / отменить —
-- постановщик.
--
-- Чек-листы `task_checklists` / `task_checklist_items` (у пункта — свой
-- исполнитель, кто и когда отметил), файлы `task_files` (закрытый бакет
-- `task-files`, папка — задача; при постановке — `new/<человек>/`; одна
-- копия файла у всех задач одной постановки), история `task_events` (в
-- обсуждение не подмешивается), личные напоминания `task_reminders`,
-- уровень уведомлений и «последнее увиденное» `task_user_state`,
-- сохранённые фильтры `task_saved_filters`.
--
-- Обсуждение — чат задачи (`chat_chats.kind = 'task'`): не создаётся сам —
-- по кнопке «Начать обсуждение» (`task_chat_open`); участники чата =
-- участники задачи (меняются вместе); в мессенджере — папка «Задачи»; из
-- служебного в нём — только смена статуса.
--
-- Уведомления (notif_send): «вам поставили задачу» (task.assigned), «на
-- проверке» (task.review), «вернули» (task.returned), «срок через час»
-- (task.soon), «просрочена» — один раз (task.overdue), своё напоминание
-- (task.reminder), постановщику — сводка просроченного раз в день
-- (task.digest); без пуша по умолчанию — «завершена» (task.done), «принята»
-- (task.accepted), «срок перенесён» (task.deadline). У задачи — «все /
-- только когда нужно моё действие / ничего». Время и сводку считает
-- `task_tick` (сервер портала раз в минуту).
--
-- Производственный календарь России — `work_calendar` (день → рабочий /
-- выходной / сокращённый; заполняет сервер раз в год из isdayoff.ru —
-- `work_calendar_store`); дня нет — суббота и воскресенье выходные.
--
-- Все таблицы закрыты браузеру — только RPC `task_*` (security definer,
-- проверка прав внутри). Идемпотентно.
-- ============================================================================

-- 1. Таблицы -----------------------------------------------------------------

create sequence if not exists public.tasks_number_seq;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  number bigint not null default nextval('public.tasks_number_seq'),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  -- Документ BlockNote (массив блоков), как статья базы знаний.
  description jsonb,
  description_text text not null default '',
  status text not null default 'new'
    check (status in ('new', 'in_progress', 'review', 'done', 'deferred', 'cancelled')),
  urgent boolean not null default false,
  deadline timestamptz,
  requires_review boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Последнее значимое изменение — «есть новое» у участников.
  activity_at timestamptz not null default now(),
  completed_at timestamptz,
  -- «Отдельная задача каждому»: задачи одной постановки.
  batch_id uuid,
  chat_id uuid references public.chat_chats (id) on delete set null,
  soon_notified_at timestamptz,
  overdue_notified_at timestamptz,
  bitrix_id bigint,
  search tsvector
);
alter sequence public.tasks_number_seq owned by public.tasks.number;
create unique index if not exists tasks_number_uidx on public.tasks (number);
create unique index if not exists tasks_bitrix_uidx on public.tasks (bitrix_id) where bitrix_id is not null;
create index if not exists tasks_open_deadline_idx on public.tasks (deadline)
  where status not in ('done', 'cancelled');
create index if not exists tasks_batch_idx on public.tasks (batch_id) where batch_id is not null;
create index if not exists tasks_search_idx on public.tasks using gin (search);
create index if not exists tasks_chat_idx on public.tasks (chat_id) where chat_id is not null;

create table if not exists public.task_members (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('creator', 'assignee', 'coassignee', 'watcher')),
  added_at timestamptz not null default now(),
  added_by uuid references auth.users (id) on delete set null,
  primary key (task_id, user_id, role)
);
create unique index if not exists task_members_creator_uidx on public.task_members (task_id)
  where role = 'creator';
create unique index if not exists task_members_assignee_uidx on public.task_members (task_id)
  where role = 'assignee';
create index if not exists task_members_user_idx on public.task_members (user_id, role);

create table if not exists public.task_user_state (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- all — всё; mine — только когда нужно моё действие; none — ничего (кроме
  -- своих напоминаний).
  notify text not null default 'all' check (notify in ('all', 'mine', 'none')),
  seen_at timestamptz,
  primary key (task_id, user_id)
);

create table if not exists public.task_checklists (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_checklists_task_idx on public.task_checklists (task_id, sort_order);

create table if not exists public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.task_checklists (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 1000),
  sort_order integer not null default 0,
  assignee_id uuid references auth.users (id) on delete set null,
  done_at timestamptz,
  done_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists task_checklist_items_list_idx
  on public.task_checklist_items (checklist_id, sort_order);
create index if not exists task_checklist_items_assignee_idx
  on public.task_checklist_items (assignee_id) where done_at is null;

create table if not exists public.task_files (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  path text not null check (char_length(path) between 3 and 500),
  name text not null check (char_length(name) between 1 and 300),
  mime text not null default 'application/octet-stream',
  size bigint not null default 0,
  width integer,
  height integer,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists task_files_task_idx on public.task_files (task_id, created_at);
create index if not exists task_files_path_idx on public.task_files (path);

create table if not exists public.task_events (
  id bigserial primary key,
  task_id uuid not null references public.tasks (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  reason text check (reason is null or char_length(reason) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists task_events_task_idx on public.task_events (task_id, id);

create table if not exists public.task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  remind_at timestamptz not null,
  -- «За N минут до срока» — пересчитывается при смене срока.
  before_minutes integer check (before_minutes is null or before_minutes between 1 and 43200),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists task_reminders_due_idx on public.task_reminders (remind_at) where sent_at is null;
create index if not exists task_reminders_task_idx on public.task_reminders (task_id, user_id);

create table if not exists public.task_saved_filters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_saved_filters_user_idx on public.task_saved_filters (user_id, sort_order);

create table if not exists public.task_digest_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);

create table if not exists public.work_calendar (
  day date primary key,
  kind text not null check (kind in ('work', 'off', 'short')),
  updated_at timestamptz not null default now()
);

create table if not exists public.work_calendar_years (
  year integer primary key,
  source text not null,
  loaded_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'task_members', 'task_user_state', 'task_checklists',
    'task_checklist_items', 'task_files', 'task_events', 'task_reminders', 'task_saved_filters',
    'task_digest_log', 'work_calendar', 'work_calendar_years'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Поиск: номер и название — выше, текст описания — ниже.
create or replace function public.tasks_search_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.description is not null and jsonb_typeof(new.description) = 'array' then
    new.description_text := left(coalesce((
      select string_agg(v #>> '{}', ' ')
        from jsonb_path_query(new.description, 'strict $.**.text') v
       where jsonb_typeof(v) = 'string'), ''), 100000);
  else
    new.description_text := '';
  end if;
  new.search := setweight(to_tsvector('russian', new.number::text || ' ' || new.title), 'A')
             || setweight(to_tsvector('russian', new.description_text), 'B');
  return new;
end;
$$;
drop trigger if exists tasks_search_biu on public.tasks;
create trigger tasks_search_biu
  before insert or update of title, description on public.tasks
  for each row execute function public.tasks_search_biu();

-- 2. Право «Администратор задач» -------------------------------------------------

insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('tasks.admin', 'admin', 'Администратор задач',
   'Видит все задачи портала и правит их как постановщик.', 'network', '{on}', null, 340)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

-- 3. Чат задачи ----------------------------------------------------------------

alter table public.chat_chats drop constraint if exists chat_chats_kind_check;
alter table public.chat_chats add constraint chat_chats_kind_check
  check (kind in ('direct', 'group', 'self', 'task'));

-- Сообщения чата задачи — как в группе: пуш «chat.group» (выключен по
-- умолчанию), упоминания — как везде. Прежнее определение —
-- 2026-11-08_chats.sql; актуальное — здесь.
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
        case when c.kind in ('group', 'task') then '«' || c.title || '»: ' else '' end || v_preview,
        v_url, m.author_id, 'chatmention:' || m.chat_id, false, true);
    elsif r.notify = 'all' and (r.muted_until is null or r.muted_until < now()) then
      if c.kind = 'direct' then
        perform public.notif_send_ex(r.user_id, 'chat.direct', v_author, v_preview, v_url,
          m.author_id, 'chat:' || m.chat_id, false, false);
      elsif c.kind in ('group', 'task') then
        perform public.notif_send_ex(r.user_id, 'chat.group', c.title, v_author || ': ' || v_preview,
          v_url, m.author_id, 'chat:' || m.chat_id, false, false);
      end if;
    end if;
  end loop;
end;
$$;

-- 4. Пуш по умолчанию у новых видов -------------------------------------------
-- Прежнее определение — 2026-11-07_zz_portal_notifications.sql; актуальное —
-- здесь (тест админки сверяет с lib/notifications/kinds.ts).
create or replace function public.notif_default_push(p_kind text)
returns boolean
language sql
immutable
as $$
  select p_kind not in ('chat.group', 'task.done', 'task.accepted', 'task.deadline')
$$;

-- Сгруппированная строка ленты берёт вид последнего события (у задачи
-- «поставили» → «вернули на доработку» — одна строка на задачу). Прежнее
-- определение — 2026-11-08_chats.sql; актуальное — здесь.
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
       set kind = p_kind,
           title = v_title,
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

-- 5. Доступ ----------------------------------------------------------------------

-- Люди подразделений, где человек — руководитель или заместитель, и ниже.
create or replace function public.task_led_user_ids(p_uid uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
    from public.org_unit_members lead
    join public.org_units sub on sub.id = lead.unit_id or lead.unit_id = any (sub.path)
    join public.org_unit_members m on m.unit_id = sub.id
   where lead.user_id = p_uid and lead.member_role in ('head', 'deputy')
$$;

create or replace function public.task_is_manager(p_task uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(p_uid, 'tasks.admin')
      or exists (select 1 from public.task_members m
                  where m.task_id = p_task and m.user_id <> p_uid
                    and m.user_id = any (public.task_led_user_ids(p_uid)))
$$;

-- Роли человека в задаче: creator / assignee / coassignee / watcher и
-- «manager» (руководитель участника или tasks.admin). Пусто — не видит.
create or replace function public.task_roles(p_task uuid, p_uid uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select array_agg(role order by role) from public.task_members
                    where task_id = p_task and user_id = p_uid), '{}')
      || case when p_uid is not null and public.task_is_manager(p_task, p_uid)
              then array['manager'] else '{}'::text[] end
$$;

-- Правило срока портала (у проектов вехи 4 будет своё): free — исполнитель
-- меняет срок свободно, reason — с причиной, forbid — не меняет.
create or replace function public.task_deadline_rule()
returns text
language sql
immutable
as $$
  select 'reason'
$$;

create or replace function public.task_require(p_task uuid, p_need text, out uid uuid, out roles text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  uid := public.chat_require_portal();
  roles := public.task_roles(p_task, uid);
  if cardinality(roles) = 0 then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  if p_need = 'boss' and not roles && array['creator', 'manager'] then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if p_need = 'worker' and not roles && array['creator', 'manager', 'assignee', 'coassignee'] then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
end;
$$;

-- 6. Служебное: история, «новое», события, уведомления ------------------------------

create or replace function public.task_event(p_task uuid, p_actor uuid, p_kind text,
                                             p_data jsonb default '{}'::jsonb, p_reason text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.task_events (task_id, actor_id, kind, data, reason)
  values (p_task, p_actor, p_kind, coalesce(p_data, '{}'::jsonb), left(nullif(btrim(p_reason), ''), 2000))
$$;

-- Живое обновление: участникам — событие «task» в личную тему Realtime.
create or replace function public.task_broadcast(p_task uuid, p_also uuid[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_number bigint;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  select number into v_number from public.tasks where id = p_task;
  begin
    for r in
      select distinct user_id from public.task_members where task_id = p_task
      union
      select u from unnest(coalesce(p_also, '{}'::uuid[])) u
    loop
      perform realtime.send(jsonb_build_object('type', 'task', 'task_id', p_task, 'number', v_number),
                            'task', 'user:' || r.user_id::text, true);
    end loop;
  exception when others then
    null;
  end;
end;
$$;

-- Значимое изменение: «есть новое» у остальных, у автора — просмотрено.
create or replace function public.task_touch(p_task uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks set activity_at = now(), updated_at = now() where id = p_task;
  if p_actor is not null then
    insert into public.task_user_state (task_id, user_id, seen_at) values (p_task, p_actor, now())
    on conflict (task_id, user_id) do update set seen_at = now();
  end if;
  perform public.task_broadcast(p_task);
end;
$$;

-- Уведомление участнику. p_level: mine — от человека нужно действие; all —
-- для сведения. Своё напоминание приходит всегда.
create or replace function public.task_notify(p_task uuid, p_user uuid, p_kind text, p_title text,
                                              p_actor uuid, p_level text default 'mine')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.tasks;
  v_notify text;
begin
  if p_user is null or p_user = p_actor then
    return;
  end if;
  select * into t from public.tasks where id = p_task;
  select notify into v_notify from public.task_user_state where task_id = p_task and user_id = p_user;
  v_notify := coalesce(v_notify, 'all');
  if p_kind <> 'task.reminder' and (v_notify = 'none' or (v_notify = 'mine' and p_level = 'all')) then
    return;
  end if;
  perform public.notif_send(p_user, p_kind, p_title, '#' || t.number || ' ' || t.title,
                            '/tasks/' || t.number, p_actor, 'task:' || p_task);
end;
$$;

-- Состав чата задачи = участники задачи.
create or replace function public.task_chat_sync(p_task uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
  r record;
begin
  select chat_id into v_chat from public.tasks where id = p_task;
  if v_chat is null then
    return;
  end if;
  insert into public.chat_members (chat_id, user_id, role)
  select distinct v_chat, m.user_id, 'member' from public.task_members m where m.task_id = p_task
  on conflict (chat_id, user_id) do nothing;
  for r in
    select cm.user_id from public.chat_members cm
     where cm.chat_id = v_chat
       and not exists (select 1 from public.task_members m
                        where m.task_id = p_task and m.user_id = cm.user_id)
  loop
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'), array[r.user_id]);
    delete from public.chat_members where chat_id = v_chat and user_id = r.user_id;
  end loop;
  perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'members'));
end;
$$;

-- 7. Задача в JSON ----------------------------------------------------------------

create or replace function public.task_json(t public.tasks, p_uid uuid, p_full boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  s public.task_user_state;
  v_roles text[];
begin
  select * into s from public.task_user_state where task_id = t.id and user_id = p_uid;
  if p_full then
    v_roles := public.task_roles(t.id, p_uid);
  else
    select coalesce(array_agg(role order by role), '{}') into v_roles
      from public.task_members where task_id = t.id and user_id = p_uid;
  end if;
  v := jsonb_build_object(
    'id', t.id, 'number', t.number, 'title', t.title, 'status', t.status, 'urgent', t.urgent,
    'deadline', t.deadline, 'requires_review', t.requires_review, 'created_by', t.created_by,
    'created_at', t.created_at, 'updated_at', t.updated_at, 'completed_at', t.completed_at,
    'batch_id', t.batch_id, 'chat_id', t.chat_id,
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role)
                                          order by m.added_at, m.user_id)
                           from public.task_members m where m.task_id = t.id), '[]'),
    'my_roles', to_jsonb(v_roles),
    'notify', coalesce(s.notify, 'all'),
    'unseen', s.seen_at is null or s.seen_at < t.activity_at,
    'check_total', (select count(*) from public.task_checklist_items i where i.task_id = t.id),
    'check_done', (select count(*) from public.task_checklist_items i
                    where i.task_id = t.id and i.done_at is not null),
    'files_count', (select count(*) from public.task_files f where f.task_id = t.id)
  );
  if t.batch_id is not null then
    v := v || jsonb_build_object('batch', (
      select jsonb_build_object(
               'total', count(*),
               'done', count(*) filter (where b.status = 'done'),
               'cancelled', count(*) filter (where b.status = 'cancelled'),
               'overdue', count(*) filter (where b.status not in ('done', 'cancelled')
                                             and b.deadline < now()))
        from public.tasks b where b.batch_id = t.batch_id));
  end if;
  if p_full then
    v := v || jsonb_build_object(
      'description', t.description,
      'deadline_rule', public.task_deadline_rule(),
      'checklists', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', cl.id, 'title', cl.title,
                 'items', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'id', i.id, 'text', i.text, 'assignee_id', i.assignee_id,
                            'done_at', i.done_at, 'done_by', i.done_by)
                          order by i.sort_order, i.created_at)
                     from public.task_checklist_items i where i.checklist_id = cl.id), '[]'))
               order by cl.sort_order, cl.created_at)
          from public.task_checklists cl where cl.task_id = t.id), '[]'),
      'files', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', f.id, 'path', f.path, 'name', f.name, 'mime', f.mime, 'size', f.size,
                 'width', f.width, 'height', f.height, 'uploaded_by', f.uploaded_by,
                 'created_at', f.created_at)
               order by f.created_at)
          from public.task_files f where f.task_id = t.id), '[]'),
      'reminders', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', r.id, 'remind_at', r.remind_at, 'before_minutes', r.before_minutes,
                 'sent_at', r.sent_at)
               order by r.remind_at)
          from public.task_reminders r where r.task_id = t.id and r.user_id = p_uid), '[]'));
  end if;
  return v;
end;
$$;

-- 8. Чтение ----------------------------------------------------------------------

-- Список задач человека. p: role (do / help / assigned / watch / all),
-- statuses [], show_done, deadline (overdue / today / week / none / range +
-- deadline_from, deadline_to — даты), creator, assignee, created_from,
-- created_to, q (номер, название, описание), checklist_mine, batch,
-- scope = 'all' (tasks.admin — все задачи), limit (до 200), offset.
-- Порядок: незавершённые по сроку (без срока — ниже), завершённые — внизу.
create or replace function public.task_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  p0 jsonb := coalesce(p, '{}'::jsonb);
  v_role text := coalesce(nullif(p0->>'role', ''), 'all');
  v_all boolean := p0->>'scope' = 'all' and public.access_has_right(auth.uid(), 'tasks.admin');
  v_show_done boolean := coalesce((p0->>'show_done')::boolean, false);
  v_statuses text[] := case when jsonb_typeof(p0->'statuses') = 'array' and jsonb_array_length(p0->'statuses') > 0
                            then array(select jsonb_array_elements_text(p0->'statuses')) end;
  v_deadline text := nullif(p0->>'deadline', '');
  v_creator uuid := nullif(p0->>'creator', '')::uuid;
  v_assignee uuid := nullif(p0->>'assignee', '')::uuid;
  v_batch uuid := nullif(p0->>'batch', '')::uuid;
  v_q text := btrim(coalesce(p0->>'q', ''));
  v_num bigint;
  v_tsq tsquery;
  v_check boolean := coalesce((p0->>'checklist_mine')::boolean, false);
  v_limit integer := least(greatest(coalesce((p0->>'limit')::int, 100), 1), 200);
  v_offset integer := greatest(coalesce((p0->>'offset')::int, 0), 0);
  v_tz text;
  v_today timestamptz;
  v_tomorrow timestamptz;
  v_week_end timestamptz;
  v_dfrom timestamptz;
  v_dto timestamptz;
  v_cfrom timestamptz;
  v_cto timestamptz;
  v_rows jsonb;
  v_count integer;
begin
  select coalesce(max(timezone), 'Europe/Moscow') into v_tz
    from public.portal_user_settings where user_id = v_uid;
  v_today := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_tomorrow := ((now() at time zone v_tz)::date + 1)::timestamp at time zone v_tz;
  v_week_end := (date_trunc('week', (now() at time zone v_tz)) + interval '7 days') at time zone v_tz;
  v_dfrom := (nullif(p0->>'deadline_from', '')::date)::timestamp at time zone v_tz;
  v_dto := (nullif(p0->>'deadline_to', '')::date + 1)::timestamp at time zone v_tz;
  v_cfrom := (nullif(p0->>'created_from', '')::date)::timestamp at time zone v_tz;
  v_cto := (nullif(p0->>'created_to', '')::date + 1)::timestamp at time zone v_tz;
  if v_q ~ '^#?[0-9]{1,15}$' then
    v_num := ltrim(v_q, '#')::bigint;
  elsif v_q <> '' then
    v_tsq := public.kb_prefix_tsquery(v_q);
  end if;

  with mine as (
    select m.task_id, array_agg(m.role) as roles
      from public.task_members m where m.user_id = v_uid group by m.task_id
  ),
  base as (
    select mine.task_id, mine.roles from mine
    union all
    select t.id, '{}'::text[] from public.tasks t
     where v_all and not exists (select 1 from mine where mine.task_id = t.id)
  ),
  picked as (
    select t as task,
           row_number() over (
             order by (t.status in ('done', 'cancelled')),
                      case when t.status in ('done', 'cancelled') then t.completed_at end desc nulls last,
                      t.deadline asc nulls last, t.urgent desc, t.created_at desc, t.number desc) as rn
      from base join public.tasks t on t.id = base.task_id
     where (v_role = 'all' and (cardinality(base.roles) > 0 or v_all)
            or v_role = 'do' and 'assignee' = any (base.roles)
            or v_role = 'help' and 'coassignee' = any (base.roles)
            or v_role = 'assigned' and 'creator' = any (base.roles) and not 'assignee' = any (base.roles)
            or v_role = 'watch' and 'watcher' = any (base.roles))
       and (v_show_done or v_statuses is not null or t.status not in ('done', 'cancelled'))
       and (v_statuses is null or t.status = any (v_statuses))
       and (v_deadline is null
            or v_deadline = 'overdue' and t.deadline < now() and t.status not in ('done', 'cancelled')
            or v_deadline = 'today' and t.deadline >= v_today and t.deadline < v_tomorrow
            or v_deadline = 'week' and t.deadline >= v_today and t.deadline < v_week_end
            or v_deadline = 'none' and t.deadline is null
            or v_deadline = 'range' and (v_dfrom is null or t.deadline >= v_dfrom)
                                     and (v_dto is null or t.deadline < v_dto))
       and (v_creator is null or exists (select 1 from public.task_members x
                                          where x.task_id = t.id and x.role = 'creator' and x.user_id = v_creator))
       and (v_assignee is null or exists (select 1 from public.task_members x
                                           where x.task_id = t.id and x.role = 'assignee' and x.user_id = v_assignee))
       and (v_batch is null or t.batch_id = v_batch)
       and (v_cfrom is null or t.created_at >= v_cfrom)
       and (v_cto is null or t.created_at < v_cto)
       and (v_q = '' or (v_num is not null and t.number = v_num)
            or (v_tsq is not null and t.search @@ v_tsq))
       and (not v_check or exists (select 1 from public.task_checklist_items i
                                    where i.task_id = t.id and i.assignee_id = v_uid and i.done_at is null))
     order by rn
     limit v_limit + 1 offset v_offset
  )
  select coalesce(jsonb_agg(public.task_json(picked.task, v_uid) order by picked.rn), '[]'), count(*)
    into v_rows, v_count
    from picked;

  if v_count > v_limit then
    v_rows := v_rows - v_limit;
  end if;
  return jsonb_build_object('rows', v_rows, 'has_more', v_count > v_limit);
end;
$$;

-- Карточка задачи по номеру; отмечает просмотренной.
create or replace function public.task_get(p_number bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  t public.tasks;
begin
  select * into t from public.tasks where number = p_number;
  if not found or cardinality(public.task_roles(t.id, v_uid)) = 0 then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  if exists (select 1 from public.task_members where task_id = t.id and user_id = v_uid) then
    insert into public.task_user_state (task_id, user_id, seen_at) values (t.id, v_uid, now())
    on conflict (task_id, user_id) do update set seen_at = now();
  end if;
  return public.task_json(t, v_uid, true);
end;
$$;

create or replace function public.task_history(p_task uuid)
returns table (id bigint, actor_id uuid, kind text, data jsonb, reason text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.task_require(p_task, 'view');
  return query
  select e.id, e.actor_id, e.kind, e.data, e.reason, e.created_at
    from public.task_events e where e.task_id = p_task order by e.id desc limit 500;
end;
$$;

-- Счётчики раздела: просрочено у меня как исполнителя, ждут моей проверки,
-- новое в задачах, где я исполнитель или соисполнитель.
create or replace function public.task_counters()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select t.id, t.status, t.deadline, t.activity_at, m.role
      from public.task_members m join public.tasks t on t.id = m.task_id
     where m.user_id = auth.uid()
  ),
  flags as (
    select mine.id,
           bool_or(role = 'assignee' and status in ('new', 'in_progress', 'deferred') and deadline < now()) as overdue,
           bool_or(role = 'creator' and status = 'review') as review,
           bool_or(role in ('assignee', 'coassignee') and status not in ('done', 'cancelled')
                   and not exists (select 1 from public.task_user_state s
                                    where s.task_id = mine.id and s.user_id = auth.uid()
                                      and s.seen_at >= mine.activity_at)) as unseen
      from mine group by mine.id
  )
  select jsonb_build_object(
    'overdue', count(*) filter (where overdue),
    'review', count(*) filter (where review),
    'unseen', count(*) filter (where unseen),
    'badge', count(*) filter (where overdue or review or unseen))
    from flags
$$;

-- 9. Постановка ------------------------------------------------------------------

create or replace function public.task_uuid_array(p jsonb)
returns uuid[]
language sql
immutable
as $$
  select coalesce(array(select distinct x::uuid from jsonb_array_elements_text(
           case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) x), '{}')
$$;

-- Участники одной задачи: исполнитель > соисполнитель > наблюдатель, у
-- человека одна роль (кроме постановщика). Только люди портала.
create or replace function public.task_put_members(p_task uuid, p_actor uuid, p_assignee uuid,
                                                   p_coassignees uuid[], p_watchers uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_assignee is null or not public.is_portal_user(p_assignee) then
    raise exception 'task_bad_assignee' using errcode = '22023';
  end if;
  insert into public.task_members (task_id, user_id, role, added_by)
  values (p_task, p_assignee, 'assignee', p_actor);
  insert into public.task_members (task_id, user_id, role, added_by)
  select p_task, u, 'coassignee', p_actor
    from unnest(coalesce(p_coassignees, '{}')) u
   where u <> p_assignee and public.is_portal_user(u)
   limit 200
  on conflict do nothing;
  insert into public.task_members (task_id, user_id, role, added_by)
  select p_task, u, 'watcher', p_actor
    from unnest(coalesce(p_watchers, '{}')) u
   where u <> p_assignee and not u = any (coalesce(p_coassignees, '{}'))
     and public.is_portal_user(u)
   limit 200
  on conflict do nothing;
end;
$$;

-- Чек-листы задачи из [{title, items: [{text, assignee_id}]}].
create or replace function public.task_put_checklists(p_task uuid, p_actor uuid, p_lists jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l jsonb;
  i jsonb;
  v_list uuid;
  n integer := 0;
  k integer;
  v_who uuid;
begin
  for l in select * from jsonb_array_elements(case when jsonb_typeof(p_lists) = 'array' then p_lists else '[]' end)
  loop
    n := n + 1;
    exit when n > 20;
    insert into public.task_checklists (task_id, title, sort_order)
    values (p_task, left(coalesce(nullif(btrim(l->>'title'), ''), 'Чек-лист'), 200), n)
    returning id into v_list;
    k := 0;
    for i in select * from jsonb_array_elements(case when jsonb_typeof(l->'items') = 'array' then l->'items' else '[]' end)
    loop
      continue when coalesce(btrim(i->>'text'), '') = '';
      k := k + 1;
      exit when k > 200;
      v_who := nullif(i->>'assignee_id', '')::uuid;
      if v_who is not null and not public.is_portal_user(v_who) then
        v_who := null;
      end if;
      insert into public.task_checklist_items (checklist_id, task_id, text, sort_order, assignee_id)
      values (v_list, p_task, left(btrim(i->>'text'), 1000), k, v_who);
      if v_who is not null and not exists (select 1 from public.task_members
                                             where task_id = p_task and user_id = v_who and role <> 'creator') then
        insert into public.task_members (task_id, user_id, role, added_by)
        values (p_task, v_who, 'coassignee', p_actor) on conflict do nothing;
      end if;
    end loop;
  end loop;
end;
$$;

-- Файлы [{path, name, mime, size, width, height}]: из папки задачи или из
-- своей папки постановки `new/<человек>/`.
create or replace function public.task_put_files(p_task uuid, p_actor uuid, p_files jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  f jsonb;
  n integer := 0;
  v_path text;
begin
  for f in select * from jsonb_array_elements(case when jsonb_typeof(p_files) = 'array' then p_files else '[]' end)
  loop
    v_path := coalesce(f->>'path', '');
    if not (v_path like p_task::text || '/%' or v_path like 'new/' || p_actor::text || '/%')
       or v_path like '%..%' then
      raise exception 'task_bad_file' using errcode = '22023';
    end if;
    n := n + 1;
    exit when n > 50;
    insert into public.task_files (task_id, path, name, mime, size, width, height, uploaded_by)
    values (p_task, v_path, left(coalesce(nullif(f->>'name', ''), 'файл'), 300),
            left(coalesce(nullif(f->>'mime', ''), 'application/octet-stream'), 200),
            greatest(coalesce((f->>'size')::bigint, 0), 0),
            nullif(f->>'width', '')::int, nullif(f->>'height', '')::int, p_actor);
  end loop;
  return n;
end;
$$;

-- Напоминание себе: в момент или «за N минут до срока».
create or replace function public.task_put_reminder(p_task uuid, p_user uuid, p_at timestamptz,
                                                    p_before integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz;
  v_at timestamptz := p_at;
begin
  if p_before is not null then
    select deadline into v_deadline from public.tasks where id = p_task;
    if v_deadline is null then
      raise exception 'task_no_deadline' using errcode = '22023';
    end if;
    v_at := v_deadline - make_interval(mins => p_before);
  end if;
  if v_at is null then
    raise exception 'task_bad_reminder' using errcode = '22023';
  end if;
  if (select count(*) from public.task_reminders where task_id = p_task and user_id = p_user) >= 10 then
    raise exception 'task_too_many_reminders' using errcode = '22023';
  end if;
  insert into public.task_reminders (task_id, user_id, remind_at, before_minutes)
  values (p_task, p_user, v_at, p_before);
end;
$$;

-- Новая задача. p: title, description (документ BlockNote), deadline,
-- urgent, requires_review, assignees [] (пусто — себе), mode (shared —
-- одна общая: первый исполнитель, остальные соисполнители с пунктом
-- чек-листа на каждого; separate — отдельная задача каждому, общий
-- batch_id), coassignees [], watchers [], checklists, files, reminder
-- {remind_at | before_minutes}. Ответ: {tasks: [{id, number}], batch_id}.
create or replace function public.task_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_title text := btrim(coalesce(p->>'title', ''));
  v_assignees uuid[];
  v_order uuid[];
  v_co uuid[] := public.task_uuid_array(p->'coassignees');
  v_watch uuid[] := public.task_uuid_array(p->'watchers');
  v_separate boolean := coalesce(p->>'mode', '') = 'separate';
  v_batch uuid;
  v_deadline timestamptz := nullif(p->>'deadline', '')::timestamptz;
  v_desc jsonb := case when jsonb_typeof(p->'description') = 'array'
                        and jsonb_array_length(p->'description') > 0 then p->'description' end;
  v_lists jsonb := p->'checklists';
  v_task uuid;
  v_number bigint;
  v_out jsonb := '[]'::jsonb;
  a uuid;
  v_shared_list jsonb;
begin
  if char_length(v_title) not between 1 and 300 then
    raise exception 'task_title_invalid' using errcode = '22023';
  end if;
  -- Порядок исполнителей — как выбрали.
  select coalesce(array_agg(x::uuid order by o), '{}') into v_order
    from jsonb_array_elements_text(case when jsonb_typeof(p->'assignees') = 'array'
                                        then p->'assignees' else '[]' end) with ordinality as e(x, o);
  select coalesce(array_agg(u order by min_o), '{}') into v_assignees
    from (select u, min(o) as min_o from unnest(v_order) with ordinality as z(u, o) group by u) d;
  if cardinality(v_assignees) = 0 then
    v_assignees := array[v_uid];
  end if;
  if cardinality(v_assignees) > 300 then
    raise exception 'task_too_many_assignees' using errcode = '22023';
  end if;
  if v_separate and cardinality(v_assignees) > 1 then
    v_batch := gen_random_uuid();
  end if;

  foreach a in array case when v_separate then v_assignees else array[v_assignees[1]] end loop
    insert into public.tasks (title, description, urgent, deadline, requires_review, created_by, batch_id)
    values (v_title, v_desc, coalesce((p->>'urgent')::boolean, false), v_deadline,
            coalesce((p->>'requires_review')::boolean, false), v_uid, v_batch)
    returning id, number into v_task, v_number;
    insert into public.task_members (task_id, user_id, role, added_by) values (v_task, v_uid, 'creator', v_uid);
    if v_separate then
      perform public.task_put_members(v_task, v_uid, a, v_co, v_watch);
    else
      perform public.task_put_members(v_task, v_uid, a, v_assignees[2:] || v_co, v_watch);
    end if;
    perform public.task_put_checklists(v_task, v_uid, v_lists);
    -- Общая задача на нескольких: пункт на каждого исполнителя.
    if not v_separate and cardinality(v_assignees) > 1 then
      select jsonb_build_array(jsonb_build_object('title', 'Исполнители', 'items',
               jsonb_agg(jsonb_build_object('text', public.chat_display_name(u), 'assignee_id', u)
                         order by o)))
        into v_shared_list
        from unnest(v_assignees) with ordinality as z(u, o);
      perform public.task_put_checklists(v_task, v_uid, v_shared_list);
    end if;
    perform public.task_put_files(v_task, v_uid, p->'files');
    if jsonb_typeof(p->'reminder') = 'object' then
      perform public.task_put_reminder(v_task, v_uid, nullif(p->'reminder'->>'remind_at', '')::timestamptz,
                                       nullif(p->'reminder'->>'before_minutes', '')::int);
    end if;
    insert into public.task_user_state (task_id, user_id, seen_at) values (v_task, v_uid, now());
    perform public.task_event(v_task, v_uid, 'created',
      jsonb_build_object('batch_id', v_batch, 'deadline', v_deadline));
    perform public.task_notify(v_task, m.user_id,
              'task.assigned',
              case m.role when 'assignee' then 'Вам поставили задачу' else 'Вы соисполнитель задачи' end,
              v_uid, 'mine')
       from public.task_members m
      where m.task_id = v_task and m.role in ('assignee', 'coassignee');
    perform public.task_broadcast(v_task);
    v_out := v_out || jsonb_build_object('id', v_task, 'number', v_number);
  end loop;
  return jsonb_build_object('tasks', v_out, 'batch_id', v_batch);
end;
$$;

-- 10. Правка ----------------------------------------------------------------------

-- Поля: title, description, urgent, requires_review — постановщик; deadline
-- — постановщик свободно, исполнитель — по правилу срока (причина —
-- p_reason). Ответ — карточка.
create or replace function public.task_update(p_task uuid, p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  t public.tasks;
  v_boss boolean;
  v_deadline timestamptz;
  v_rule text := public.task_deadline_rule();
  v_creator uuid;
  v_changed boolean := false;
begin
  select * into r from public.task_require(p_task, 'view');
  select * into t from public.tasks where id = p_task for update;
  v_boss := r.roles && array['creator', 'manager'];

  if (p ? 'title' or p ? 'description' or p ? 'urgent' or p ? 'requires_review') and not v_boss then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if p ? 'title' and btrim(coalesce(p->>'title', '')) <> t.title then
    if char_length(btrim(coalesce(p->>'title', ''))) not between 1 and 300 then
      raise exception 'task_title_invalid' using errcode = '22023';
    end if;
    perform public.task_event(p_task, r.uid, 'title',
      jsonb_build_object('from', t.title, 'to', btrim(p->>'title')));
    update public.tasks set title = btrim(p->>'title') where id = p_task;
    if t.chat_id is not null then
      update public.chat_chats set title = left('#' || t.number || ' ' || btrim(p->>'title'), 100)
       where id = t.chat_id;
      perform public.chat_broadcast(t.chat_id, jsonb_build_object('type', 'chat'));
    end if;
    v_changed := true;
  end if;
  if p ? 'description' then
    update public.tasks
       set description = case when jsonb_typeof(p->'description') = 'array'
                                   and jsonb_array_length(p->'description') > 0 then p->'description' end
     where id = p_task;
    -- Правки описания в историю — не чаще раза в 10 минут от человека.
    if not exists (select 1 from public.task_events
                    where task_id = p_task and kind = 'description' and actor_id = r.uid
                      and created_at > now() - interval '10 minutes') then
      perform public.task_event(p_task, r.uid, 'description');
    end if;
    v_changed := true;
  end if;
  if p ? 'urgent' and (p->>'urgent')::boolean is distinct from t.urgent then
    update public.tasks set urgent = (p->>'urgent')::boolean where id = p_task;
    perform public.task_event(p_task, r.uid, 'urgent', jsonb_build_object('to', (p->>'urgent')::boolean));
    v_changed := true;
  end if;
  if p ? 'requires_review' and (p->>'requires_review')::boolean is distinct from t.requires_review then
    update public.tasks set requires_review = (p->>'requires_review')::boolean where id = p_task;
    perform public.task_event(p_task, r.uid, 'requires_review',
      jsonb_build_object('to', (p->>'requires_review')::boolean));
    v_changed := true;
  end if;
  if p ? 'deadline' then
    v_deadline := nullif(p->>'deadline', '')::timestamptz;
    if v_deadline is distinct from t.deadline then
      if not v_boss then
        if not 'assignee' = any (r.roles) or v_rule = 'forbid' then
          raise exception 'task_forbidden' using errcode = '42501';
        end if;
        if v_rule = 'reason' and coalesce(btrim(p_reason), '') = '' then
          raise exception 'task_reason_required' using errcode = '22023';
        end if;
      end if;
      update public.tasks
         set deadline = v_deadline, soon_notified_at = null, overdue_notified_at = null
       where id = p_task;
      perform public.task_event(p_task, r.uid, 'deadline',
        jsonb_build_object('from', t.deadline, 'to', v_deadline), p_reason);
      -- «За N до срока» — за новым сроком; без срока такие напоминания уходят.
      if v_deadline is null then
        delete from public.task_reminders where task_id = p_task and before_minutes is not null;
      else
        update public.task_reminders
           set remind_at = v_deadline - make_interval(mins => before_minutes),
               sent_at = case when v_deadline - make_interval(mins => before_minutes) > now()
                              then null else sent_at end
         where task_id = p_task and before_minutes is not null;
      end if;
      if not v_boss then
        for v_creator in select user_id from public.task_members where task_id = p_task and role = 'creator' loop
          perform public.task_notify(p_task, v_creator, 'task.deadline', 'Исполнитель перенёс срок', r.uid, 'all');
        end loop;
      else
        perform public.task_notify(p_task, m.user_id, 'task.deadline', 'Срок задачи изменён', r.uid, 'all')
           from public.task_members m where m.task_id = p_task and m.role = 'assignee';
      end if;
      v_changed := true;
    end if;
  end if;
  if v_changed then
    perform public.task_touch(p_task, r.uid);
  end if;
  select * into t from public.tasks where id = p_task;
  return public.task_json(t, r.uid, true);
end;
$$;

-- Участники: исполнитель, соисполнители, наблюдатели — постановщик.
create or replace function public.task_set_members(p_task uuid, p_assignee uuid, p_coassignees uuid[],
                                                   p_watchers uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_before jsonb;
  v_after jsonb;
  v_added jsonb;
  v_removed jsonb;
  x record;
begin
  select * into r from public.task_require(p_task, 'boss');
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'role', role)), '[]') into v_before
    from public.task_members where task_id = p_task and role <> 'creator';
  delete from public.task_members where task_id = p_task and role <> 'creator';
  perform public.task_put_members(p_task, r.uid, p_assignee, p_coassignees, p_watchers);
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'role', role)), '[]') into v_after
    from public.task_members where task_id = p_task and role <> 'creator';
  select coalesce(jsonb_agg(e), '[]') into v_added
    from jsonb_array_elements(v_after) e where not v_before @> jsonb_build_array(e);
  select coalesce(jsonb_agg(e), '[]') into v_removed
    from jsonb_array_elements(v_before) e where not v_after @> jsonb_build_array(e);
  if v_added = '[]'::jsonb and v_removed = '[]'::jsonb then
    return;
  end if;
  perform public.task_event(p_task, r.uid, 'members',
    jsonb_build_object('added', v_added, 'removed', v_removed));
  for x in select (e->>'user_id')::uuid as u, e->>'role' as role from jsonb_array_elements(v_added) e loop
    if x.role in ('assignee', 'coassignee') then
      perform public.task_notify(p_task, x.u, 'task.assigned',
        case x.role when 'assignee' then 'Вам поставили задачу' else 'Вы соисполнитель задачи' end,
        r.uid, 'mine');
    end if;
  end loop;
  perform public.task_chat_sync(p_task);
  perform public.task_touch(p_task, r.uid);
  perform public.task_broadcast(p_task,
    array(select (e->>'user_id')::uuid from jsonb_array_elements(v_removed) e));
end;
$$;

-- Делегировать: новый исполнитель, прежний — наблюдатель (постановщик
-- остаётся постановщиком).
create or replace function public.task_delegate(p_task uuid, p_user uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_old uuid;
begin
  select * into r from public.task_require(p_task, 'view');
  if not r.roles && array['creator', 'manager', 'assignee'] then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if p_user is null or not public.is_portal_user(p_user) then
    raise exception 'task_bad_assignee' using errcode = '22023';
  end if;
  select user_id into v_old from public.task_members where task_id = p_task and role = 'assignee';
  if v_old = p_user then
    return;
  end if;
  delete from public.task_members where task_id = p_task and role = 'assignee';
  delete from public.task_members where task_id = p_task and user_id = p_user and role <> 'creator';
  insert into public.task_members (task_id, user_id, role, added_by) values (p_task, p_user, 'assignee', r.uid);
  if v_old is not null and not exists (select 1 from public.task_members
                                         where task_id = p_task and user_id = v_old) then
    insert into public.task_members (task_id, user_id, role, added_by) values (p_task, v_old, 'watcher', r.uid);
  end if;
  perform public.task_event(p_task, r.uid, 'delegated', jsonb_build_object('from', v_old, 'to', p_user), p_reason);
  perform public.task_notify(p_task, p_user, 'task.assigned', 'Вам передали задачу', r.uid, 'mine');
  perform public.task_chat_sync(p_task);
  perform public.task_touch(p_task, r.uid);
end;
$$;

-- Наблюдать за задачей самому (или перестать).
create or replace function public.task_watch(p_task uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select * into r from public.task_require(p_task, 'view');
  if p_on then
    if not r.roles && array['assignee', 'coassignee', 'watcher'] then
      insert into public.task_members (task_id, user_id, role, added_by) values (p_task, r.uid, 'watcher', r.uid);
    end if;
  else
    delete from public.task_members where task_id = p_task and user_id = r.uid and role = 'watcher';
  end if;
  perform public.task_chat_sync(p_task);
  perform public.task_broadcast(p_task, array[r.uid]);
end;
$$;

-- Статус. Действия: start, defer, complete (при «Требует проверки» у
-- исполнителя — на проверку), accept, return (с комментарием), cancel,
-- reopen.
create or replace function public.task_set_status(p_task uuid, p_action text, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  t public.tasks;
  v_boss boolean;
  v_worker boolean;
  v_to text;
  v_who uuid;
begin
  select * into r from public.task_require(p_task, 'view');
  select * into t from public.tasks where id = p_task for update;
  v_boss := r.roles && array['creator', 'manager'];
  v_worker := v_boss or r.roles && array['assignee', 'coassignee'];

  if p_action = 'start' and v_worker and t.status in ('new', 'deferred') then
    v_to := 'in_progress';
  elsif p_action = 'defer' and v_worker and t.status in ('new', 'in_progress') then
    v_to := 'deferred';
  elsif p_action = 'complete' and (v_boss or 'assignee' = any (r.roles))
        and t.status in ('new', 'in_progress', 'deferred') then
    v_to := case when t.requires_review and not v_boss then 'review' else 'done' end;
  elsif p_action = 'accept' and v_boss and t.status = 'review' then
    v_to := 'done';
  elsif p_action = 'return' and v_boss and t.status in ('review', 'done') then
    if t.status = 'review' and coalesce(btrim(p_comment), '') = '' then
      raise exception 'task_comment_required' using errcode = '22023';
    end if;
    v_to := 'in_progress';
  elsif p_action = 'cancel' and v_boss and t.status not in ('done', 'cancelled') then
    v_to := 'cancelled';
  elsif p_action = 'reopen' and (v_boss or 'assignee' = any (r.roles)) and t.status in ('done', 'cancelled') then
    v_to := 'in_progress';
  else
    raise exception 'task_status_forbidden' using errcode = '42501';
  end if;

  update public.tasks
     set status = v_to,
         completed_at = case when v_to in ('done', 'cancelled') then now() end
   where id = p_task;
  perform public.task_event(p_task, r.uid, 'status',
    jsonb_build_object('from', t.status, 'to', v_to, 'action', p_action), p_comment);

  if v_to = 'review' then
    for v_who in select user_id from public.task_members where task_id = p_task and role = 'creator' loop
      perform public.task_notify(p_task, v_who, 'task.review', 'Задача ждёт проверки', r.uid, 'mine');
    end loop;
  elsif v_to = 'done' and p_action = 'accept' then
    for v_who in select user_id from public.task_members where task_id = p_task and role = 'assignee' loop
      perform public.task_notify(p_task, v_who, 'task.accepted', 'Задача принята', r.uid, 'all');
    end loop;
  elsif v_to = 'done' and t.batch_id is null then
    for v_who in select user_id from public.task_members where task_id = p_task and role = 'creator' loop
      perform public.task_notify(p_task, v_who, 'task.done', 'Задача завершена', r.uid, 'all');
    end loop;
  elsif p_action = 'return' then
    for v_who in select user_id from public.task_members where task_id = p_task and role = 'assignee' loop
      perform public.task_notify(p_task, v_who, 'task.returned', 'Задачу вернули на доработку', r.uid, 'mine');
    end loop;
  end if;

  if t.chat_id is not null then
    perform public.chat_system_message(t.chat_id, r.uid,
      jsonb_build_object('type', 'task_status', 'title', v_to));
    perform public.chat_broadcast(t.chat_id, jsonb_build_object('type', 'message'));
  end if;
  perform public.task_touch(p_task, r.uid);
  select * into t from public.tasks where id = p_task;
  return public.task_json(t, r.uid, true);
end;
$$;

create or replace function public.task_set_notify(p_task uuid, p_level text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select * into r from public.task_require(p_task, 'view');
  if p_level not in ('all', 'mine', 'none') then
    raise exception 'task_bad_notify' using errcode = '22023';
  end if;
  insert into public.task_user_state (task_id, user_id, notify, seen_at) values (p_task, r.uid, p_level, now())
  on conflict (task_id, user_id) do update set notify = excluded.notify;
end;
$$;

-- 11. Чек-листы ----------------------------------------------------------------

create or replace function public.task_checklist_save(p_task uuid, p_id uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_id uuid := p_id;
  v_task uuid := p_task;
  v_title text := btrim(coalesce(p_title, ''));
begin
  -- Переименование — задача берётся из самого чек-листа.
  if v_id is not null then
    select task_id into v_task from public.task_checklists where id = v_id;
    if v_task is null then
      raise exception 'task_not_found' using errcode = '42501';
    end if;
  end if;
  select * into r from public.task_require(v_task, 'worker');
  if char_length(v_title) not between 1 and 200 then
    raise exception 'task_title_invalid' using errcode = '22023';
  end if;
  if v_id is null then
    if (select count(*) from public.task_checklists where task_id = v_task) >= 20 then
      raise exception 'task_too_many_checklists' using errcode = '22023';
    end if;
    insert into public.task_checklists (task_id, title, sort_order)
    values (v_task, v_title,
            coalesce((select max(sort_order) + 1 from public.task_checklists where task_id = v_task), 1))
    returning id into v_id;
  else
    update public.task_checklists set title = v_title where id = v_id;
  end if;
  perform public.task_broadcast(v_task);
  return v_id;
end;
$$;

create or replace function public.task_checklist_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task uuid;
begin
  select task_id into v_task from public.task_checklists where id = p_id;
  if v_task is null then
    return;
  end if;
  perform public.task_require(v_task, 'worker');
  delete from public.task_checklists where id = p_id;
  perform public.task_broadcast(v_task);
end;
$$;

-- Пункт: новый (p_id null) или правка текста и исполнителя. Исполнитель
-- пункта не в задаче — становится соисполнителем.
create or replace function public.task_check_item_save(p_checklist uuid, p_id uuid, p_text text,
                                                       p_assignee uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_task uuid;
  v_id uuid := p_id;
  v_text text := btrim(coalesce(p_text, ''));
  v_prev uuid;
begin
  select task_id into v_task from public.task_checklists where id = p_checklist;
  if v_task is null then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  select * into r from public.task_require(v_task, 'worker');
  if char_length(v_text) not between 1 and 1000 then
    raise exception 'task_item_invalid' using errcode = '22023';
  end if;
  if p_assignee is not null and not public.is_portal_user(p_assignee) then
    raise exception 'task_bad_assignee' using errcode = '22023';
  end if;
  if v_id is null then
    if (select count(*) from public.task_checklist_items where checklist_id = p_checklist) >= 200 then
      raise exception 'task_too_many_items' using errcode = '22023';
    end if;
    insert into public.task_checklist_items (checklist_id, task_id, text, sort_order, assignee_id)
    values (p_checklist, v_task, v_text,
            coalesce((select max(sort_order) + 1 from public.task_checklist_items
                       where checklist_id = p_checklist), 1), p_assignee)
    returning id into v_id;
  else
    select assignee_id into v_prev from public.task_checklist_items where id = v_id and checklist_id = p_checklist;
    update public.task_checklist_items set text = v_text, assignee_id = p_assignee
     where id = v_id and checklist_id = p_checklist;
  end if;
  if p_assignee is not null and p_assignee is distinct from v_prev then
    if not exists (select 1 from public.task_members
                    where task_id = v_task and user_id = p_assignee and role <> 'creator') then
      delete from public.task_members where task_id = v_task and user_id = p_assignee and role = 'watcher';
      insert into public.task_members (task_id, user_id, role, added_by)
      values (v_task, p_assignee, 'coassignee', r.uid) on conflict do nothing;
      perform public.task_event(v_task, r.uid, 'members',
        jsonb_build_object('added', jsonb_build_array(jsonb_build_object('user_id', p_assignee, 'role', 'coassignee')),
                           'removed', '[]'::jsonb));
      perform public.task_chat_sync(v_task);
    end if;
    perform public.task_notify(v_task, p_assignee, 'task.assigned', 'Вам пункт чек-листа: ' || left(v_text, 100),
                               r.uid, 'mine');
  end if;
  perform public.task_broadcast(v_task);
  return v_id;
end;
$$;

-- Отметить пункт: работники задачи и исполнитель пункта.
create or replace function public.task_check_item_toggle(p_id uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.task_checklist_items;
  v_uid uuid := public.chat_require_portal();
  v_roles text[];
begin
  select * into i from public.task_checklist_items where id = p_id for update;
  if not found then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  v_roles := public.task_roles(i.task_id, v_uid);
  if not (v_roles && array['creator', 'manager', 'assignee', 'coassignee'] or i.assignee_id = v_uid) then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if p_done and i.done_at is null then
    update public.task_checklist_items set done_at = now(), done_by = v_uid where id = p_id;
  elsif not p_done and i.done_at is not null then
    update public.task_checklist_items set done_at = null, done_by = null where id = p_id;
  else
    return;
  end if;
  perform public.task_event(i.task_id, v_uid, 'check',
    jsonb_build_object('item', p_id, 'text', left(i.text, 200), 'done', p_done));
  update public.tasks set updated_at = now() where id = i.task_id;
  perform public.task_broadcast(i.task_id);
end;
$$;

create or replace function public.task_check_item_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task uuid;
begin
  select task_id into v_task from public.task_checklist_items where id = p_id;
  if v_task is null then
    return;
  end if;
  perform public.task_require(v_task, 'worker');
  delete from public.task_checklist_items where id = p_id;
  perform public.task_broadcast(v_task);
end;
$$;

-- Порядок пунктов списка (можно перенести пункт и в другой список задачи).
create or replace function public.task_check_reorder(p_checklist uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task uuid;
begin
  select task_id into v_task from public.task_checklists where id = p_checklist;
  if v_task is null then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  perform public.task_require(v_task, 'worker');
  update public.task_checklist_items i
     set checklist_id = p_checklist, sort_order = o.n
    from unnest(p_ids) with ordinality as o(id, n)
   where i.id = o.id and i.task_id = v_task;
  perform public.task_broadcast(v_task);
end;
$$;

-- 12. Файлы ------------------------------------------------------------------------

create or replace function public.task_file_add(p_task uuid, p_files jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer;
begin
  select * into r from public.task_require(p_task, 'worker');
  if (select count(*) from public.task_files where task_id = p_task) + jsonb_array_length(
       case when jsonb_typeof(p_files) = 'array' then p_files else '[]' end) > 200 then
    raise exception 'task_too_many_files' using errcode = '22023';
  end if;
  n := public.task_put_files(p_task, r.uid, p_files);
  if n > 0 then
    perform public.task_event(p_task, r.uid, 'files',
      jsonb_build_object('added', (select jsonb_agg(f->>'name') from jsonb_array_elements(p_files) f)));
    perform public.task_touch(p_task, r.uid);
  end if;
end;
$$;

-- Убрать файл: кто загрузил или постановщик. Сам файл стирать не нужно
-- сразу: его могут держать другие задачи той же постановки.
create or replace function public.task_file_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.task_files;
  r record;
begin
  select * into f from public.task_files where id = p_id;
  if not found then
    return;
  end if;
  select * into r from public.task_require(f.task_id, 'worker');
  if f.uploaded_by is distinct from r.uid and not r.roles && array['creator', 'manager'] then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  delete from public.task_files where id = p_id;
  perform public.task_event(f.task_id, r.uid, 'files', jsonb_build_object('removed', jsonb_build_array(f.name)));
  perform public.task_broadcast(f.task_id);
end;
$$;

-- Бакет task-files: папка — задача (видят её участники) или `new/<человек>/`
-- (файлы постановки до создания задачи); файл, записанный в задачи одной
-- постановки, читают участники любой из них.
create or replace function public.task_file_allowed(p_name text, p_write boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    return false;
  end if;
  if v_folder = 'new' then
    return split_part(p_name, '/', 2) = v_uid::text
        or (not p_write and exists (
              select 1 from public.task_files f
               where f.path = p_name and cardinality(public.task_roles(f.task_id, v_uid)) > 0));
  end if;
  if v_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if p_write then
    return public.task_roles(v_folder::uuid, v_uid) && array['creator', 'manager', 'assignee', 'coassignee'];
  end if;
  return cardinality(public.task_roles(v_folder::uuid, v_uid)) > 0;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-files', 'task-files', false, 209715200)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "task-files read" on storage.objects;
create policy "task-files read" on storage.objects
  for select to authenticated
  using (bucket_id = 'task-files' and public.task_file_allowed(name));

drop policy if exists "task-files insert" on storage.objects;
create policy "task-files insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'task-files' and public.task_file_allowed(name, true));

-- Картинки и файлы в описании задачи — бакет kb-media, папка
-- `tasks/<задача>/` (редактор базы знаний): читают участники, пишут —
-- постановщик (описание правит он).
create or replace function public.task_media_allowed(p_name text, p_write boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_task text := split_part(coalesce(p_name, ''), '/', 2);
begin
  if v_uid is null or split_part(coalesce(p_name, ''), '/', 1) <> 'tasks'
     or v_task !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if p_write then
    return public.task_roles(v_task::uuid, v_uid) && array['creator', 'manager'];
  end if;
  return cardinality(public.task_roles(v_task::uuid, v_uid)) > 0;
end;
$$;

drop policy if exists "tasks kb-media read" on storage.objects;
create policy "tasks kb-media read" on storage.objects
  for select to authenticated
  using (bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'tasks'
         and public.task_media_allowed(name));

drop policy if exists "tasks kb-media insert" on storage.objects;
create policy "tasks kb-media insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'tasks'
              and public.task_media_allowed(name, true));

-- Файлы kb-media без ссылок — с учётом описаний задач. Прежнее определение
-- — 2026-10-25_zzzzzzz_academy.sql; актуальное — здесь.
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
revoke all on function public.kb_file_gc_candidates(integer, integer) from public, anon, authenticated;
grant execute on function public.kb_file_gc_candidates(integer, integer) to service_role;

-- 13. Обсуждение — чат задачи ------------------------------------------------------

create or replace function public.task_chat_open(p_task uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  t public.tasks;
  v_chat uuid;
begin
  select * into t from public.tasks where id = p_task for update;
  if not found or not exists (select 1 from public.task_members where task_id = p_task and user_id = v_uid) then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if t.chat_id is not null then
    return t.chat_id;
  end if;
  insert into public.chat_chats (kind, title, created_by, settings)
  values ('task', left('#' || t.number || ' ' || t.title, 100), v_uid,
          jsonb_build_object('pin', 'all', 'post', 'all', 'add', 'admins',
                             'task_id', t.id, 'task_number', t.number))
  returning id into v_chat;
  update public.tasks set chat_id = v_chat where id = p_task;
  perform public.task_chat_sync(p_task);
  perform public.chat_system_message(v_chat, v_uid, jsonb_build_object('type', 'task_chat'));
  perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'chat'));
  perform public.task_broadcast(p_task);
  return v_chat;
end;
$$;

-- 14. Напоминания и фильтры ----------------------------------------------------------

create or replace function public.task_reminder_set(p_task uuid, p_remind_at timestamptz,
                                                    p_before_minutes integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select * into r from public.task_require(p_task, 'view');
  perform public.task_put_reminder(p_task, r.uid, p_remind_at, p_before_minutes);
end;
$$;

create or replace function public.task_reminder_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.task_reminders where id = p_id and user_id = auth.uid()
$$;

create or replace function public.task_filters_list()
returns table (id uuid, name text, params jsonb, sort_order integer)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name, f.params, f.sort_order from public.task_saved_filters f
   where f.user_id = auth.uid() order by f.sort_order, f.created_at
$$;

create or replace function public.task_filter_save(p_id uuid, p_name text, p_params jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid := p_id;
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 or jsonb_typeof(p_params) <> 'object' then
    raise exception 'task_filter_invalid' using errcode = '22023';
  end if;
  if v_id is null then
    if (select count(*) from public.task_saved_filters where user_id = v_uid) >= 30 then
      raise exception 'task_too_many_filters' using errcode = '22023';
    end if;
    insert into public.task_saved_filters (user_id, name, params, sort_order)
    values (v_uid, btrim(p_name), p_params,
            coalesce((select max(sort_order) + 1 from public.task_saved_filters where user_id = v_uid), 1))
    returning id into v_id;
  else
    update public.task_saved_filters set name = btrim(p_name), params = p_params
     where id = v_id and user_id = v_uid;
  end if;
  return v_id;
end;
$$;

create or replace function public.task_filter_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.task_saved_filters where id = p_id and user_id = auth.uid()
$$;

-- 15. Производственный календарь ------------------------------------------------------

-- Дни года строкой isdayoff.ru (getdata?year=…&pre=1): 0 — рабочий, 1 —
-- выходной, 2 — сокращённый, 4 — рабочий (особый). Только сервер.
create or replace function public.work_calendar_store(p_year integer, p_days text, p_source text default 'isdayoff.ru')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := make_date(p_year, 1, 1);
  v_len integer := (make_date(p_year + 1, 1, 1) - make_date(p_year, 1, 1));
begin
  if p_days is null or char_length(p_days) <> v_len or p_days !~ '^[0124]+$' then
    raise exception 'work_calendar_invalid' using errcode = '22023';
  end if;
  insert into public.work_calendar (day, kind, updated_at)
  select v_start + (i - 1),
         case substr(p_days, i, 1) when '1' then 'off' when '2' then 'short' else 'work' end,
         now()
    from generate_series(1, v_len) i
  on conflict (day) do update set kind = excluded.kind, updated_at = now();
  insert into public.work_calendar_years (year, source) values (p_year, left(p_source, 100))
  on conflict (year) do update set source = excluded.source, loaded_at = now();
  return v_len;
end;
$$;

create or replace function public.work_calendar_years_loaded()
returns integer[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(year order by year), '{}') from public.work_calendar_years
$$;

-- Дни календаря за период (портал дополняет: нет дня — сб и вс выходные).
create or replace function public.work_calendar_range(p_from date, p_to date)
returns table (day date, kind text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.chat_require_portal();
  if p_to - p_from > 800 then
    raise exception 'work_calendar_range_too_long' using errcode = '22023';
  end if;
  return query select w.day, w.kind from public.work_calendar w
                where w.day between p_from and p_to order by w.day;
end;
$$;

-- 16. Фоновый проход (сервер портала раз в минуту) -------------------------------------

create or replace function public.task_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_soon integer := 0;
  v_overdue integer := 0;
  v_reminders integer := 0;
  v_digests integer := 0;
  v_local timestamp;
begin
  -- Срок через час — исполнителю (если задачу ставили не впритык).
  for r in
    update public.tasks t set soon_notified_at = p_now
     where t.id in (select id from public.tasks
                     where status in ('new', 'in_progress') and soon_notified_at is null
                       and deadline > p_now and deadline <= p_now + interval '1 hour'
                       and created_at < deadline - interval '1 hour'
                     limit 500)
    returning t.id
  loop
    perform public.task_notify(r.id, m.user_id, 'task.soon', 'Срок задачи через час', null, 'mine')
       from public.task_members m where m.task_id = r.id and m.role = 'assignee';
    v_soon := v_soon + 1;
  end loop;

  -- Просрочена — один раз, исполнителю.
  for r in
    update public.tasks t set overdue_notified_at = p_now
     where t.id in (select id from public.tasks
                     where status not in ('done', 'cancelled') and overdue_notified_at is null
                       and deadline <= p_now
                     limit 500)
    returning t.id, t.status
  loop
    if r.status in ('new', 'in_progress', 'deferred') then
      perform public.task_notify(r.id, m.user_id, 'task.overdue', 'Задача просрочена', null, 'mine')
         from public.task_members m where m.task_id = r.id and m.role = 'assignee';
      perform public.task_broadcast(r.id);
      v_overdue := v_overdue + 1;
    end if;
  end loop;

  -- Свои напоминания.
  for r in
    update public.task_reminders rm set sent_at = p_now
     where rm.id in (select id from public.task_reminders
                      where sent_at is null and remind_at <= p_now limit 500)
    returning rm.task_id, rm.user_id
  loop
    if exists (select 1 from public.tasks where id = r.task_id and status not in ('done', 'cancelled'))
       and cardinality(public.task_roles(r.task_id, r.user_id)) > 0 then
      perform public.task_notify(r.task_id, r.user_id, 'task.reminder', 'Напоминание о задаче', null, 'mine');
      v_reminders := v_reminders + 1;
    end if;
  end loop;

  -- Сводка постановщику: просроченное у исполнителей, раз в день с 9:00 его
  -- времени.
  for r in
    select m.user_id, count(*) as n,
           coalesce(max(s.timezone), 'Europe/Moscow') as tz
      from public.task_members m
      join public.tasks t on t.id = m.task_id
      left join public.portal_user_settings s on s.user_id = m.user_id
      left join public.task_user_state st on st.task_id = t.id and st.user_id = m.user_id
     where m.role = 'creator'
       and t.status in ('new', 'in_progress', 'deferred') and t.deadline < p_now
       and coalesce(st.notify, 'all') = 'all'
       and not exists (select 1 from public.task_members a
                        where a.task_id = t.id and a.role = 'assignee' and a.user_id = m.user_id)
     group by m.user_id
  loop
    v_local := p_now at time zone r.tz;
    continue when extract(hour from v_local) < 9;
    continue when exists (select 1 from public.task_digest_log
                           where user_id = r.user_id and day = v_local::date);
    insert into public.task_digest_log (user_id, day) values (r.user_id, v_local::date);
    perform public.notif_send(r.user_id, 'task.digest', 'Просроченные задачи у исполнителей',
      r.n || ' ' || case when r.n % 10 = 1 and r.n % 100 <> 11 then 'задача просрочена'
                         when r.n % 10 between 2 and 4 and r.n % 100 not between 12 and 14
                              then 'задачи просрочены'
                         else 'задач просрочено' end,
      '/tasks?role=assigned&deadline=overdue', null, 'taskdigest');
    v_digests := v_digests + 1;
  end loop;
  delete from public.task_digest_log where day < (p_now - interval '30 days')::date;

  return jsonb_build_object('soon', v_soon, 'overdue', v_overdue, 'reminders', v_reminders,
                            'digests', v_digests);
end;
$$;

-- 17. Права на функции ------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.task_led_user_ids(uuid)',
    'public.task_is_manager(uuid, uuid)',
    'public.task_roles(uuid, uuid)',
    'public.task_require(uuid, text)',
    'public.task_event(uuid, uuid, text, jsonb, text)',
    'public.task_broadcast(uuid, uuid[])',
    'public.task_touch(uuid, uuid)',
    'public.task_notify(uuid, uuid, text, text, uuid, text)',
    'public.task_chat_sync(uuid)',
    'public.task_json(public.tasks, uuid, boolean)',
    'public.task_put_members(uuid, uuid, uuid, uuid[], uuid[])',
    'public.task_put_checklists(uuid, uuid, jsonb)',
    'public.task_put_files(uuid, uuid, jsonb)',
    'public.task_put_reminder(uuid, uuid, timestamptz, integer)',
    'public.work_calendar_store(integer, text, text)',
    'public.work_calendar_years_loaded()',
    'public.task_tick(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.task_list(jsonb)',
    'public.task_get(bigint)',
    'public.task_history(uuid)',
    'public.task_counters()',
    'public.task_create(jsonb)',
    'public.task_update(uuid, jsonb, text)',
    'public.task_set_members(uuid, uuid, uuid[], uuid[])',
    'public.task_delegate(uuid, uuid, text)',
    'public.task_watch(uuid, boolean)',
    'public.task_set_status(uuid, text, text)',
    'public.task_set_notify(uuid, text)',
    'public.task_checklist_save(uuid, uuid, text)',
    'public.task_checklist_delete(uuid)',
    'public.task_check_item_save(uuid, uuid, text, uuid)',
    'public.task_check_item_toggle(uuid, boolean)',
    'public.task_check_item_delete(uuid)',
    'public.task_check_reorder(uuid, uuid[])',
    'public.task_file_add(uuid, jsonb)',
    'public.task_file_delete(uuid)',
    'public.task_file_allowed(text, boolean)',
    'public.task_media_allowed(text, boolean)',
    'public.task_chat_open(uuid)',
    'public.task_reminder_set(uuid, timestamptz, integer)',
    'public.task_reminder_delete(uuid)',
    'public.task_filters_list()',
    'public.task_filter_save(uuid, text, jsonb)',
    'public.task_filter_delete(uuid)',
    'public.work_calendar_range(date, date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
