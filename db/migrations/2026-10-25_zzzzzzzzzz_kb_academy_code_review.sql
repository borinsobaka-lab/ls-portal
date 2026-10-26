-- ============================================================================
-- База знаний и «Академия» — правки по код-ревью 2026-10-25.
--
-- База знаний:
-- 1) kb_reads.read_published_at появилась в 2026-10-25_zzzz_kb_reading_analytics.sql
--    без заполнения: прочитанное до неё считалось «прежней версией» (NULL <
--    published_at), пока человек не откроет статью снова. Разово —
--    published_at статьи, если читал после её публикации.
-- 2) kb_trash_restore возвращал kb_reads без read_published_at, seconds,
--    max_scroll и completed_at (снимок их хранит): после «Вернуть» все
--    читатели становились «прежней версией» с нулём секунд. Актуальное
--    определение — здесь (остальное — как в …_kb_nested_articles.sql).
-- 3) kb_analytics_search — вкладка «Поиск» аналитики: только журнал поиска.
--    Раньше она грузила весь kb_analytics_overview (пары сотрудник × статья —
--    150 000 строк на 500 × 300) ради пяти полей. Цифры — те же, что в
--    обзоре.
--
-- «Академия»:
-- 4) Замок шагов курса «по порядку» — один проход (acad_step_locks,
--    внутренняя): acad_course_view считал acad_step_states заново для
--    каждого шага (30 шагов — 900 расчётов). Порядок — как в интерфейсе и
--    acad_step_states (sort_order, created_at), раньше замок брал
--    (sort_order, id): при равном sort_order решал uuid. Актуальные
--    определения acad_step_unlocked и acad_course_view — здесь.
-- 5) Свои ответы не проверяют: acad_review_queue их не показывает,
--    acad_review_submit — исключение acad_own_attempt, счётчик «на проверку»
--    в acad_access их не считает (владелец — проверяющий и, по правилу
--    «роль owner», ученик — мог сам засчитать себе тест). Актуальные
--    определения — здесь.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Версия прочитанного — разово ---------------------------------------------------
update public.kb_reads r
   set read_published_at = n.published_at
  from public.kb_nodes n
 where n.id = r.node_id
   and r.read_published_at is null
   and n.published_at is not null
   and r.last_read_at >= n.published_at;

-- 2) Возврат из корзины — чтение целиком ---------------------------------------------
create or replace function public.kb_trash_restore(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.kb_trash;
  r record;
  parent uuid;
begin
  select * into t from public.kb_trash where id = p_id;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), t.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  if exists (select 1 from public.kb_nodes where id = t.root_id) then
    raise exception 'kb_already_restored';
  end if;
  -- Прежний родитель на месте — туда же (статью — и в статью); иначе — наверх.
  parent := (select id from public.kb_nodes
              where id = t.parent_id and (kind = 'folder' or t.kind = 'article'));

  perform set_config('kb.restoring', '1', true);
  -- По одной строке, сверху вниз: триггер берёт путь и видимость у родителя.
  for r in
    select x.*, ord
      from jsonb_array_elements(t.payload -> 'nodes') with ordinality as e(j, ord),
           jsonb_populate_record(null::public.kb_nodes, e.j) x
     order by ord
  loop
    insert into public.kb_nodes (
      id, base_id, parent_id, kind, title, description, icon, protect, sort_order, status,
      content, created_by, created_at, updated_by, updated_at, published_by, published_at,
      feedback_enabled, pager_enabled
    ) values (
      r.id, r.base_id, case when r.id = t.root_id then parent else r.parent_id end,
      r.kind, r.title, r.description, r.icon, coalesce(r.protect, 'inherit'),
      case when r.id = t.root_id then null else r.sort_order end, r.status,
      r.content, public.kb_existing_user(r.created_by), r.created_at,
      public.kb_existing_user(r.updated_by), r.updated_at,
      public.kb_existing_user(r.published_by), r.published_at,
      coalesce(r.feedback_enabled, true), coalesce(r.pager_enabled, true)
    );
  end loop;

  insert into public.kb_drafts (node_id, base_id, content, updated_by, updated_at)
  select d.node_id, d.base_id, d.content, public.kb_existing_user(d.updated_by), d.updated_at
    from jsonb_populate_recordset(null::public.kb_drafts, t.payload -> 'drafts') d;
  insert into public.kb_revisions (id, node_id, base_id, title, content, published_by, published_at)
  select r2.id, r2.node_id, r2.base_id, r2.title, r2.content,
         public.kb_existing_user(r2.published_by), r2.published_at
    from jsonb_populate_recordset(null::public.kb_revisions, t.payload -> 'revisions') r2;
  -- Снимки до учёта чтения этих полей не знают — coalesce. Без версии, но
  -- читал после публикации — версия статьи (как разовое заполнение выше).
  insert into public.kb_reads (
    node_id, user_id, base_id, first_read_at, last_read_at, read_count,
    read_published_at, seconds, max_scroll, completed_at
  )
  select x.node_id, x.user_id, x.base_id, x.first_read_at, x.last_read_at, x.read_count,
         coalesce(x.read_published_at,
                  (select n.published_at from public.kb_nodes n
                    where n.id = x.node_id and n.published_at <= x.last_read_at)),
         coalesce(x.seconds, 0), coalesce(x.max_scroll, 0), x.completed_at
    from jsonb_populate_recordset(null::public.kb_reads, t.payload -> 'reads') x
   where public.kb_existing_user(x.user_id) is not null;
  insert into public.kb_favorites (user_id, node_id, base_id, created_at)
  select x.user_id, x.node_id, x.base_id, x.created_at
    from jsonb_populate_recordset(null::public.kb_favorites, t.payload -> 'favorites') x
   where public.kb_existing_user(x.user_id) is not null;
  insert into public.kb_checks (user_id, node_id, base_id, block_id, checked_at)
  select x.user_id, x.node_id, x.base_id, x.block_id, x.checked_at
    from jsonb_populate_recordset(null::public.kb_checks, t.payload -> 'checks') x
   where public.kb_existing_user(x.user_id) is not null;
  -- Снимки до оценок их не знают — coalesce.
  insert into public.kb_ratings (node_id, base_id, user_id, score, version_at, created_at, rated_at)
  select x.node_id, x.base_id, x.user_id, x.score, x.version_at, x.created_at, x.rated_at
    from jsonb_populate_recordset(null::public.kb_ratings, coalesce(t.payload -> 'ratings', '[]')) x
   where public.kb_existing_user(x.user_id) is not null;

  delete from public.kb_trash where id = p_id;
  perform set_config('kb.restoring', '', true);
  return t.root_id;
end;
$$;

-- 3) Статистика поиска для вкладки «Поиск» ---------------------------------------------
-- Те же поля и подсчёт, что в kb_analytics_overview: current/previous
-- (searches, zero_searches), top_queries, zero_queries.
create or replace function public.kb_analytics_search(p_base uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  d_to date := public.kb_today();
  d_from date := public.kb_today() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
  t_from timestamptz := (d_from::timestamp at time zone 'Asia/Tbilisi');
  t_prev timestamptz := ((d_from - days)::timestamp at time zone 'Asia/Tbilisi');
  result jsonb;
begin
  perform public.kb_analytics_guard(p_base);

  with srch as materialized (
    select * from public.kb_search_log s
     where s.base_id = p_base and s.created_at >= t_prev
       and s.user_id in (select user_id from public.kb_base_people(p_base))
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'days', days,
    'current', jsonb_build_object(
      'searches', (select count(*) from srch where created_at >= t_from),
      'zero_searches', (select count(*) from srch where created_at >= t_from and results = 0)
    ),
    'previous', jsonb_build_object(
      'searches', (select count(*) from srch where created_at < t_from),
      'zero_searches', (select count(*) from srch where created_at < t_from and results = 0)
    ),
    'top_queries', (
      select coalesce(jsonb_agg(t order by t.count desc, t.query), '[]') from (
        select query, count(*)::integer as count, count(distinct user_id)::integer as users,
               max(results)::integer as results, count(clicked_node_id)::integer as clicks
          from srch where created_at >= t_from
         group by query order by count(*) desc, query limit 15
      ) t
    ),
    'zero_queries', (
      select coalesce(jsonb_agg(t order by t.count desc, t.last_at desc), '[]') from (
        select query, count(*)::integer as count, count(distinct user_id)::integer as users,
               max(created_at) as last_at
          from srch where created_at >= t_from
         group by query having max(results) = 0
         order by count(*) desc, max(created_at) desc limit 15
      ) t
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.kb_analytics_search(uuid, integer) from public, anon;
grant execute on function public.kb_analytics_search(uuid, integer) to authenticated;

-- 4) Замок шагов «по порядку» — одним проходом ------------------------------------------
-- Шаг закрыт: курс по порядку и до него (в порядке интерфейса) есть
-- непройденный шаг (тест на проверке не держит — проверка может занять время).
create or replace function public.acad_step_locks(_user_id uuid, _course uuid)
returns table (step_id uuid, locked boolean)
language sql
stable
security definer
set search_path = public
as $$
  select st.step_id,
         c.sequential
           and coalesce(bool_or(st.state not in ('done', 'passed', 'review')) over (
                 order by st.sort_order, s.created_at, st.step_id
                 rows between unbounded preceding and 1 preceding), false)
    from public.acad_step_states(_user_id, _course) st
    join public.acad_steps s on s.id = st.step_id
    join public.acad_courses c on c.id = _course
$$;
revoke all on function public.acad_step_locks(uuid, uuid) from public, anon, authenticated;

create or replace function public.acad_step_unlocked(_user_id uuid, _step uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not coalesce((
    select lk.locked
      from public.acad_steps s, public.acad_step_locks(_user_id, s.course_id) lk
     where s.id = _step and lk.step_id = _step
  ), false)
$$;
revoke all on function public.acad_step_unlocked(uuid, uuid) from public, anon, authenticated;

create or replace function public.acad_course_view(p_course uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.acad_courses;
  learner boolean;
  r record;
begin
  select * into c from public.acad_courses where id = p_course;
  if not found then
    raise exception 'acad_not_found';
  end if;
  learner := p_course = any (public.acad_user_course_ids(auth.uid()));
  if not learner and not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  if learner then
    perform public.acad_touch(auth.uid(), p_course);
  end if;
  select * into r from public.acad_progress_rows(p_course, auth.uid()) limit 1;
  return jsonb_build_object(
    'course', jsonb_build_object(
      'id', c.id, 'title', c.title, 'description', c.description, 'cover', c.cover,
      'status', c.status, 'sequential', c.sequential, 'pass_percent', c.pass_percent,
      'folder_title', (select title from public.acad_folders where id = c.folder_id)),
    'learner', learner,
    'due_date', r.due_date,
    'started_at', r.started_at,
    'completed_at', r.completed_at,
    'overdue', coalesce(r.overdue, false),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', st.step_id, 'kind', st.kind, 'title', st.title,
               'state', case when learner then st.state else 'todo' end,
               'attempts', st.attempts, 'last_attempt_id', st.last_attempt_id,
               'last_percent', st.last_percent, 'questions', st.questions,
               'pass_percent', st.pass_percent,
               'locked', learner and coalesce(lk.locked, false))
             order by st.sort_order, s.created_at, st.step_id)
        from public.acad_step_states(auth.uid(), p_course) st
        join public.acad_steps s on s.id = st.step_id
        left join public.acad_step_locks(auth.uid(), p_course) lk on lk.step_id = st.step_id),
      '[]'::jsonb)
  );
end;
$$;

-- 5) Свои ответы не проверяют ------------------------------------------------------------
create or replace function public.acad_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'is_admin', public.kb_is_admin(auth.uid()),
    'can_create', public.acad_can_create(auth.uid()),
    'can_review', public.acad_can_review(auth.uid()),
    'my_courses', cardinality(public.acad_user_course_ids(auth.uid())),
    'my_open', (
      select count(*) from unnest(public.acad_user_course_ids(auth.uid())) c(id)
       where not exists (select 1 from public.acad_enrollments e
                          where e.course_id = c.id and e.user_id = auth.uid()
                            and e.completed_at is not null)),
    'to_review', case when public.acad_can_review(auth.uid())
                      then (select count(*) from public.acad_attempts
                             where status = 'review' and user_id <> auth.uid())
                      else 0 end
  )
$$;

create or replace function public.acad_review_queue()
returns table (
  attempt_id uuid, user_id uuid, full_name text, avatar_url text, course_id uuid,
  course_title text, step_title text, attempt_no integer, submitted_at timestamptz,
  open_answers integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_can_review(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select a.id, a.user_id, p.full_name, p.avatar_url, a.course_id, c.title, s.title, a.attempt_no,
         a.submitted_at,
         (select count(*)::int from public.acad_answers an where an.attempt_id = a.id and an.correct is null)
    from public.acad_attempts a
    join public.acad_courses c on c.id = a.course_id
    join public.acad_steps s on s.id = a.step_id
    left join public.profiles p on p.id = a.user_id
   where a.status = 'review' and a.user_id <> auth.uid()
   order by a.submitted_at;
end;
$$;

create or replace function public.acad_review_submit(p_attempt uuid, p_grades jsonb, p_comment text default '')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.acad_attempts;
  g jsonb;
  an public.acad_answers;
  total numeric;
  got numeric;
  st text;
begin
  if not public.acad_can_review(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  select * into t from public.acad_attempts where id = p_attempt for update;
  if not found then
    raise exception 'acad_not_found';
  end if;
  if t.user_id = auth.uid() then
    raise exception 'acad_own_attempt';
  end if;
  if t.status <> 'review' then
    raise exception 'acad_not_in_review';
  end if;
  for g in select * from jsonb_array_elements(coalesce(p_grades, '[]'::jsonb)) loop
    select * into an from public.acad_answers
     where id = (g ->> 'answer_id')::uuid and attempt_id = p_attempt;
    if not found then
      raise exception 'acad_not_found';
    end if;
    if an.correct is null then
      if g -> 'correct' is null or jsonb_typeof(g -> 'correct') <> 'boolean' then
        raise exception 'acad_incomplete';
      end if;
      update public.acad_answers
         set correct = (g ->> 'correct')::boolean,
             score = case when (g ->> 'correct')::boolean then (question ->> 'points')::numeric else 0 end,
             comment = left(coalesce(g ->> 'comment', ''), 2000),
             reviewed_by = auth.uid(), reviewed_at = now()
       where id = an.id;
    elsif g ? 'comment' and not an.carried then
      update public.acad_answers set comment = left(coalesce(g ->> 'comment', ''), 2000),
             reviewed_by = auth.uid(), reviewed_at = now()
       where id = an.id;
    end if;
  end loop;
  if exists (select 1 from public.acad_answers where attempt_id = p_attempt and correct is null) then
    raise exception 'acad_incomplete';
  end if;
  select coalesce(sum(score), 0), coalesce(sum((question ->> 'points')::numeric), 0)
    into got, total
    from public.acad_answers where attempt_id = p_attempt;
  st := case when total > 0 and got * 100 / total >= t.pass_percent then 'passed' else 'failed' end;
  update public.acad_attempts
     set score = got, max_score = total,
         percent = case when total > 0 then round(got * 100 / total, 1) else 0 end,
         status = st, reviewed_by = auth.uid(), reviewed_at = now(),
         review_comment = left(coalesce(p_comment, ''), 4000)
   where id = p_attempt;
  perform public.acad_touch(t.user_id, t.course_id);
  return st;
end;
$$;

notify pgrst, 'reload schema';
