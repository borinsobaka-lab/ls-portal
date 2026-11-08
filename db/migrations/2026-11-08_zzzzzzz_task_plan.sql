-- ============================================================================
-- Задачи, этап 2 (TASKS_CHATS_PLAN.md, 1.32, 2026-11-08): «Мой план» —
-- личная канбан-доска задач со своими колонками.
--
-- Колонки `task_plan_columns` — у каждого человека свои (до 10, название до
-- 40 знаков; первый раз — «Сегодня», «На этой неделе», «Потом»). На доске —
-- открытые задачи, где человек исполнитель или соисполнитель, и задачи,
-- которые он добавил в план сам (`task_plan_items.added`: любые видимые
-- ему, например «Поручил»). Где лежит карточка — `task_plan_items`
-- (колонка и порядок; нет строки или колонка удалена — «Не разобрано»).
-- Доска не меняет задачу: ни статус, ни срок.
--
-- RPC: `task_plan_get` (колонки и карточки), `task_plan_place` (колонка и
-- порядок карточек после перетаскивания), `task_plan_add` / `_remove`,
-- `task_plan_column_save` / `_delete`, `task_plan_columns_reorder`. Таблицы
-- закрыты браузеру. Идемпотентно.
-- ============================================================================

create table if not exists public.task_plan_columns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_plan_columns_user_idx on public.task_plan_columns (user_id, sort_order);
alter table public.task_plan_columns enable row level security;

create table if not exists public.task_plan_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  column_id uuid references public.task_plan_columns (id) on delete set null,
  sort_order integer not null default 0,
  -- Добавлена в план вручную (не по роли исполнителя или соисполнителя).
  added boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists task_plan_items_task_idx on public.task_plan_items (task_id);
alter table public.task_plan_items enable row level security;

create or replace function public.task_plan_get()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  -- Первый раз — стартовые колонки.
  if not exists (select 1 from public.task_plan_columns where user_id = v_uid)
     and not exists (select 1 from public.task_plan_items where user_id = v_uid) then
    insert into public.task_plan_columns (user_id, title, sort_order)
    values (v_uid, 'Сегодня', 0), (v_uid, 'На этой неделе', 1), (v_uid, 'Потом', 2);
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

-- Колонка и порядок после перетаскивания: p_tasks — все карточки колонки
-- сверху вниз (null — «Не разобрано»).
create or replace function public.task_plan_place(p_column uuid, p_tasks uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  t uuid;
  i integer := 0;
begin
  if p_column is not null
     and not exists (select 1 from public.task_plan_columns where id = p_column and user_id = v_uid) then
    raise exception 'task_plan_column_not_found' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_tasks, '{}')) > 500 then
    raise exception 'task_plan_invalid' using errcode = '22023';
  end if;
  foreach t in array coalesce(p_tasks, '{}') loop
    if cardinality(public.task_roles(t, v_uid)) = 0 then
      raise exception 'task_not_found' using errcode = '42501';
    end if;
    insert into public.task_plan_items (user_id, task_id, column_id, sort_order, added)
    values (v_uid, t, p_column, i,
            not exists (select 1 from public.task_members m
                         where m.task_id = t and m.user_id = v_uid and m.role in ('assignee', 'coassignee')))
    on conflict (user_id, task_id) do update
      set column_id = excluded.column_id, sort_order = excluded.sort_order, updated_at = now();
    i := i + 1;
  end loop;
end;
$$;

create or replace function public.task_plan_add(p_task uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if cardinality(public.task_roles(p_task, v_uid)) = 0 then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  insert into public.task_plan_items (user_id, task_id, column_id, sort_order, added)
  values (v_uid, p_task, null, 0, true)
  on conflict (user_id, task_id) do update set added = true, updated_at = now();
end;
$$;

-- Убрать из плана добавленную вручную (свою по роли — только «Не разобрано»).
create or replace function public.task_plan_remove(p_task uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.task_plan_items where user_id = public.chat_require_portal() and task_id = p_task;
end;
$$;

create or replace function public.task_plan_column_save(p_id uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
begin
  if char_length(v_title) not between 1 and 40 then
    raise exception 'task_plan_column_invalid' using errcode = '22023';
  end if;
  if p_id is null then
    if (select count(*) from public.task_plan_columns where user_id = v_uid) >= 10 then
      raise exception 'task_plan_too_many_columns' using errcode = '22023';
    end if;
    insert into public.task_plan_columns (user_id, title, sort_order)
    values (v_uid, v_title,
            coalesce((select max(sort_order) + 1 from public.task_plan_columns where user_id = v_uid), 0))
    returning id into v_id;
  else
    update public.task_plan_columns set title = v_title where id = p_id and user_id = v_uid
    returning id into v_id;
    if v_id is null then
      raise exception 'task_plan_column_not_found' using errcode = '42501';
    end if;
  end if;
  return v_id;
end;
$$;

-- Удалить колонку — её карточки уходят в «Не разобрано».
create or replace function public.task_plan_column_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.task_plan_columns where id = p_id and user_id = public.chat_require_portal();
end;
$$;

create or replace function public.task_plan_columns_reorder(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  update public.task_plan_columns c
     set sort_order = x.ord - 1
    from unnest(coalesce(p_ids, '{}')) with ordinality as x(id, ord)
   where c.id = x.id and c.user_id = v_uid;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.task_plan_get()',
    'public.task_plan_place(uuid, uuid[])',
    'public.task_plan_add(uuid)',
    'public.task_plan_remove(uuid)',
    'public.task_plan_column_save(uuid, text)',
    'public.task_plan_column_delete(uuid)',
    'public.task_plan_columns_reorder(uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
