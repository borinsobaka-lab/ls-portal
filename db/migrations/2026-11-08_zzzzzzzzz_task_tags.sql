-- ============================================================================
-- Задачи, этап 2 (TASKS_CHATS_PLAN.md, 1.12, 2026-11-08): теги задач — по
-- городу, каналу, теме, для быстрой фильтрации.
--
-- Теги общие для портала (`task_tags`: имя без регистра уникально, до 40
-- знаков, «#» и лишние пробелы срезаются; цвет — ключ набора, как у тегов
-- базы знаний). Завести тег может любой человек портала, переименовать,
-- перекрасить и удалить — кто завёл или «Администратор задач». У задачи —
-- до 10 тегов (`task_tag_links`), ставят постановщик, руководитель,
-- исполнитель и соисполнители (`task_set_tags`, в историю — «теги»).
-- `task_json.tags`, `task_list` с `tag` — фильтр (актуальные определения —
-- здесь). RPC: `task_tags_list`, `task_tag_save`, `task_tag_delete`,
-- `task_set_tags`. Таблицы закрыты браузеру. Идемпотентно.
-- ============================================================================

create table if not exists public.task_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  color text check (color is null or color in
    ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists task_tags_name_uidx on public.task_tags (lower(name));
alter table public.task_tags enable row level security;

create table if not exists public.task_tag_links (
  task_id uuid not null references public.tasks (id) on delete cascade,
  tag_id uuid not null references public.task_tags (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (task_id, tag_id)
);
create index if not exists task_tag_links_tag_idx on public.task_tag_links (tag_id);
alter table public.task_tag_links enable row level security;

create or replace function public.task_tag_name(p text)
returns text
language sql
immutable
as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '^\s*#+', ''), '\s+', ' ', 'g')), 40)
$$;

create or replace function public.task_tags_list()
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
    select jsonb_agg(jsonb_build_object(
             'id', g.id, 'name', g.name, 'color', g.color,
             'count', (select count(*) from public.task_tag_links l where l.tag_id = g.id),
             'can_edit', v_admin or g.created_by = v_uid)
           order by lower(g.name))
      from public.task_tags g), '[]'::jsonb);
end;
$$;

-- Новый тег (с тем же именем уже есть — вернуть его) или правка своего.
create or replace function public.task_tag_save(p_id uuid, p_name text, p_color text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_name text := public.task_tag_name(p_name);
  v_id uuid;
  g public.task_tags;
begin
  if v_name = '' then
    raise exception 'task_tag_invalid' using errcode = '22023';
  end if;
  if p_color is not null and p_color not in
     ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink') then
    raise exception 'task_tag_invalid' using errcode = '22023';
  end if;
  if p_id is null then
    select id into v_id from public.task_tags where lower(name) = lower(v_name);
    if v_id is not null then
      return v_id;
    end if;
    insert into public.task_tags (name, color, created_by) values (v_name, p_color, v_uid)
    returning id into v_id;
    return v_id;
  end if;
  select * into g from public.task_tags where id = p_id;
  if not found then
    raise exception 'task_tag_not_found' using errcode = '42501';
  end if;
  if g.created_by is distinct from v_uid and not public.access_has_right(v_uid, 'tasks.admin') then
    raise exception 'task_tag_forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.task_tags where lower(name) = lower(v_name) and id <> p_id) then
    raise exception 'task_tag_exists' using errcode = '23505';
  end if;
  update public.task_tags set name = v_name, color = p_color where id = p_id;
  return p_id;
end;
$$;

create or replace function public.task_tag_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  g public.task_tags;
begin
  select * into g from public.task_tags where id = p_id;
  if not found then
    return;
  end if;
  if g.created_by is distinct from v_uid and not public.access_has_right(v_uid, 'tasks.admin') then
    raise exception 'task_tag_forbidden' using errcode = '42501';
  end if;
  delete from public.task_tags where id = p_id;
end;
$$;

-- Теги задачи целиком (до 10).
create or replace function public.task_set_tags(p_task uuid, p_tags uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  t public.tasks;
  v_tags uuid[] := array(select distinct x from unnest(coalesce(p_tags, '{}'::uuid[])) x);
  v_added text[];
  v_removed text[];
begin
  select * into r from public.task_require(p_task, 'worker');
  if cardinality(v_tags) > 10 then
    raise exception 'task_too_many_tags' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_tags) x where not exists (select 1 from public.task_tags g where g.id = x)) then
    raise exception 'task_tag_not_found' using errcode = '22023';
  end if;
  select coalesce(array_agg(g.name order by g.name), '{}') into v_removed
    from public.task_tag_links l join public.task_tags g on g.id = l.tag_id
   where l.task_id = p_task and not (l.tag_id = any (v_tags));
  select coalesce(array_agg(g.name order by g.name), '{}') into v_added
    from public.task_tags g
   where g.id = any (v_tags)
     and not exists (select 1 from public.task_tag_links l where l.task_id = p_task and l.tag_id = g.id);
  delete from public.task_tag_links where task_id = p_task and not (tag_id = any (v_tags));
  insert into public.task_tag_links (task_id, tag_id, added_by)
  select p_task, x, r.uid from unnest(v_tags) x
  on conflict do nothing;
  if cardinality(v_added) + cardinality(v_removed) > 0 then
    perform public.task_event(p_task, r.uid, 'tags',
      jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)));
    perform public.task_broadcast(p_task);
  end if;
  select * into t from public.tasks where id = p_task;
  return public.task_json(t, r.uid, true);
end;
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
    'tags', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color)
                                       order by lower(g.name))
                        from public.task_tag_links l join public.task_tags g on g.id = l.tag_id
                       where l.task_id = t.id), '[]'),
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
  v_tag uuid := nullif(p0->>'tag', '')::uuid;
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
       and (v_tag is null or exists (select 1 from public.task_tag_links tl
                                      where tl.task_id = t.id and tl.tag_id = v_tag))
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

do $$
declare
  f text;
begin
  revoke all on function public.task_tag_name(text) from public, anon, authenticated;
  foreach f in array array[
    'public.task_tags_list()',
    'public.task_tag_save(uuid, text, text)',
    'public.task_tag_delete(uuid)',
    'public.task_set_tags(uuid, uuid[])',
    'public.task_list(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
