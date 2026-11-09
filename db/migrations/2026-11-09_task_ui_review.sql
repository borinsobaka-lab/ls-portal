-- ============================================================================
-- Задачи: разбор интерфейса перед тестом (UI_REVIEW_CHATS_TASKS_CALENDAR.md,
-- 4.4.7, 4.7.1, этап Б, п. 11; этап В, п. 16; 2026-11-09).
--
-- 1. Регулярная задача без отдельного шаблона: «Повторять» в форме новой
--    задачи и «Сделать регулярной» в карточке. Регулярная по-прежнему —
--    шаблон + расписание (решение владельца), но шаблон заводится сам и
--    скрыт (`task_templates.hidden`): его нет в «Шаблонах» и в «Из
--    шаблона», он уходит вместе с последней регулярной по нему (триггер
--    `task_recurrences_hidden_template_ad`). RPC `task_make_recurring(p_task,
--    p)`: задача — уже поставленная (она и есть первая: следующая — по
--    расписанию после сегодняшнего дня, режим «ждать» смотрит на неё); поля
--    шаблона — `p.task` (форма постановки) или из самой задачи; `p.rule`,
--    `p.at_time`, `p.mode`. Только постановщик или тот, кто правит задачу как
--    постановщик (`manager`).
--    Актуальные определения `task_templates_list` (без скрытых) и
--    `task_recurrences_list` (+ `template_hidden`; у скрытого шаблона
--    название — название задачи) — здесь.
-- 2. «Мой план»: стартовые колонки новой доски — «Сейчас», «Дальше»,
--    «Когда-нибудь» (прежние «Сегодня / На этой неделе / Потом» совпадали со
--    «Сроками», хотя срок доска не меняет). Колонки, которые уже есть у
--    людей, не переименовываются. Актуальное определение `task_plan_get` —
--    здесь.
-- 3. Картинки в описании новой задачи (форма постановки — тот же редактор,
--    что карточка): до постановки у задачи нет папки `tasks/<id>/` в
--    `kb-media`, поэтому файлы описания ложатся в свою папку
--    `tasks/new/<человек>/` (только сам: прочитать, загрузить, убрать —
--    политика «tasks kb-media new own»), после постановки портал копирует их
--    в папку задачи и правит ссылки в описании. Брошенные — уборка файлов
--    без ссылок (kb_file_gc_candidates, через 7 дней).
--
-- Идемпотентно.
-- ============================================================================

alter table public.task_templates add column if not exists hidden boolean not null default false;

-- 1. Шаблоны и регулярные ------------------------------------------------------

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
     where not tp.hidden and public.task_template_visible(tp, v_uid)), '[]');
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
             'id', r.id, 'template_id', r.template_id,
             'template_name', case when tp.hidden then tp.task->>'title' else tp.name end,
             'template_hidden', tp.hidden,
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

-- Скрытый шаблон живёт, пока по нему есть регулярная.
create or replace function public.task_recurrences_hidden_template_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.task_templates tp
   where tp.id = old.template_id and tp.hidden
     and not exists (select 1 from public.task_recurrences r where r.template_id = tp.id);
  return null;
end;
$$;

drop trigger if exists task_recurrences_hidden_template_ad on public.task_recurrences;
create trigger task_recurrences_hidden_template_ad
  after delete on public.task_recurrences
  for each row execute function public.task_recurrences_hidden_template_ad();

-- Поля шаблона из поставленной задачи: люди, описание, чек-листы, флаги,
-- проект; срок — через столько рабочих дней от дня постановки, ко времени
-- срока (в поясе владельца).
create or replace function public.task_template_from_task(p_task uuid, p_tz text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t public.tasks;
  v_days integer;
  v_from date;
  v_to date;
  d date;
begin
  select * into t from public.tasks where id = p_task;
  if t.deadline is not null then
    v_from := (t.created_at at time zone p_tz)::date;
    v_to := (t.deadline at time zone p_tz)::date;
    v_days := 0;
    d := v_from;
    while d < v_to and v_days < 365 loop
      d := d + 1;
      if not public.work_day_off(d) then
        v_days := v_days + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object(
    'title', t.title,
    'description', t.description,
    'assignees', coalesce((select jsonb_agg(user_id) from public.task_members
                            where task_id = t.id and role = 'assignee'), '[]'::jsonb),
    'mode', 'shared',
    'coassignees', coalesce((select jsonb_agg(user_id) from public.task_members
                              where task_id = t.id and role = 'coassignee'), '[]'::jsonb),
    'watchers', coalesce((select jsonb_agg(user_id) from public.task_members
                           where task_id = t.id and role = 'watcher'), '[]'::jsonb),
    'checklists', coalesce((
      select jsonb_agg(jsonb_build_object('title', l.title, 'items', coalesce((
               select jsonb_agg(jsonb_build_object('text', i.text, 'assignee_id', i.assignee_id)
                                order by i.sort_order, i.created_at)
                 from public.task_checklist_items i where i.checklist_id = l.id), '[]'::jsonb))
             order by l.sort_order, l.created_at)
        from public.task_checklists l where l.task_id = t.id), '[]'::jsonb),
    'urgent', t.urgent,
    'requires_review', t.requires_review,
    'result_required', t.result_required,
    'project_id', t.project_id,
    'deadline_days', v_days,
    'deadline_time', case when t.deadline is not null
                          then to_char(t.deadline at time zone p_tz, 'HH24:MI') end);
end;
$$;

-- «Повторять» / «Сделать регулярной». p: rule, at_time ('HH:MM'), mode
-- (wait | skip), task (поля шаблона; нет — из задачи). Ответ — id регулярной.
create or replace function public.task_make_recurring(p_task uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_roles text[];
  t public.tasks;
  v_rule jsonb := p->'rule';
  v_time time := coalesce(nullif(p->>'at_time', '')::time, '09:00');
  v_mode text := coalesce(nullif(p->>'mode', ''), 'wait');
  v_tz text;
  v_task jsonb;
  v_template uuid;
  v_id uuid;
  v_today date;
begin
  select * into t from public.tasks where id = p_task;
  if not found then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  v_roles := public.task_roles(p_task, v_uid);
  if not coalesce(v_roles && array['creator', 'manager'], false) then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if t.recurrence_id is not null
     and exists (select 1 from public.task_recurrences where id = t.recurrence_id) then
    raise exception 'task_already_recurring' using errcode = '22023';
  end if;
  if v_rule is null or jsonb_typeof(v_rule) is distinct from 'object'
     or not coalesce(public.task_rec_valid(v_rule), false) then
    raise exception 'recurrence_invalid' using errcode = '22023';
  end if;
  if v_mode not in ('wait', 'skip') then
    raise exception 'recurrence_invalid' using errcode = '22023';
  end if;
  if (select count(*) from public.task_recurrences where owner_id = v_uid) >= 100 then
    raise exception 'too_many_recurrences' using errcode = '22023';
  end if;
  select coalesce(max(timezone), 'Europe/Moscow') into v_tz
    from public.portal_user_settings where user_id = v_uid;

  v_task := case when jsonb_typeof(p->'task') = 'object' then p->'task'
                 else public.task_template_from_task(p_task, v_tz) end;
  -- Проект — проект задачи (поле формы может отставать от переноса).
  v_task := (v_task - 'project_id' - 'parent_id' - 'source' - 'files' - 'reminder' - 'tags'
             - 'deadline' - 'recurrence_id')
            || jsonb_build_object('project_id', t.project_id);
  if char_length(btrim(coalesce(v_task->>'title', ''))) not between 1 and 300 then
    raise exception 'task_title_invalid' using errcode = '22023';
  end if;

  insert into public.task_templates (owner_id, scope, project_id, name, task, hidden)
  values (v_uid, 'personal', null, left(btrim(v_task->>'title'), 120), v_task, true)
  returning id into v_template;

  -- Поставленная задача — первая: следующая по расписанию после сегодня.
  v_today := (now() at time zone v_tz)::date;
  insert into public.task_recurrences (template_id, owner_id, rule, at_time, tz, mode, active,
                                       next_run_at, last_run_at, last_task_id)
  values (v_template, v_uid, v_rule, v_time, v_tz, v_mode, true,
          case when v_rule->>'freq' = 'after_close' then null
               else (public.task_rec_next(v_rule, v_today) + v_time) at time zone v_tz end,
          now(), p_task)
  returning id into v_id;

  update public.tasks set recurrence_id = v_id where id = p_task;
  -- Остальные задачи той же постановки «отдельно каждому» — тоже из неё.
  if t.batch_id is not null then
    update public.tasks set recurrence_id = v_id
     where batch_id = t.batch_id and recurrence_id is null;
  end if;
  perform public.task_broadcast(p_task);
  return v_id;
end;
$$;

-- 2. «Мой план»: стартовые колонки новой доски -----------------------------------

create or replace function public.task_plan_get()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  -- Первый раз — стартовые колонки (не про сроки: доска срок не меняет).
  if not exists (select 1 from public.task_plan_columns where user_id = v_uid)
     and not exists (select 1 from public.task_plan_items where user_id = v_uid) then
    insert into public.task_plan_columns (user_id, title, sort_order)
    values (v_uid, 'Сейчас', 0), (v_uid, 'Дальше', 1), (v_uid, 'Когда-нибудь', 2);
  end if;
  return jsonb_build_object(
    'columns', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) order by c.sort_order, c.created_at)
        from public.task_plan_columns c where c.user_id = v_uid), '[]'::jsonb),
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'column_id', i.column_id, 'sort_order', coalesce(i.sort_order, 0),
               'added', coalesce(i.added, false), 'task', public.task_json(t, v_uid))
             order by coalesce(i.sort_order, 2147483647), t.deadline nulls last, t.created_at)
        from public.tasks t
        left join public.task_plan_items i on i.task_id = t.id and i.user_id = v_uid
       where t.status not in ('done', 'cancelled')
         and (exists (select 1 from public.task_members m
                       where m.task_id = t.id and m.user_id = v_uid and m.role in ('assignee', 'coassignee'))
              or (coalesce(i.added, false) and cardinality(public.task_roles(t.id, v_uid)) > 0))), '[]'::jsonb));
end;
$$;

-- 3. Своя папка картинок новой задачи ---------------------------------------------

drop policy if exists "tasks kb-media new own" on storage.objects;
create policy "tasks kb-media new own" on storage.objects
  for all to authenticated
  using (bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'tasks'
         and (storage.foldername(name))[2] = 'new'
         and (storage.foldername(name))[3] = (select auth.uid())::text)
  with check (bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'tasks'
              and (storage.foldername(name))[2] = 'new'
              and (storage.foldername(name))[3] = (select auth.uid())::text);

-- 4. Права на функции -----------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.task_recurrences_hidden_template_ad()',
    'public.task_template_from_task(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.task_templates_list()',
    'public.task_recurrences_list()',
    'public.task_make_recurring(uuid, jsonb)',
    'public.task_plan_get()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
