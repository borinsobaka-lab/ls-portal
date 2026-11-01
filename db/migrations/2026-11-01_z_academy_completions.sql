-- «Академия»: проверяющим — кто прошёл курс (решение владельца 2026-11-01).
--
-- Раньше проверяющий видел только ответы, ждущие проверки (тесты со
-- свободными ответами); что сотрудник прошёл курс целиком, нигде не
-- сообщалось. Теперь в «Проверке» — вкладка «Пройденные курсы»: прохождения
-- за 90 дней с итогами тестов, у каждого проверяющего своя отметка
-- «просмотрено». Непросмотренные за 30 дней — счётчик `new_completions` в
-- `acad_access` (значок рейки и пункта «Проверка»). Свои прохождения
-- проверяющему не показываются (как и свои ответы в очереди проверки).
--
-- Прохождение — `acad_enrollments.completed_at` (ставит `acad_touch`, не
-- снимается). Таблица отметок закрыта браузеру: только RPC.

create table if not exists public.acad_completion_seen (
  viewer_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (viewer_id, course_id, user_id)
);
alter table public.acad_completion_seen enable row level security;
revoke all on public.acad_completion_seen from public, anon, authenticated;

create index if not exists acad_enrollments_completed_idx
  on public.acad_enrollments (completed_at desc) where completed_at is not null;

-- Прохождения за 90 дней: курс, сотрудник, когда, итоги тестов (последняя
-- попытка каждого теста курса), просмотрено ли этим проверяющим, «новое» —
-- не просмотрено и не старше 30 дней.
create or replace function public.acad_completions()
returns table (
  course_id uuid, course_title text, user_id uuid, full_name text, avatar_url text,
  completed_at timestamptz, seen boolean, is_new boolean, avg_percent numeric, tests jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if not public.acad_can_review(uid) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select e.course_id, c.title, e.user_id, p.full_name, p.avatar_url, e.completed_at,
         (v.viewer_id is not null),
         (v.viewer_id is null and e.completed_at > now() - interval '30 days'),
         t.avg_percent,
         coalesce(t.tests, '[]'::jsonb)
    from public.acad_enrollments e
    join public.acad_courses c on c.id = e.course_id
    left join public.profiles p on p.id = e.user_id
    left join public.acad_completion_seen v
      on v.viewer_id = uid and v.course_id = e.course_id and v.user_id = e.user_id
    left join lateral (
      select avg(l.percent) avg_percent,
             jsonb_agg(jsonb_build_object(
               'step_id', l.step_id, 'step_title', l.title, 'attempt_id', l.id,
               'attempt_no', l.attempt_no, 'status', l.status, 'percent', l.percent,
               'submitted_at', l.submitted_at) order by l.sort_order, l.created_at) tests
        from (
          select distinct on (a.step_id) a.step_id, a.id, a.attempt_no, a.status, a.percent,
                 a.submitted_at, s.title, s.sort_order, s.created_at
            from public.acad_attempts a
            join public.acad_steps s on s.id = a.step_id
           where a.course_id = e.course_id and a.user_id = e.user_id
           order by a.step_id, a.attempt_no desc
        ) l
    ) t on true
   where e.completed_at is not null
     and e.completed_at > now() - interval '90 days'
     and e.user_id <> uid
   order by e.completed_at desc;
end;
$$;

-- Отметить прохождение просмотренным (null, null — все за 90 дней).
create or replace function public.acad_completion_mark_seen(p_course uuid default null, p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if not public.acad_can_review(uid) then
    raise exception 'acad_forbidden';
  end if;
  insert into public.acad_completion_seen (viewer_id, course_id, user_id)
  select uid, e.course_id, e.user_id
    from public.acad_enrollments e
   where e.completed_at is not null
     and e.user_id <> uid
     and (p_course is null or e.course_id = p_course)
     and (p_user is null or e.user_id = p_user)
     and (p_course is not null and p_user is not null
          or e.completed_at > now() - interval '90 days')
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Права и счётчики для рейки и меню: + new_completions (прежнее определение —
-- 2026-10-25_zzzzzzzzzzzz_access_roles.sql, остальное без изменений).
create or replace function public.acad_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'is_admin', public.acad_is_admin(auth.uid()),
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
                      else 0 end,
    'new_completions', case when public.acad_can_review(auth.uid())
                      then (select count(*) from public.acad_enrollments e
                             where e.completed_at > now() - interval '30 days'
                               and e.user_id <> auth.uid()
                               and not exists (
                                 select 1 from public.acad_completion_seen v
                                  where v.viewer_id = auth.uid() and v.course_id = e.course_id
                                    and v.user_id = e.user_id))
                      else 0 end
  )
$$;

revoke all on function public.acad_completions(), public.acad_completion_mark_seen(uuid, uuid)
  from public, anon;
grant execute on function public.acad_completions(), public.acad_completion_mark_seen(uuid, uuid)
  to authenticated;
