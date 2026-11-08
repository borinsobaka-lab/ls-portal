-- ============================================================================
-- Задачи, этап 2 (TASKS_CHATS_PLAN.md, этап 2, блок 1, 2026-11-08):
-- задача из сообщения чата (1.18), подзадачи (1.10), результат задачи
-- (1.20), «срочные — первыми» в списке (1.26).
--
-- Задача из сообщения: `task_create` принимает `source: {chat_id, seq}` —
-- только сообщение (не системное, не удалённое) чата, где человек участник;
-- у задачи `source_chat_id` / `source_seq`, в чате — системная строка
-- `{type: 'task_created', numbers, count, title, seq}` («Поставлена задача
-- #N» со ссылкой на сообщение). Ссылку «Из сообщения» карточка задачи
-- показывает только участнику того чата.
--
-- Подзадачи: `tasks.parent_id` (`task_create` с `parent_id` — к задаче,
-- которую человек видит; `task_update` с `parent_id` — постановщик, без
-- кругов — `task_parent_invalid`). Постановщик, исполнитель и
-- соисполнители родительской задачи видят её подзадачи (роль «parent» в
-- `task_roles`, только чтение). В истории родительской — «добавлена
-- подзадача» и «подзадача завершена / отменена». Карточка — список
-- видимых подзадач (`task_json.subtasks`), строка списка — счётчики
-- `subtasks_total` / `subtasks_done` и `parent_number`.
--
-- Результат: `tasks.result_text` (до 5000 знаков) + кто и когда — пишет
-- `task_set_result` (постановщик, руководитель, исполнитель,
-- соисполнитель); «Нужен результат» (`result_required`, ставит
-- постановщик) — «Завершить» без результата не пускает
-- (`task_result_required`).
--
-- Список: `task_list` с `sort` — `deadline` (по умолчанию), `urgent`
-- (срочные первыми), `created` (новые первыми).
--
-- Актуальные определения `task_roles`, `task_json`, `task_list`,
-- `task_create_as`, `task_update`, `task_set_status` — здесь. Идемпотентно.
-- ============================================================================

-- 1. Колонки ------------------------------------------------------------------

alter table public.tasks add column if not exists parent_id uuid
  references public.tasks (id) on delete set null;
alter table public.tasks add column if not exists source_chat_id uuid
  references public.chat_chats (id) on delete set null;
alter table public.tasks add column if not exists source_seq bigint;
alter table public.tasks add column if not exists result_required boolean not null default false;
alter table public.tasks add column if not exists result_text text;
alter table public.tasks add column if not exists result_by uuid
  references auth.users (id) on delete set null;
alter table public.tasks add column if not exists result_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_result_text_check') then
    alter table public.tasks add constraint tasks_result_text_check
      check (result_text is null or char_length(result_text) between 1 and 5000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_parent_self_check') then
    alter table public.tasks add constraint tasks_parent_self_check check (parent_id is distinct from id);
  end if;
end $$;

create index if not exists tasks_parent_idx on public.tasks (parent_id) where parent_id is not null;
create index if not exists tasks_source_chat_idx on public.tasks (source_chat_id)
  where source_chat_id is not null;

-- 2. Кратко о задаче (подзадачи, родительская) --------------------------------

create or replace function public.task_brief(t public.tasks)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', t.id, 'number', t.number, 'title', t.title, 'status', t.status,
    'deadline', t.deadline, 'urgent', t.urgent,
    'assignee_id', (select m.user_id from public.task_members m
                     where m.task_id = t.id and m.role = 'assignee'))
$$;

-- 3. Задачи: роли, карточка, список, постановка, правка, статус ---------------------

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
      || case when p_uid is not null and exists (
                select 1 from public.tasks t
                  join public.task_members pm on pm.task_id = t.parent_id
                 where t.id = p_task and pm.user_id = p_uid
                   and pm.role in ('creator', 'assignee', 'coassignee'))
              then array['parent'] else '{}'::text[] end
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
    'parent_id', t.parent_id,
    'parent_number', (select pt.number from public.tasks pt where pt.id = t.parent_id),
    'subtasks_total', (select count(*) from public.tasks st where st.parent_id = t.id),
    'subtasks_done', (select count(*) from public.tasks st
                       where st.parent_id = t.id and st.status in ('done', 'cancelled')),
    'result_required', t.result_required,
    'has_result', t.result_text is not null,
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
      'result', case when t.result_text is not null then
                  jsonb_build_object('text', t.result_text, 'by', t.result_by, 'at', t.result_at) end,
      'parent', case when t.parent_id is null then null
                     when cardinality(public.task_roles(t.parent_id, p_uid)) > 0 then
                       (select public.task_brief(pt) from public.tasks pt where pt.id = t.parent_id)
                     else jsonb_build_object('number', (select pt.number from public.tasks pt
                                                         where pt.id = t.parent_id), 'hidden', true) end,
      'subtasks', coalesce((
        select jsonb_agg(public.task_brief(st) order by st.created_at, st.number)
          from public.tasks st
         where st.parent_id = t.id and cardinality(public.task_roles(st.id, p_uid)) > 0), '[]'),
      'source', case when t.source_chat_id is not null
                      and public.chat_role(t.source_chat_id, p_uid) is not null then
                  jsonb_build_object('chat_id', t.source_chat_id, 'seq', t.source_seq) end,
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
  v_sort text := coalesce(nullif(p0->>'sort', ''), 'deadline');
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
                      case when v_sort = 'urgent' then t.urgent end desc nulls last,
                      case when v_sort = 'created' then t.number end desc nulls last,
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
  v_parent uuid := nullif(p->>'parent_id', '')::uuid;
  v_src_chat uuid := case when jsonb_typeof(p->'source') = 'object'
                          then nullif(p->'source'->>'chat_id', '')::uuid end;
  v_src_seq bigint := case when jsonb_typeof(p->'source') = 'object'
                           then nullif(p->'source'->>'seq', '')::bigint end;
  v_numbers jsonb := '[]'::jsonb;
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
  -- Подзадача — к задаче, которую человек видит.
  if v_parent is not null and cardinality(public.task_roles(v_parent, v_uid)) = 0 then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  -- Задача из сообщения — из чата, где человек участник.
  if v_src_chat is not null and (
       public.chat_role(v_src_chat, v_uid) is null
       or not exists (select 1 from public.chat_messages cm
                       where cm.chat_id = v_src_chat and cm.seq = v_src_seq
                         and cm.kind = 'text' and cm.deleted_at is null)) then
    raise exception 'task_source_invalid' using errcode = '42501';
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
                              project_id, stage_id, recurrence_id, parent_id, source_chat_id, source_seq,
                              result_required)
    values (v_title, v_desc, coalesce((p->>'urgent')::boolean, false), v_deadline,
            coalesce(v_review, false), v_uid, v_batch, v_project, v_stage,
            nullif(p->>'recurrence_id', '')::uuid, v_parent, v_src_chat,
            case when v_src_chat is not null then v_src_seq end,
            coalesce((p->>'result_required')::boolean, false))
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
    if v_parent is not null then
      perform public.task_event(v_parent, v_uid, 'subtask',
        jsonb_build_object('number', v_number, 'title', v_title));
    end if;
    v_out := v_out || jsonb_build_object('id', v_task, 'number', v_number);
    v_numbers := v_numbers || to_jsonb(v_number);
  end loop;
  if v_parent is not null then
    perform public.task_touch(v_parent, v_uid);
    perform public.task_broadcast(v_parent);
  end if;
  -- В чате сообщения — строка «Поставлена задача #N» со ссылкой на сообщение.
  if v_src_chat is not null then
    perform public.chat_system_message(v_src_chat, v_uid,
      jsonb_build_object('type', 'task_created', 'title', v_title, 'seq', v_src_seq,
                         'numbers', (select coalesce(jsonb_agg(x), '[]') from (
                                       select x from jsonb_array_elements(v_numbers) x limit 20) z),
                         'count', jsonb_array_length(v_numbers)));
    perform public.chat_broadcast(v_src_chat, jsonb_build_object('type', 'message'));
  end if;
  return jsonb_build_object('tasks', v_out, 'batch_id', v_batch);
end;
$$;

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
  v_parent uuid;
begin
  select * into r from public.task_require(p_task, 'view');
  select * into t from public.tasks where id = p_task for update;
  v_boss := r.roles && array['creator', 'manager'];

  if (p ? 'title' or p ? 'description' or p ? 'urgent' or p ? 'requires_review' or p ? 'project_id'
      or p ? 'parent_id' or p ? 'result_required')
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
  if p ? 'result_required' and (p->>'result_required')::boolean is distinct from t.result_required then
    update public.tasks set result_required = coalesce((p->>'result_required')::boolean, false)
     where id = p_task;
    perform public.task_event(p_task, r.uid, 'result_required',
      jsonb_build_object('to', coalesce((p->>'result_required')::boolean, false)));
    v_changed := true;
  end if;
  if p ? 'parent_id' then
    v_parent := nullif(p->>'parent_id', '')::uuid;
    if v_parent is distinct from t.parent_id then
      if v_parent is not null then
        if cardinality(public.task_roles(v_parent, r.uid)) = 0 then
          raise exception 'task_not_found' using errcode = '42501';
        end if;
        -- Без кругов: новая родительская не может быть этой задачей или её подзадачей.
        if v_parent = p_task or exists (
             with recursive up as (
               select x.id, x.parent_id, 1 as depth from public.tasks x where x.id = v_parent
               union all
               select x.id, x.parent_id, up.depth + 1
                 from public.tasks x join up on x.id = up.parent_id
                where up.depth < 100)
             select 1 from up where up.id = p_task) then
          raise exception 'task_parent_invalid' using errcode = '22023';
        end if;
      end if;
      update public.tasks set parent_id = v_parent where id = p_task;
      perform public.task_event(p_task, r.uid, 'parent',
        jsonb_build_object('from', (select x.number from public.tasks x where x.id = t.parent_id),
                           'to', (select x.number from public.tasks x where x.id = v_parent)));
      if v_parent is not null then
        perform public.task_event(v_parent, r.uid, 'subtask',
          jsonb_build_object('number', t.number, 'title', t.title));
        perform public.task_broadcast(v_parent);
      end if;
      if t.parent_id is not null then
        perform public.task_broadcast(t.parent_id);
      end if;
      v_changed := true;
    end if;
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
  -- «Нужен результат»: завершить — только с написанным результатом.
  if p_action = 'complete' and t.result_required and t.result_text is null then
    raise exception 'task_result_required' using errcode = '22023';
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
  -- Родительской задаче — строка истории о завершённой подзадаче.
  if t.parent_id is not null and v_to in ('done', 'cancelled') then
    perform public.task_event(t.parent_id, r.uid, 'subtask_status',
      jsonb_build_object('number', t.number, 'title', t.title, 'to', v_to));
    perform public.task_broadcast(t.parent_id);
  end if;
  perform public.task_touch(p_task, r.uid);
  select * into t from public.tasks where id = p_task;
  return public.task_json(t, r.uid, true);
end;
$$;

-- 4. Результат ----------------------------------------------------------------------

create or replace function public.task_set_result(p_task uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  t public.tasks;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  select * into r from public.task_require(p_task, 'worker');
  select * into t from public.tasks where id = p_task for update;
  if char_length(v_text) > 5000 then
    raise exception 'task_result_invalid' using errcode = '22023';
  end if;
  if v_text is distinct from t.result_text then
    update public.tasks
       set result_text = v_text,
           result_by = case when v_text is null then null else r.uid end,
           result_at = case when v_text is null then null else now() end
     where id = p_task;
    perform public.task_event(p_task, r.uid, 'result',
      jsonb_build_object('cleared', v_text is null));
    perform public.task_touch(p_task, r.uid);
  end if;
  select * into t from public.tasks where id = p_task;
  return public.task_json(t, r.uid, true);
end;
$$;

-- 5. Права ----------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.task_brief(public.tasks)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.task_set_result(uuid, text)',
    'public.task_create(jsonb)',
    'public.task_list(jsonb)',
    'public.task_update(uuid, jsonb, text)',
    'public.task_set_status(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
