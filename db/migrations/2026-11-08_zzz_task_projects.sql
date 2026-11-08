-- ============================================================================
-- Задачи, веха 4 (TASKS_CHATS_PLAN.md, 4.9–4.11, 2026-11-08): проекты,
-- «Подчинённые», шаблоны, регулярные задачи.
--
-- Проект — `task_projects`: пространство отдела, города или проекта
-- (название, цвет, вид), закрытый (по умолчанию) или открытый (виден в
-- каталоге, вступает любой), своё правило срока (free / reason / forbid) и
-- «Требует проверки» по умолчанию для новых задач, стадии канбана
-- `task_stages` (новый проект — «Новые», «В работе», «Готово»; стадия не
-- меняет статус), чат проекта (`chat_chats.kind = 'project'`, папка
-- «Проекты»; участники — участники проекта). Участники
-- `task_project_members`: владелец / модератор / участник, вручную или из
-- подразделения оргструктуры (`unit_id`: все или руководители, с
-- подразделениями ниже или без) — состав из подразделения пересчитывается
-- при изменении оргструктуры. Создаёт проект любой человек портала (решение
-- по умолчанию; веха 4 — без отдельного права), он — владелец.
--
-- Задачи проекта (`tasks.project_id`, `stage_id`) видят все участники
-- проекта (роль «project» в `task_roles`), владелец и модераторы правят их
-- как постановщик (роль «manager»). Срок исполнитель меняет по правилу
-- проекта (`task_deadline_rule_of`).
--
-- «Подчинённые» — `task_subordinates`: руководителю и заместителю — люди его
-- подразделений и ниже с числом задач в работе, просроченных, на проверке,
-- закрытых за неделю; их задачи — `task_list` с `scope = 'team'`.
--
-- Шаблоны `task_templates`: личные, проекта (правят владелец и модераторы),
-- общие (правит «Администратор задач»); в шаблоне — поля новой задачи и срок
-- «через N рабочих дней». Регулярные `task_recurrences`: шаблон +
-- расписание (каждый день, по рабочим дням, по дням недели, по числу
-- месяца, через N дней после закрытия), время в поясе человека; задачи не
-- копятся: пока прежняя открыта — следующая ждёт (mode = wait) или прежняя
-- закрывается как пропущенная (mode = skip). Создаёт `task_tick`
-- (актуальное определение — здесь) через `task_recurrence_tick`.
--
-- Актуальные определения `task_is_manager`, `task_roles`, `task_json`,
-- `task_list`, `task_counters`, `task_create`, `task_update`, `task_tick`,
-- `chat_notify_message` — здесь. Все таблицы закрыты браузеру. Идемпотентно.
-- ============================================================================

-- 1. Таблицы -----------------------------------------------------------------

create table if not exists public.task_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  color text check (color is null or color ~ '^#[0-9a-f]{6}$'),
  kind text not null default 'project' check (kind in ('department', 'city', 'project')),
  visibility text not null default 'closed' check (visibility in ('closed', 'open')),
  deadline_rule text not null default 'reason' check (deadline_rule in ('free', 'reason', 'forbid')),
  requires_review boolean not null default false,
  unit_id uuid references public.org_units (id) on delete set null,
  unit_scope text not null default 'all' check (unit_scope in ('all', 'heads')),
  with_subunits boolean not null default true,
  chat_id uuid references public.chat_chats (id) on delete set null,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_project_members (
  project_id uuid not null references public.task_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'moderator', 'member')),
  source text not null default 'manual' check (source in ('manual', 'unit')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists task_project_members_user_idx on public.task_project_members (user_id);

create table if not exists public.task_stages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.task_projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_stages_project_idx on public.task_stages (project_id, sort_order);

alter table public.tasks add column if not exists project_id uuid
  references public.task_projects (id) on delete set null;
alter table public.tasks add column if not exists stage_id uuid
  references public.task_stages (id) on delete set null;
alter table public.tasks add column if not exists recurrence_id uuid;
create index if not exists tasks_project_idx on public.tasks (project_id) where project_id is not null;

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  scope text not null default 'personal' check (scope in ('personal', 'project', 'shared')),
  project_id uuid references public.task_projects (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- Поля новой задачи: title, description (документ), assignees, mode,
  -- coassignees, watchers, checklists, urgent, requires_review,
  -- deadline_days (рабочих дней), deadline_time ('HH:MM').
  task jsonb not null default '{}'::jsonb check (jsonb_typeof(task) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_templates_project_check check ((scope = 'project') = (project_id is not null))
);
create index if not exists task_templates_owner_idx on public.task_templates (owner_id);

create table if not exists public.task_recurrences (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.task_templates (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- {freq: daily | workdays | weekly | monthly | after_close, weekdays: [1..7],
  --  monthday: 1..31, after_days: 0..365}
  rule jsonb not null check (jsonb_typeof(rule) = 'object'),
  at_time time not null default '09:00',
  tz text not null default 'Europe/Moscow',
  mode text not null default 'wait' check (mode in ('wait', 'skip')),
  active boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_task_id uuid references public.tasks (id) on delete set null,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists task_recurrences_due_idx on public.task_recurrences (next_run_at) where active;

do $$
declare
  t text;
begin
  foreach t in array array['task_projects', 'task_project_members', 'task_stages',
    'task_templates', 'task_recurrences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- 2. Чат проекта ---------------------------------------------------------------

alter table public.chat_chats drop constraint if exists chat_chats_kind_check;
alter table public.chat_chats add constraint chat_chats_kind_check
  check (kind in ('direct', 'group', 'self', 'task', 'project'));

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
      if c.kind = 'direct' then
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

-- 3. Доступ --------------------------------------------------------------------

-- Роль человека в проекте (null — не участник).
create or replace function public.task_project_role(p_project uuid, p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.task_project_members where project_id = p_project and user_id = p_uid
$$;

-- Ведёт проект: владелец, модератор или «Администратор задач».
create or replace function public.task_project_manages(p_project uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(p_uid, 'tasks.admin')
      or coalesce(public.task_project_role(p_project, p_uid) in ('owner', 'moderator'), false)
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
      or exists (select 1 from public.tasks t
                  join public.task_project_members pm on pm.project_id = t.project_id
                 where t.id = p_task and pm.user_id = p_uid and pm.role in ('owner', 'moderator'))
$$;

-- Роли: + «project» — участник проекта задачи (видит её).
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
      || case when p_uid is not null and exists (
                select 1 from public.tasks t
                  join public.task_project_members pm on pm.project_id = t.project_id
                 where t.id = p_task and pm.user_id = p_uid)
              then array['project'] else '{}'::text[] end
$$;

-- Правило срока задачи: проекта, без проекта — портала.
create or replace function public.task_deadline_rule_of(p_task uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.deadline_rule from public.tasks t
                     join public.task_projects p on p.id = t.project_id
                    where t.id = p_task), public.task_deadline_rule())
$$;

create or replace function public.task_project_brief(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', p.id, 'title', p.title, 'color', p.color)
    from public.task_projects p where p.id = p_project
$$;

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
    'project_id', t.project_id, 'stage_id', t.stage_id, 'recurrence_id', t.recurrence_id,
    'project', case when t.project_id is not null then public.task_project_brief(t.project_id) end,
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
      'deadline_rule', public.task_deadline_rule_of(t.id),
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

-- Список: + project (задачи проекта — его участникам), scope = 'team'
-- (задачи людей подразделений руководителя: исполнитель или соисполнитель).
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
  v_all boolean := coalesce(p0->>'scope', '') = 'all' and public.access_has_right(auth.uid(), 'tasks.admin');
  v_show_done boolean := coalesce((p0->>'show_done')::boolean, false);
  v_statuses text[] := case when jsonb_typeof(p0->'statuses') = 'array' and jsonb_array_length(p0->'statuses') > 0
                            then array(select jsonb_array_elements_text(p0->'statuses')) end;
  v_deadline text := nullif(p0->>'deadline', '');
  v_creator uuid := nullif(p0->>'creator', '')::uuid;
  v_assignee uuid := nullif(p0->>'assignee', '')::uuid;
  v_batch uuid := nullif(p0->>'batch', '')::uuid;
  v_project uuid := nullif(p0->>'project', '')::uuid;
  v_project_ok boolean := false;
  v_team boolean := coalesce(p0->>'scope', '') = 'team';
  v_led uuid[] := '{}';
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
  if v_project is not null then
    v_project_ok := public.task_project_role(v_project, v_uid) is not null
                    or public.access_has_right(v_uid, 'tasks.admin');
    if not v_project_ok then
      raise exception 'project_forbidden' using errcode = '42501';
    end if;
  end if;
  if v_team then
    v_led := array_remove(public.task_led_user_ids(v_uid), v_uid);
  end if;
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
    select mine.task_id, mine.roles from mine where not v_team and v_project is null
    union all
    select t.id, '{}'::text[] from public.tasks t
     where v_all and not v_team and v_project is null
       and not exists (select 1 from mine where mine.task_id = t.id)
    union all
    select t.id, coalesce((select mine.roles from mine where mine.task_id = t.id), '{}')
      from public.tasks t
     where v_project_ok and t.project_id = v_project
    union all
    select t.id, coalesce((select mine.roles from mine where mine.task_id = t.id), '{}')
      from public.tasks t
     where v_team and t.id in (select x.task_id from public.task_members x
                                where x.role in ('assignee', 'coassignee') and x.user_id = any (v_led))
  ),
  picked as (
    select t as task,
           row_number() over (
             order by (t.status in ('done', 'cancelled')),
                      case when t.status in ('done', 'cancelled') then t.completed_at end desc nulls last,
                      t.deadline asc nulls last, t.urgent desc, t.created_at desc, t.number desc) as rn
      from base join public.tasks t on t.id = base.task_id
     where (v_role = 'all' and (cardinality(base.roles) > 0 or v_all or v_project_ok or v_team)
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

-- Счётчики: + leader — руководитель или заместитель (пункт «Подчинённые»).
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
    'badge', count(*) filter (where overdue or review or unseen),
    'leader', exists (select 1 from public.org_unit_members u
                       where u.user_id = auth.uid() and u.member_role in ('head', 'deputy')))
    from flags
$$;

-- Постановка от имени человека (браузер — task_create, регулярные — сервер).
-- p: … + project_id (участник проекта), recurrence_id.
create or replace function public.task_create_as(p_uid uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := p_uid;
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
  v_project uuid := nullif(p->>'project_id', '')::uuid;
  v_stage uuid;
  v_review boolean := (p->>'requires_review')::boolean;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_project is not null then
    if public.task_project_role(v_project, v_uid) is null
       and not public.access_has_right(v_uid, 'tasks.admin') then
      raise exception 'project_forbidden' using errcode = '42501';
    end if;
    select id into v_stage from public.task_stages where project_id = v_project
     order by sort_order, created_at limit 1;
    if v_review is null then
      select requires_review into v_review from public.task_projects where id = v_project;
    end if;
  end if;
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
    insert into public.tasks (title, description, urgent, deadline, requires_review, created_by, batch_id,
                              project_id, stage_id, recurrence_id)
    values (v_title, v_desc, coalesce((p->>'urgent')::boolean, false), v_deadline,
            coalesce(v_review, false), v_uid, v_batch, v_project, v_stage,
            nullif(p->>'recurrence_id', '')::uuid)
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

create or replace function public.task_create(p jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.task_create_as(public.chat_require_portal(), p)
$$;

-- Правка: + project_id (постановщик; в проект, где он участник; стадия —
-- первая), правило срока — проекта.
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
  v_rule text := public.task_deadline_rule_of(p_task);
  v_project uuid;
  v_creator uuid;
  v_changed boolean := false;
begin
  select * into r from public.task_require(p_task, 'view');
  select * into t from public.tasks where id = p_task for update;
  v_boss := r.roles && array['creator', 'manager'];

  if (p ? 'title' or p ? 'description' or p ? 'urgent' or p ? 'requires_review' or p ? 'project_id')
     and not v_boss then
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
  if p ? 'project_id' then
    v_project := nullif(p->>'project_id', '')::uuid;
    if v_project is distinct from t.project_id then
      if v_project is not null and public.task_project_role(v_project, r.uid) is null
         and not public.access_has_right(r.uid, 'tasks.admin') then
        raise exception 'project_forbidden' using errcode = '42501';
      end if;
      update public.tasks
         set project_id = v_project,
             stage_id = (select s.id from public.task_stages s where s.project_id = v_project
                          order by s.sort_order, s.created_at limit 1)
       where id = p_task;
      perform public.task_event(p_task, r.uid, 'project',
        jsonb_build_object('from', public.task_project_brief(t.project_id),
                           'to', public.task_project_brief(v_project)));
      v_changed := true;
    end if;
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

-- 4. Проекты -----------------------------------------------------------------

-- Чат проекта: участники чата = участники проекта.
create or replace function public.task_project_chat_sync(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
  r record;
begin
  select chat_id into v_chat from public.task_projects where id = p_project;
  if v_chat is null then
    return;
  end if;
  insert into public.chat_members (chat_id, user_id, role)
  select v_chat, m.user_id, 'member' from public.task_project_members m where m.project_id = p_project
  on conflict (chat_id, user_id) do nothing;
  for r in
    select cm.user_id from public.chat_members cm
     where cm.chat_id = v_chat
       and not exists (select 1 from public.task_project_members m
                        where m.project_id = p_project and m.user_id = cm.user_id)
  loop
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'), array[r.user_id]);
    delete from public.chat_members where chat_id = v_chat and user_id = r.user_id;
  end loop;
  perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'members'));
end;
$$;

-- Люди подразделения проекта (все или руководители, с подразделениями ниже
-- или без); архивный проект и проект без подразделения — никого.
create or replace function public.task_project_unit_users(p_project uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct m.user_id
    from public.task_projects pr
    join public.org_units sub on sub.id = pr.unit_id or (pr.with_subunits and pr.unit_id = any (sub.path))
    join public.org_unit_members m on m.unit_id = sub.id
   where pr.id = p_project and pr.unit_id is not null and pr.archived_at is null
     and (pr.unit_scope = 'all' or m.member_role in ('head', 'deputy'))
     and public.is_portal_user(m.user_id)
$$;

-- Состав из подразделения: добавить недостающих, убрать ушедших (только
-- source = 'unit'; добавленных вручную не трогает).
create or replace function public.task_project_sync_unit(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.task_project_members (project_id, user_id, role, source)
  select p_project, u, 'member', 'unit' from public.task_project_unit_users(p_project) u
  on conflict (project_id, user_id) do nothing;
  delete from public.task_project_members m
   where m.project_id = p_project and m.source = 'unit'
     and m.user_id not in (select u from public.task_project_unit_users(p_project) u);
  perform public.task_project_chat_sync(p_project);
end;
$$;

-- Оргструктура изменилась — пересчитать проекты, привязанные к подразделениям.
create or replace function public.task_projects_units_resync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select id from public.task_projects where unit_id is not null and archived_at is null loop
    perform public.task_project_sync_unit(r.id);
  end loop;
  return null;
end;
$$;
drop trigger if exists task_projects_units_resync_aiud on public.org_unit_members;
create trigger task_projects_units_resync_aiud
  after insert or update or delete on public.org_unit_members
  for each statement execute function public.task_projects_units_resync();

create or replace function public.task_project_json(pr public.task_projects, p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', pr.id, 'title', pr.title, 'description', pr.description, 'color', pr.color,
    'kind', pr.kind, 'visibility', pr.visibility, 'deadline_rule', pr.deadline_rule,
    'requires_review', pr.requires_review, 'unit_id', pr.unit_id, 'unit_scope', pr.unit_scope,
    'with_subunits', pr.with_subunits, 'chat_id', pr.chat_id, 'archived_at', pr.archived_at,
    'created_at', pr.created_at,
    'my_role', public.task_project_role(pr.id, p_uid),
    'can_manage', public.task_project_manages(pr.id, p_uid),
    'member_count', (select count(*) from public.task_project_members m where m.project_id = pr.id),
    'open_count', (select count(*) from public.tasks t
                    where t.project_id = pr.id and t.status not in ('done', 'cancelled')),
    'overdue_count', (select count(*) from public.tasks t
                       where t.project_id = pr.id and t.status not in ('done', 'cancelled')
                         and t.deadline < now()))
$$;

-- Мои проекты и открытые, куда можно вступить («Администратор задач» — все).
create or replace function public.task_projects_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_admin boolean := public.access_has_right(v_uid, 'tasks.admin');
begin
  return coalesce((
    select jsonb_agg(public.task_project_json(pr, v_uid)
                     order by pr.archived_at nulls first, lower(pr.title))
      from public.task_projects pr
     where v_admin or pr.visibility = 'open'
        or exists (select 1 from public.task_project_members m
                    where m.project_id = pr.id and m.user_id = v_uid)), '[]');
end;
$$;

create or replace function public.task_project_get(p_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  pr public.task_projects;
begin
  select * into pr from public.task_projects where id = p_project;
  if not found or not (pr.visibility = 'open' or public.task_project_role(p_project, v_uid) is not null
                       or public.access_has_right(v_uid, 'tasks.admin')) then
    raise exception 'project_not_found' using errcode = '42501';
  end if;
  return public.task_project_json(pr, v_uid) || jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
                                                             'source', m.source)
                                          order by case m.role when 'owner' then 0 when 'moderator' then 1 else 2 end,
                                                   m.added_at)
                           from public.task_project_members m where m.project_id = p_project), '[]'),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title)
                                         order by s.sort_order, s.created_at)
                          from public.task_stages s where s.project_id = p_project), '[]'));
end;
$$;

-- Новый проект (p_id null; любой человек портала — владелец) или настройки
-- (владелец, модератор). p: title, description, color, kind, visibility,
-- deadline_rule, requires_review, unit_id, unit_scope, with_subunits,
-- members [] (при создании — участники).
create or replace function public.task_project_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid := p_id;
  v_title text := btrim(coalesce(p->>'title', ''));
  v_chat uuid;
  i integer := 0;
  s text;
begin
  if char_length(v_title) not between 1 and 120 then
    raise exception 'project_title_invalid' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.task_projects (title, description, color, kind, visibility, deadline_rule,
                                      requires_review, unit_id, unit_scope, with_subunits, created_by)
    values (v_title, nullif(btrim(coalesce(p->>'description', '')), ''), nullif(p->>'color', ''),
            coalesce(nullif(p->>'kind', ''), 'project'), coalesce(nullif(p->>'visibility', ''), 'closed'),
            coalesce(nullif(p->>'deadline_rule', ''), 'reason'),
            coalesce((p->>'requires_review')::boolean, false), nullif(p->>'unit_id', '')::uuid,
            coalesce(nullif(p->>'unit_scope', ''), 'all'), coalesce((p->>'with_subunits')::boolean, true),
            v_uid)
    returning id into v_id;
    insert into public.task_project_members (project_id, user_id, role) values (v_id, v_uid, 'owner');
    insert into public.task_project_members (project_id, user_id, role)
    select v_id, u, 'member' from unnest(public.task_uuid_array(p->'members')) u
     where u <> v_uid and public.is_portal_user(u)
     limit 1000
    on conflict do nothing;
    foreach s in array array['Новые', 'В работе', 'Готово'] loop
      i := i + 1;
      insert into public.task_stages (project_id, title, sort_order) values (v_id, s, i);
    end loop;
    insert into public.chat_chats (kind, title, created_by, settings)
    values ('project', left(v_title, 100), v_uid,
            jsonb_build_object('pin', 'all', 'post', 'all', 'add', 'admins', 'project_id', v_id))
    returning id into v_chat;
    update public.task_projects set chat_id = v_chat where id = v_id;
    perform public.task_project_sync_unit(v_id);
    perform public.chat_system_message(v_chat, v_uid,
      jsonb_build_object('type', 'project_created', 'title', v_title));
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'chat'));
    return v_id;
  end if;

  if not public.task_project_manages(v_id, v_uid) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  update public.task_projects
     set title = v_title,
         description = nullif(btrim(coalesce(p->>'description', '')), ''),
         color = nullif(p->>'color', ''),
         kind = coalesce(nullif(p->>'kind', ''), kind),
         visibility = coalesce(nullif(p->>'visibility', ''), visibility),
         deadline_rule = coalesce(nullif(p->>'deadline_rule', ''), deadline_rule),
         requires_review = coalesce((p->>'requires_review')::boolean, requires_review),
         unit_id = case when p ? 'unit_id' then nullif(p->>'unit_id', '')::uuid else unit_id end,
         unit_scope = coalesce(nullif(p->>'unit_scope', ''), unit_scope),
         with_subunits = coalesce((p->>'with_subunits')::boolean, with_subunits),
         updated_at = now()
   where id = v_id
  returning chat_id into v_chat;
  if v_chat is not null then
    update public.chat_chats set title = left(v_title, 100) where id = v_chat;
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'chat'));
  end if;
  perform public.task_project_sync_unit(v_id);
  return v_id;
end;
$$;

-- Добавить участников (владелец, модератор).
create or replace function public.task_project_members_add(p_project uuid, p_users uuid[],
                                                            p_role text default 'member')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if not public.task_project_manages(p_project, v_uid) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if p_role not in ('member', 'moderator') then
    raise exception 'project_bad_role' using errcode = '22023';
  end if;
  insert into public.task_project_members (project_id, user_id, role)
  select p_project, u, p_role from unnest(coalesce(p_users, '{}')) u
   where public.is_portal_user(u)
   limit 1000
  on conflict (project_id, user_id) do update set source = 'manual';
  perform public.task_project_chat_sync(p_project);
end;
$$;

-- Роль участника: владелец назначает кого угодно, модератор — только
-- участников и модераторов; последний владелец не снимается.
create or replace function public.task_project_member_set_role(p_project uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_me text := public.task_project_role(p_project, v_uid);
  v_target text := public.task_project_role(p_project, p_user);
  v_admin boolean := public.access_has_right(v_uid, 'tasks.admin');
begin
  if v_target is null or p_role not in ('owner', 'moderator', 'member') then
    raise exception 'project_bad_role' using errcode = '22023';
  end if;
  if not (v_admin or v_me = 'owner' or (v_me = 'moderator' and v_target <> 'owner' and p_role <> 'owner')) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if v_target = 'owner' and p_role <> 'owner'
     and (select count(*) from public.task_project_members
           where project_id = p_project and role = 'owner') = 1 then
    raise exception 'project_last_owner' using errcode = '22023';
  end if;
  update public.task_project_members set role = p_role where project_id = p_project and user_id = p_user;
end;
$$;

-- Убрать участника (владелец, модератор — не владельца) или выйти самому.
-- Пришедших из подразделения убирает только оргструктура.
create or replace function public.task_project_member_remove(p_project uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  m public.task_project_members;
begin
  select * into m from public.task_project_members where project_id = p_project and user_id = p_user;
  if not found then
    return;
  end if;
  if p_user <> v_uid and not (public.access_has_right(v_uid, 'tasks.admin')
     or public.task_project_role(p_project, v_uid) = 'owner'
     or (public.task_project_role(p_project, v_uid) = 'moderator' and m.role <> 'owner')) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if m.source = 'unit' then
    raise exception 'project_unit_member' using errcode = '22023';
  end if;
  if m.role = 'owner' and (select count(*) from public.task_project_members
                            where project_id = p_project and role = 'owner') = 1 then
    raise exception 'project_last_owner' using errcode = '22023';
  end if;
  delete from public.task_project_members where project_id = p_project and user_id = p_user;
  perform public.task_project_chat_sync(p_project);
end;
$$;

-- Вступить в открытый проект.
create or replace function public.task_project_join(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if not exists (select 1 from public.task_projects where id = p_project and visibility = 'open'
                                                    and archived_at is null) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  insert into public.task_project_members (project_id, user_id, role) values (p_project, v_uid, 'member')
  on conflict do nothing;
  perform public.task_project_chat_sync(p_project);
end;
$$;

-- В архив и обратно (владелец, модератор): проект и чат остаются, в
-- списках — внизу. Удалить — только владелец: задачи остаются без проекта,
-- чат проекта удаляется.
create or replace function public.task_project_archive(p_project uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.task_project_manages(p_project, public.chat_require_portal()) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  update public.task_projects set archived_at = case when p_archived then now() end, updated_at = now()
   where id = p_project;
end;
$$;

create or replace function public.task_project_delete(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_chat uuid;
begin
  if not (public.task_project_role(p_project, v_uid) = 'owner'
          or public.access_has_right(v_uid, 'tasks.admin')) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  select chat_id into v_chat from public.task_projects where id = p_project;
  if v_chat is not null then
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'));
    delete from public.chat_chats where id = v_chat;
  end if;
  delete from public.task_projects where id = p_project;
end;
$$;

-- Стадии канбана (владелец, модератор).
create or replace function public.task_stage_save(p_project uuid, p_id uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not public.task_project_manages(p_project, public.chat_require_portal()) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 60 then
    raise exception 'stage_title_invalid' using errcode = '22023';
  end if;
  if v_id is null then
    if (select count(*) from public.task_stages where project_id = p_project) >= 20 then
      raise exception 'too_many_stages' using errcode = '22023';
    end if;
    insert into public.task_stages (project_id, title, sort_order)
    values (p_project, btrim(p_title),
            coalesce((select max(sort_order) + 1 from public.task_stages where project_id = p_project), 1))
    returning id into v_id;
  else
    update public.task_stages set title = btrim(p_title) where id = v_id and project_id = p_project;
  end if;
  return v_id;
end;
$$;

-- Удалить стадию: её задачи — в первую из оставшихся; последнюю не удалить.
create or replace function public.task_stage_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_first uuid;
begin
  select project_id into v_project from public.task_stages where id = p_id;
  if v_project is null then
    return;
  end if;
  if not public.task_project_manages(v_project, public.chat_require_portal()) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  select id into v_first from public.task_stages where project_id = v_project and id <> p_id
   order by sort_order, created_at limit 1;
  if v_first is null then
    raise exception 'last_stage' using errcode = '22023';
  end if;
  update public.tasks set stage_id = v_first where stage_id = p_id;
  delete from public.task_stages where id = p_id;
end;
$$;

create or replace function public.task_stages_reorder(p_project uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.task_project_manages(p_project, public.chat_require_portal()) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  update public.task_stages s set sort_order = o.n
    from unnest(p_ids) with ordinality as o(id, n)
   where s.id = o.id and s.project_id = p_project;
end;
$$;

-- Стадия задачи на канбане: работники задачи, владелец и модераторы
-- проекта. Статус не меняет.
create or replace function public.task_set_stage(p_task uuid, p_stage uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  t public.tasks;
  v_title text;
begin
  select * into r from public.task_require(p_task, 'worker');
  select * into t from public.tasks where id = p_task for update;
  select title into v_title from public.task_stages where id = p_stage and project_id = t.project_id;
  if v_title is null then
    raise exception 'stage_not_found' using errcode = '22023';
  end if;
  if t.stage_id is not distinct from p_stage then
    return;
  end if;
  update public.tasks set stage_id = p_stage, updated_at = now() where id = p_task;
  perform public.task_event(p_task, r.uid, 'stage',
    jsonb_build_object('from', (select title from public.task_stages where id = t.stage_id), 'to', v_title));
  perform public.task_broadcast(p_task);
end;
$$;

-- 5. «Подчинённые» -------------------------------------------------------------

create or replace function public.task_subordinates()
returns table (user_id uuid, open_count integer, overdue_count integer, review_count integer,
               done_week integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_led uuid[] := array_remove(public.task_led_user_ids(v_uid), v_uid);
begin
  return query
  select u,
         count(*) filter (where t.status in ('new', 'in_progress', 'deferred'))::int,
         count(*) filter (where t.status in ('new', 'in_progress', 'deferred') and t.deadline < now())::int,
         count(*) filter (where t.status = 'review')::int,
         count(*) filter (where t.status = 'done' and t.completed_at > now() - interval '7 days')::int
    from unnest(v_led) u
    left join public.task_members m on m.user_id = u and m.role = 'assignee'
    left join public.tasks t on t.id = m.task_id
   group by u;
end;
$$;

-- 6. Шаблоны -------------------------------------------------------------------

-- Видит шаблон: свой личный, общие, проектов, где участник.
create or replace function public.task_template_visible(tp public.task_templates, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select tp.scope = 'shared'
      or (tp.scope = 'personal' and tp.owner_id = p_uid)
      or (tp.scope = 'project' and public.task_project_role(tp.project_id, p_uid) is not null)
      or public.access_has_right(p_uid, 'tasks.admin')
$$;

create or replace function public.task_template_editable(tp public.task_templates, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (tp.scope = 'personal' and tp.owner_id = p_uid)
      or (tp.scope = 'project' and public.task_project_manages(tp.project_id, p_uid))
      or public.access_has_right(p_uid, 'tasks.admin')
$$;

create or replace function public.task_templates_list()
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
    select jsonb_agg(jsonb_build_object(
             'id', tp.id, 'name', tp.name, 'scope', tp.scope, 'project_id', tp.project_id,
             'project', case when tp.project_id is not null then public.task_project_brief(tp.project_id) end,
             'owner_id', tp.owner_id, 'task', tp.task, 'updated_at', tp.updated_at,
             'can_edit', public.task_template_editable(tp, v_uid))
           order by case tp.scope when 'personal' then 0 when 'project' then 1 else 2 end, lower(tp.name))
      from public.task_templates tp
     where public.task_template_visible(tp, v_uid)), '[]');
end;
$$;

-- Сохранить шаблон. p: name, scope, project_id, task {…}. Общий —
-- «Администратор задач», проекта — владелец и модераторы.
create or replace function public.task_template_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_scope text := coalesce(nullif(p->>'scope', ''), 'personal');
  v_project uuid := case when v_scope = 'project' then nullif(p->>'project_id', '')::uuid end;
  v_task jsonb := case when jsonb_typeof(p->'task') = 'object' then p->'task' else '{}'::jsonb end;
  v_id uuid := p_id;
  tp public.task_templates;
begin
  if char_length(btrim(coalesce(p->>'name', ''))) not between 1 and 120 then
    raise exception 'template_name_invalid' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(v_task->>'title', ''))) not between 1 and 300 then
    raise exception 'task_title_invalid' using errcode = '22023';
  end if;
  if v_scope = 'shared' and not public.access_has_right(v_uid, 'tasks.admin')
     or v_scope = 'project' and (v_project is null or not public.task_project_manages(v_project, v_uid))
     or v_scope not in ('personal', 'project', 'shared') then
    raise exception 'template_forbidden' using errcode = '42501';
  end if;
  if v_id is not null then
    select * into tp from public.task_templates where id = v_id;
    if not found or not public.task_template_editable(tp, v_uid) then
      raise exception 'template_forbidden' using errcode = '42501';
    end if;
    update public.task_templates
       set name = btrim(p->>'name'), scope = v_scope, project_id = v_project, task = v_task, updated_at = now()
     where id = v_id;
  else
    insert into public.task_templates (owner_id, scope, project_id, name, task)
    values (v_uid, v_scope, v_project, btrim(p->>'name'), v_task)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.task_template_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tp public.task_templates;
begin
  select * into tp from public.task_templates where id = p_id;
  if not found then
    return;
  end if;
  if not public.task_template_editable(tp, public.chat_require_portal()) then
    raise exception 'template_forbidden' using errcode = '42501';
  end if;
  delete from public.task_templates where id = p_id;
end;
$$;

-- 7. Регулярные задачи ---------------------------------------------------------

-- Вид дня: из производственного календаря, иначе сб и вс — выходные.
create or replace function public.work_day_off(p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select kind = 'off' from public.work_calendar where day = p_day),
                  extract(isodow from p_day) in (6, 7))
$$;

-- p_n рабочих дней после p_day (0 — сам день или ближайший рабочий).
create or replace function public.work_add_days(p_day date, p_n integer)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d date := p_day;
  n integer := greatest(coalesce(p_n, 0), 0);
  i integer := 0;
begin
  while public.work_day_off(d) and i < 60 loop
    d := d + 1;
    i := i + 1;
  end loop;
  while n > 0 loop
    d := d + 1;
    if not public.work_day_off(d) then
      n := n - 1;
    end if;
  end loop;
  return d;
end;
$$;

-- Следующий день по правилу после p_after (null — по закрытию прежней).
create or replace function public.task_rec_next(p_rule jsonb, p_after date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_freq text := p_rule->>'freq';
  d date := p_after;
  v_days int[];
  v_md int := least(greatest(coalesce((p_rule->>'monthday')::int, 1), 1), 31);
  i integer;
begin
  if v_freq = 'after_close' then
    return null;
  end if;
  if jsonb_typeof(p_rule->'weekdays') = 'array' then
    v_days := array(select x::int from jsonb_array_elements_text(p_rule->'weekdays') x);
  end if;
  for i in 1..400 loop
    d := d + 1;
    if v_freq = 'daily'
       or (v_freq = 'workdays' and not public.work_day_off(d))
       or (v_freq = 'weekly' and extract(isodow from d)::int = any (coalesce(v_days, array[1])))
       or (v_freq = 'monthly' and extract(day from d)::int =
             least(v_md, extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::int)) then
      return d;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public.task_rec_valid(p_rule jsonb)
returns boolean
language sql
immutable
as $$
  select p_rule->>'freq' in ('daily', 'workdays', 'weekly', 'monthly', 'after_close')
     and (p_rule->>'freq' <> 'weekly' or (jsonb_typeof(p_rule->'weekdays') = 'array'
          and jsonb_array_length(p_rule->'weekdays') between 1 and 7))
     and (p_rule->>'freq' <> 'monthly' or coalesce((p_rule->>'monthday')::int, 0) between 1 and 31)
     and (p_rule->>'freq' <> 'after_close' or coalesce((p_rule->>'after_days')::int, -1) between 0 and 365)
$$;

-- Задача по шаблону от имени владельца регулярной: срок — через N рабочих
-- дней от дня создания в его поясе, к его концу рабочего дня (или к
-- времени шаблона). Ответ — id первой задачи.
create or replace function public.task_from_template(p_template uuid, p_owner uuid, p_recurrence uuid,
                                                     p_now timestamptz default now())
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  tp public.task_templates;
  s public.portal_user_settings;
  v_tz text;
  v_task jsonb;
  v_deadline timestamptz;
  v_day date;
  r jsonb;
begin
  select * into tp from public.task_templates where id = p_template;
  select * into s from public.portal_user_settings where user_id = p_owner;
  v_tz := coalesce(s.timezone, 'Europe/Moscow');
  v_task := tp.task;
  if v_task ? 'deadline_days' and nullif(v_task->>'deadline_days', '') is not null then
    v_day := public.work_add_days((p_now at time zone v_tz)::date, (v_task->>'deadline_days')::int);
    v_deadline := (v_day + coalesce(nullif(v_task->>'deadline_time', '')::time, s.workday_end, '18:00'::time))
                  at time zone v_tz;
  end if;
  r := public.task_create_as(p_owner,
         (v_task - 'deadline_days' - 'deadline_time')
         || jsonb_build_object('deadline', v_deadline, 'recurrence_id', p_recurrence,
                               'project_id', coalesce(tp.project_id::text, v_task->>'project_id')));
  return (r->'tasks'->0->>'id')::uuid;
end;
$$;

create or replace function public.task_recurrence_first_run(p_rule jsonb, p_time time, p_tz text,
                                                            p_now timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (p_now at time zone p_tz)::date;
  d date;
begin
  if p_rule->>'freq' = 'after_close' then
    return p_now;
  end if;
  -- Сегодня, если день подходит и время ещё не прошло, иначе — следующий.
  d := public.task_rec_next(p_rule, v_today - 1);
  if d = v_today and (d + p_time) at time zone p_tz <= p_now then
    d := public.task_rec_next(p_rule, v_today);
  end if;
  return (d + p_time) at time zone p_tz;
end;
$$;

create or replace function public.task_recurrences_list()
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
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'template_id', r.template_id, 'template_name', tp.name,
             'title', tp.task->>'title', 'rule', r.rule, 'at_time', to_char(r.at_time, 'HH24:MI'),
             'tz', r.tz, 'mode', r.mode, 'active', r.active, 'next_run_at', r.next_run_at,
             'last_run_at', r.last_run_at, 'last_error', r.last_error,
             'last_task', (select jsonb_build_object('number', t.number, 'status', t.status)
                             from public.tasks t where t.id = r.last_task_id))
           order by r.active desc, r.next_run_at nulls last)
      from public.task_recurrences r
      join public.task_templates tp on tp.id = r.template_id
     where r.owner_id = v_uid), '[]');
end;
$$;

-- Регулярная задача: p — template_id, rule, at_time, mode, active,
-- start_now (первая — сразу). Свои; шаблон должен быть виден.
create or replace function public.task_recurrence_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid := p_id;
  tp public.task_templates;
  v_rule jsonb := p->'rule';
  v_time time := coalesce(nullif(p->>'at_time', '')::time, '09:00');
  v_tz text;
  v_next timestamptz;
  v_active boolean := coalesce((p->>'active')::boolean, true);
begin
  select * into tp from public.task_templates where id = nullif(p->>'template_id', '')::uuid;
  if not found or not public.task_template_visible(tp, v_uid) then
    raise exception 'template_forbidden' using errcode = '42501';
  end if;
  if v_rule is null or not public.task_rec_valid(v_rule) then
    raise exception 'recurrence_invalid' using errcode = '22023';
  end if;
  select coalesce(max(timezone), 'Europe/Moscow') into v_tz
    from public.portal_user_settings where user_id = v_uid;
  v_next := case when coalesce((p->>'start_now')::boolean, false) then now()
                 else public.task_recurrence_first_run(v_rule, v_time, v_tz, now()) end;
  if v_id is null then
    if (select count(*) from public.task_recurrences where owner_id = v_uid) >= 100 then
      raise exception 'too_many_recurrences' using errcode = '22023';
    end if;
    insert into public.task_recurrences (template_id, owner_id, rule, at_time, tz, mode, active, next_run_at)
    values (tp.id, v_uid, v_rule, v_time, v_tz, coalesce(nullif(p->>'mode', ''), 'wait'), v_active, v_next)
    returning id into v_id;
  else
    update public.task_recurrences
       set template_id = tp.id, rule = v_rule, at_time = v_time, tz = v_tz,
           mode = coalesce(nullif(p->>'mode', ''), mode), active = v_active, next_run_at = v_next,
           last_error = null
     where id = v_id and owner_id = v_uid;
    if not found then
      raise exception 'recurrence_forbidden' using errcode = '42501';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.task_recurrence_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.task_recurrences where id = p_id and owner_id = auth.uid()
$$;

-- Проход регулярных (из task_tick): пришло время — новая задача; прежняя
-- ещё открыта — ждём её закрытия (wait) или закрываем как пропущенную
-- (skip). «Через N дней после закрытия» — срок от закрытия прежней.
create or replace function public.task_recurrence_tick(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  rc public.task_recurrences;
  v_last public.tasks;
  v_task uuid;
  n integer := 0;
begin
  -- «После закрытия»: прежняя закрыта — назначить следующий запуск.
  update public.task_recurrences r
     set next_run_at = (((t.completed_at at time zone r.tz)::date
                         + coalesce((r.rule->>'after_days')::int, 0)) + r.at_time) at time zone r.tz
    from public.tasks t
   where r.active and r.rule->>'freq' = 'after_close' and r.next_run_at is null
     and t.id = r.last_task_id and t.status in ('done', 'cancelled');

  for rc in
    select * from public.task_recurrences
     where active and next_run_at is not null and next_run_at <= p_now
     order by next_run_at
     limit 100
     for update skip locked
  loop
    select * into v_last from public.tasks where id = rc.last_task_id;
    if found and v_last.status not in ('done', 'cancelled') then
      if rc.mode = 'wait' then
        continue;
      end if;
      update public.tasks set status = 'cancelled', completed_at = p_now where id = v_last.id;
      perform public.task_event(v_last.id, null, 'status',
        jsonb_build_object('from', v_last.status, 'to', 'cancelled', 'action', 'skip'),
        'Пропущена: пришло время следующей регулярной задачи');
      perform public.task_broadcast(v_last.id);
    end if;
    begin
      v_task := public.task_from_template(rc.template_id, rc.owner_id, rc.id, p_now);
      update public.task_recurrences
         set last_task_id = v_task, last_run_at = p_now, last_error = null,
             next_run_at = case when rule->>'freq' = 'after_close' then null
                                else (public.task_rec_next(rule, (p_now at time zone tz)::date) + at_time)
                                     at time zone tz end
       where id = rc.id;
      n := n + 1;
    exception when others then
      -- Шаблон больше не годится (ушёл исполнитель, нет доступа к проекту) —
      -- выключаем, причина видна владельцу.
      update public.task_recurrences set active = false, last_error = left(sqlerrm, 300) where id = rc.id;
    end;
  end loop;
  return n;
end;
$$;

-- 8. Фоновый проход: + регулярные задачи --------------------------------------

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

  return jsonb_build_object('recurring', public.task_recurrence_tick(p_now), 'soon', v_soon, 'overdue', v_overdue, 'reminders', v_reminders,
                            'digests', v_digests);
end;
$$;

-- 9. Права на функции ---------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.task_project_role(uuid, uuid)',
    'public.task_project_manages(uuid, uuid)',
    'public.task_deadline_rule_of(uuid)',
    'public.task_project_brief(uuid)',
    'public.task_create_as(uuid, jsonb)',
    'public.task_project_chat_sync(uuid)',
    'public.task_project_unit_users(uuid)',
    'public.task_project_sync_unit(uuid)',
    'public.task_project_json(public.task_projects, uuid)',
    'public.task_template_visible(public.task_templates, uuid)',
    'public.task_template_editable(public.task_templates, uuid)',
    'public.work_day_off(date)',
    'public.work_add_days(date, integer)',
    'public.task_rec_next(jsonb, date)',
    'public.task_from_template(uuid, uuid, uuid, timestamptz)',
    'public.task_recurrence_first_run(jsonb, time, text, timestamptz)',
    'public.task_recurrence_tick(timestamptz)',
    'public.task_tick(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.task_projects_list()',
    'public.task_project_get(uuid)',
    'public.task_project_save(uuid, jsonb)',
    'public.task_project_members_add(uuid, uuid[], text)',
    'public.task_project_member_set_role(uuid, uuid, text)',
    'public.task_project_member_remove(uuid, uuid)',
    'public.task_project_join(uuid)',
    'public.task_project_archive(uuid, boolean)',
    'public.task_project_delete(uuid)',
    'public.task_stage_save(uuid, uuid, text)',
    'public.task_stage_delete(uuid)',
    'public.task_stages_reorder(uuid, uuid[])',
    'public.task_set_stage(uuid, uuid)',
    'public.task_subordinates()',
    'public.task_templates_list()',
    'public.task_template_save(uuid, jsonb)',
    'public.task_template_delete(uuid)',
    'public.task_recurrences_list()',
    'public.task_recurrence_save(uuid, jsonb)',
    'public.task_recurrence_delete(uuid)',
    'public.task_create(jsonb)',
    'public.task_list(jsonb)',
    'public.task_counters()',
    'public.task_update(uuid, jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
