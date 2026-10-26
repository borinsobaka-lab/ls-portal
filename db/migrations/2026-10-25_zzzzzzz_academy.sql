-- ============================================================================
-- «Академия» — курсы, тесты, проверка тренером (решение владельца 2026-10-25;
-- план и решения — ACADEMY.md, требования — бриф сотрудников, №58–69).
--
-- Отдельный раздел админки, не часть базы знаний: курсы общие для сети
-- (без studio_id, как базы знаний).
--
-- Права (решение владельца: «две галочки» в «Доступах» — acad_staff):
--   * владелец (owner хоть в одной студии) — всё (администратор обучения);
--   * «Создаёт курсы» (can_create) — каталог, конструктор, назначения,
--     отчёты;
--   * «Проверяет ответы» (can_review) — открытые ответы учеников, отчёты;
--   * ученик — сотрудник, которому курс назначен; отдельного права нет.
--   По умолчанию закрыто (в отличие от разделов рейки admin_permissions,
--   где «нет строки — открыто всё»), без роли сотрудника права не действуют.
--
-- Назначение (решение владельца: «людям и ролям»): acad_assignments — либо
-- конкретному сотруднику, либо правило «роль owner/admin/trainer в клубах …»
-- (пустой список — во всех клубах): новый сотрудник с такой ролью получает
-- курс сам. Срок — датой или «N дней с назначения» (для правила — с выдачи
-- роли, если она позже правила). Курс видят ученики, пока он опубликован.
--
-- Урок из статьи базы знаний (решение владельца: «копией + Обновить») —
-- текст и файлы статьи копируются в урок (source_node_id /
-- source_published_at — какая версия); статья опубликована заново — в
-- конструкторе «Статья изменилась» (acad_course_sources), «Обновить» копирует
-- снова. Правка урока после правки вопросов теста — напоминание проверить
-- вопросы (№65): acad_steps.content_updated_at / questions_updated_at.
--
-- Прохождение: урок — «Прошёл» (acad_lesson_done); тест — попытка
-- (acad_attempts) с ответами (acad_answers, снимок вопроса — ответы
-- остаются и после правки или удаления вопроса, №63 «сохранять все
-- ответы»). Закрытые вопросы проверяет база, открытые — проверяющий
-- (acad_review_submit), комментарий к ошибке. Пересдача — только вопросы с
-- ошибкой, верные переносятся (№63). Правильные ответы ученику не уходят:
-- вопросы он получает только через acad_quiz_start (без отметок «верный»),
-- таблицы вопросов ему закрыты.
--
-- Файлы — бакет kb-media, папка academy/: academy/<курс>/… — уроки и
-- обложка (читают создатели, проверяющие и ученики курса, пишут создатели),
-- academy/answers/<сотрудник>/… — файлы к ответам (пишет сам ученик).
-- kb_file_gc_candidates и kb_storage_usage переопределены здесь: ссылки
-- `kbfile:` ищутся и в Академии, место — отдельной строкой.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы ---------------------------------------------------------------------
create table if not exists public.acad_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_create boolean not null default false,
  can_review boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.acad_folders (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.acad_courses (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references public.acad_folders(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  -- Обложка: `kbfile:academy/<курс>/<файл>`.
  cover text check (cover is null or cover like 'kbfile:academy/%'),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- Шаги по порядку: следующий открывается, когда пройден предыдущий.
  sequential boolean not null default true,
  -- Проходной процент тестов курса (у теста может быть свой).
  pass_percent integer not null default 80 check (pass_percent between 1 and 100),
  sort_order integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists acad_courses_folder_idx on public.acad_courses (folder_id, sort_order);

create table if not exists public.acad_steps (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  kind text not null check (kind in ('lesson', 'quiz')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- Урок — документ редактора BlockNote (как статья базы знаний).
  content jsonb,
  sort_order integer,
  -- Урок из статьи: какая статья и с какой её публикации скопирован.
  source_node_id uuid references public.kb_nodes(id) on delete set null,
  source_published_at timestamptz,
  -- Тест: свой проходной процент (null — курса).
  pass_percent integer check (pass_percent is null or pass_percent between 1 and 100),
  content_updated_at timestamptz,
  questions_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists acad_steps_course_idx on public.acad_steps (course_id, sort_order);
create index if not exists acad_steps_source_idx on public.acad_steps (source_node_id)
  where source_node_id is not null;

create table if not exists public.acad_questions (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references public.acad_steps(id) on delete cascade,
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  sort_order integer,
  kind text not null check (kind in ('single', 'multiple', 'open')),
  text text not null check (char_length(btrim(text)) between 1 and 2000),
  -- [{id, text, correct}] — варианты закрытого вопроса; у открытого — [].
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  points integer not null default 1 check (points between 1 and 100),
  -- Открытый вопрос: можно приложить файл к ответу.
  allow_file boolean not null default false,
  -- Пояснение — ученик видит его у вопроса, где ошибся.
  explanation text not null default '' check (char_length(explanation) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists acad_questions_step_idx on public.acad_questions (step_id, sort_order);

create table if not exists public.acad_assignments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  subject_type text not null check (subject_type in ('user', 'role')),
  user_id uuid references auth.users(id) on delete cascade,
  role text check (role in ('owner', 'admin', 'trainer')),
  -- Правило по роли: в каких клубах; пусто — во всех.
  studio_ids uuid[] not null default '{}',
  due_date date,
  due_days integer check (due_days is null or due_days between 1 and 365),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (subject_type = 'user' and user_id is not null and role is null)
    or (subject_type = 'role' and role is not null and user_id is null)
  ),
  check (due_date is null or due_days is null)
);
create index if not exists acad_assignments_course_idx on public.acad_assignments (course_id);
create unique index if not exists acad_assignments_user_uidx
  on public.acad_assignments (course_id, user_id) where subject_type = 'user';
create index if not exists acad_assignments_user_idx on public.acad_assignments (user_id)
  where subject_type = 'user';

-- Ученик открыл курс: когда начал, закончил, последний раз что-то делал.
create table if not exists public.acad_enrollments (
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_activity_at timestamptz not null default now(),
  primary key (course_id, user_id)
);
create index if not exists acad_enrollments_user_idx on public.acad_enrollments (user_id);

create table if not exists public.acad_lesson_done (
  step_id uuid not null references public.acad_steps(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  done_at timestamptz not null default now(),
  primary key (step_id, user_id)
);
create index if not exists acad_lesson_done_course_idx on public.acad_lesson_done (course_id, user_id);

create table if not exists public.acad_attempts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.acad_courses(id) on delete cascade,
  step_id uuid not null references public.acad_steps(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_no integer not null,
  status text not null check (status in ('review', 'passed', 'failed')),
  score numeric not null default 0,
  max_score numeric not null default 0,
  percent numeric not null default 0,
  pass_percent integer not null,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text not null default '' check (char_length(review_comment) <= 4000),
  unique (step_id, user_id, attempt_no)
);
create index if not exists acad_attempts_course_idx on public.acad_attempts (course_id, user_id);
create index if not exists acad_attempts_review_idx on public.acad_attempts (submitted_at)
  where status = 'review';

create table if not exists public.acad_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.acad_attempts(id) on delete cascade,
  question_id uuid references public.acad_questions(id) on delete set null,
  -- Снимок вопроса на момент ответа: kind, text, options, points, explanation, sort.
  question jsonb not null,
  -- {options: [id…], text, file: 'kbfile:academy/answers/<сотрудник>/…'}.
  answer jsonb not null default '{}'::jsonb,
  -- null — ждёт проверки (открытый вопрос).
  correct boolean,
  score numeric,
  comment text not null default '' check (char_length(comment) <= 2000),
  -- Перенесён из прошлой попытки (верный — при пересдаче не спрашивается).
  carried boolean not null default false,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz
);
create index if not exists acad_answers_attempt_idx on public.acad_answers (attempt_id);
create index if not exists acad_answers_question_idx on public.acad_answers (question_id);

-- 2) Права -----------------------------------------------------------------------
create or replace function public.acad_can_create(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.kb_is_admin(_user_id)
      or (public.is_staff(_user_id)
          and exists (select 1 from public.acad_staff where user_id = _user_id and can_create))
$$;

create or replace function public.acad_can_review(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.kb_is_admin(_user_id)
      or (public.is_staff(_user_id)
          and exists (select 1 from public.acad_staff where user_id = _user_id and can_review))
$$;

-- Создатель или проверяющий — видит каталог и отчёты.
create or replace function public.acad_is_team(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.acad_can_create(_user_id) or public.acad_can_review(_user_id)
$$;

-- Ученики курсов: (курс, сотрудник, с какого времени назначен, срок).
-- p_course / p_user — сузить. Внутренняя: наружу не выдана.
create or replace function public.acad_pairs(p_course uuid default null, p_user uuid default null)
returns table (course_id uuid, user_id uuid, assigned_at timestamptz, due_date date)
language sql
stable
security definer
set search_path = public
as $$
  with a as (
    select * from public.acad_assignments x where p_course is null or x.course_id = p_course
  ),
  raw as (
    select a.course_id, a.user_id, a.created_at as assigned_at, a.due_date, a.due_days
      from a
     where a.subject_type = 'user' and (p_user is null or a.user_id = p_user)
    union all
    select a.course_id, r.user_id, greatest(a.created_at, min(r.created_at)), a.due_date, a.due_days
      from a
      join public.user_roles r
        on r.role::text = a.role
       and (cardinality(a.studio_ids) = 0 or r.studio_id = any (a.studio_ids))
     where a.subject_type = 'role' and (p_user is null or r.user_id = p_user)
     group by a.id, a.course_id, r.user_id, a.created_at, a.due_date, a.due_days
  )
  select raw.course_id, raw.user_id, min(raw.assigned_at),
         min(coalesce(raw.due_date,
                      case when raw.due_days is not null
                           then (raw.assigned_at at time zone 'Asia/Tbilisi')::date + raw.due_days end))
    from raw
   where public.is_staff(raw.user_id)
   group by raw.course_id, raw.user_id
$$;

-- Опубликованные курсы, назначенные сотруднику.
create or replace function public.acad_user_course_ids(_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct a.course_id), '{}')
    from public.acad_assignments a
    join public.acad_courses c on c.id = a.course_id and c.status = 'published'
   where public.is_staff(_user_id)
     and (
       (a.subject_type = 'user' and a.user_id = _user_id)
       or (a.subject_type = 'role' and exists (
             select 1 from public.user_roles r
              where r.user_id = _user_id and r.role::text = a.role
                and (cardinality(a.studio_ids) = 0 or r.studio_id = any (a.studio_ids))))
     )
$$;

revoke all on function public.acad_can_create(uuid), public.acad_can_review(uuid),
  public.acad_is_team(uuid), public.acad_user_course_ids(uuid) from public, anon;
grant execute on function public.acad_can_create(uuid), public.acad_can_review(uuid),
  public.acad_is_team(uuid), public.acad_user_course_ids(uuid) to authenticated, service_role;
revoke all on function public.acad_pairs(uuid, uuid) from public, anon, authenticated;

-- 3) Триггеры ------------------------------------------------------------------
create or replace function public.acad_courses_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    if new.sort_order is null then
      select coalesce(max(sort_order), 0) + 1 into new.sort_order
        from public.acad_courses where folder_id is not distinct from new.folder_id;
    end if;
  end if;
  if new.cover is not null and new.cover not like 'kbfile:academy/' || new.id || '/%' then
    raise exception 'acad_bad_cover';
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    new.published_at := now();
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists acad_courses_biu on public.acad_courses;
create trigger acad_courses_biu
  before insert or update on public.acad_courses
  for each row execute function public.acad_courses_biu();

-- Удалённый курс — его папка файлов в очередь стирания (разбирает сервер админки).
create or replace function public.acad_courses_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kb_file_purge (folder) values ('academy/' || old.id);
  return old;
end;
$$;
drop trigger if exists acad_courses_ad on public.acad_courses;
create trigger acad_courses_ad
  after delete on public.acad_courses
  for each row execute function public.acad_courses_ad();

create or replace function public.acad_steps_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.course_id <> old.course_id then
    raise exception 'acad_course_immutable';
  end if;
  if tg_op = 'UPDATE' and new.kind <> old.kind then
    raise exception 'acad_kind_immutable';
  end if;
  if new.kind = 'quiz' then
    new.content := null;
    new.source_node_id := null;
    new.source_published_at := null;
  else
    new.pass_percent := null;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.sort_order is null then
      select coalesce(max(sort_order), 0) + 1 into new.sort_order
        from public.acad_steps where course_id = new.course_id;
    end if;
    if new.kind = 'lesson' then new.content_updated_at := now(); end if;
  elsif new.content is distinct from old.content then
    new.content_updated_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists acad_steps_biu on public.acad_steps;
create trigger acad_steps_biu
  before insert or update on public.acad_steps
  for each row execute function public.acad_steps_biu();

-- Вопрос: курс — как у теста, варианты — по виду вопроса.
create or replace function public.acad_questions_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
  n_opts integer;
  n_correct integer;
begin
  select * into s from public.acad_steps where id = new.step_id;
  if not found or s.kind <> 'quiz' then
    raise exception 'acad_not_quiz';
  end if;
  new.course_id := s.course_id;
  if new.kind = 'open' then
    new.options := '[]'::jsonb;
  else
    new.allow_file := false;
    select count(*),
           count(*) filter (where coalesce((o ->> 'correct')::boolean, false))
      into n_opts, n_correct
      from jsonb_array_elements(new.options) o;
    if n_opts < 2 or n_opts > 20 then
      raise exception 'acad_bad_options';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.options) o
       where coalesce(btrim(o ->> 'text'), '') = '' or coalesce(o ->> 'id', '') = ''
    ) then
      raise exception 'acad_bad_options';
    end if;
    if (select count(distinct o ->> 'id') from jsonb_array_elements(new.options) o) <> n_opts then
      raise exception 'acad_bad_options';
    end if;
    if (new.kind = 'single' and n_correct <> 1) or (new.kind = 'multiple' and n_correct < 1) then
      raise exception 'acad_bad_correct';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.sort_order is null then
      select coalesce(max(sort_order), 0) + 1 into new.sort_order
        from public.acad_questions where step_id = new.step_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists acad_questions_biu on public.acad_questions;
create trigger acad_questions_biu
  before insert or update on public.acad_questions
  for each row execute function public.acad_questions_biu();

-- Правка вопросов — отметка у теста (напоминание «урок изменился после вопросов»).
create or replace function public.acad_questions_aiud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.acad_steps set questions_updated_at = now()
   where id = coalesce(new.step_id, old.step_id);
  return null;
end;
$$;
drop trigger if exists acad_questions_aiud on public.acad_questions;
create trigger acad_questions_aiud
  after insert or update or delete on public.acad_questions
  for each row execute function public.acad_questions_aiud();

create or replace function public.acad_assignments_bi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  if new.subject_type = 'role' then
    new.studio_ids := coalesce(new.studio_ids, '{}');
  else
    new.studio_ids := '{}';
  end if;
  return new;
end;
$$;
drop trigger if exists acad_assignments_bi on public.acad_assignments;
create trigger acad_assignments_bi
  before insert on public.acad_assignments
  for each row execute function public.acad_assignments_bi();

-- 4) RLS -------------------------------------------------------------------------
revoke all on public.acad_staff, public.acad_folders, public.acad_courses, public.acad_steps,
  public.acad_questions, public.acad_assignments, public.acad_enrollments,
  public.acad_lesson_done, public.acad_attempts, public.acad_answers from anon, authenticated;
grant select on public.acad_staff, public.acad_enrollments, public.acad_lesson_done,
  public.acad_attempts, public.acad_answers to authenticated;
grant select, insert, update, delete on public.acad_folders, public.acad_courses,
  public.acad_steps, public.acad_questions, public.acad_assignments to authenticated;
grant all on public.acad_staff, public.acad_folders, public.acad_courses, public.acad_steps,
  public.acad_questions, public.acad_assignments, public.acad_enrollments,
  public.acad_lesson_done, public.acad_attempts, public.acad_answers to service_role;

alter table public.acad_staff enable row level security;
alter table public.acad_folders enable row level security;
alter table public.acad_courses enable row level security;
alter table public.acad_steps enable row level security;
alter table public.acad_questions enable row level security;
alter table public.acad_assignments enable row level security;
alter table public.acad_enrollments enable row level security;
alter table public.acad_lesson_done enable row level security;
alter table public.acad_attempts enable row level security;
alter table public.acad_answers enable row level security;

-- Свои права — рейке и меню; все — владельцу. Пишет сервер «Доступов».
drop policy if exists "acad_staff read" on public.acad_staff;
create policy "acad_staff read" on public.acad_staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.kb_is_admin(auth.uid())));

do $$
declare
  t text;
begin
  foreach t in array array['acad_folders', 'acad_courses', 'acad_steps', 'acad_questions',
                           'acad_assignments'] loop
    execute format('drop policy if exists "%1$s team read" on public.%1$I', t);
    execute format(
      'create policy "%1$s team read" on public.%1$I for select to authenticated
         using ((select public.acad_is_team(auth.uid())))', t);
    execute format('drop policy if exists "%1$s creator write" on public.%1$I', t);
    execute format(
      'create policy "%1$s creator write" on public.%1$I for all to authenticated
         using ((select public.acad_can_create(auth.uid())))
         with check ((select public.acad_can_create(auth.uid())))', t);
  end loop;

  -- Прохождение: своё — ученику, всё — команде. Пишут только RPC.
  foreach t in array array['acad_enrollments', 'acad_lesson_done', 'acad_attempts'] loop
    execute format('drop policy if exists "%1$s read" on public.%1$I', t);
    execute format(
      'create policy "%1$s read" on public.%1$I for select to authenticated
         using (user_id = (select auth.uid()) or (select public.acad_is_team(auth.uid())))', t);
  end loop;
end $$;

-- Ответы: только команде — в снимке вопроса отмечены верные варианты; ученик
-- видит свои ответы через acad_attempt (без отметок).
drop policy if exists "acad_answers team read" on public.acad_answers;
create policy "acad_answers team read" on public.acad_answers
  for select to authenticated
  using ((select public.acad_is_team(auth.uid())));

-- 5) Файлы: бакет kb-media, папка academy/ -----------------------------------------
drop policy if exists "academy read" on storage.objects;
create policy "academy read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'academy'
    and (
      (select public.acad_is_team(auth.uid()))
      or (storage.foldername(name))[2] = any ((select public.acad_user_course_ids(auth.uid()))::text[])
      or ((storage.foldername(name))[2] = 'answers'
          and (storage.foldername(name))[3] = (select auth.uid())::text)
    )
  );

drop policy if exists "academy insert" on storage.objects;
create policy "academy insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'academy'
    and (
      ((storage.foldername(name))[2] <> 'answers' and (select public.acad_can_create(auth.uid())))
      or ((storage.foldername(name))[2] = 'answers'
          and (storage.foldername(name))[3] = (select auth.uid())::text
          and (select public.is_staff(auth.uid())))
    )
  );

drop policy if exists "academy update" on storage.objects;
create policy "academy update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'academy'
    and (storage.foldername(name))[2] <> 'answers'
    and (select public.acad_can_create(auth.uid()))
  )
  with check (
    bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'academy'
    and (storage.foldername(name))[2] <> 'answers'
    and (select public.acad_can_create(auth.uid()))
  );

drop policy if exists "academy delete" on storage.objects;
create policy "academy delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'academy'
    and (storage.foldername(name))[2] <> 'answers'
    and (select public.acad_can_create(auth.uid()))
  );

-- 6) Прохождение ----------------------------------------------------------------
-- Состояние шагов курса у сотрудника: урок — done/todo, тест —
-- passed (есть сданная попытка) / review / failed (последняя) / todo.
create or replace function public.acad_step_states(_user_id uuid, _course uuid)
returns table (
  step_id uuid, kind text, sort_order integer, title text, state text,
  attempts integer, last_attempt_id uuid, last_percent numeric, questions integer,
  pass_percent integer
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.sort_order, s.title,
         case
           when s.kind = 'lesson' then
             case when exists (select 1 from public.acad_lesson_done d
                                where d.step_id = s.id and d.user_id = _user_id)
                  then 'done' else 'todo' end
           when exists (select 1 from public.acad_attempts a
                         where a.step_id = s.id and a.user_id = _user_id and a.status = 'passed')
             then 'passed'
           else coalesce(la.status, 'todo')
         end,
         coalesce((select count(*)::int from public.acad_attempts a
                    where a.step_id = s.id and a.user_id = _user_id), 0),
         la.id, la.percent,
         (select count(*)::int from public.acad_questions q where q.step_id = s.id),
         case when s.kind = 'quiz' then coalesce(s.pass_percent, c.pass_percent) end
    from public.acad_steps s
    join public.acad_courses c on c.id = s.course_id
    left join lateral (
      select a.id, a.status, a.percent from public.acad_attempts a
       where a.step_id = s.id and a.user_id = _user_id
       order by a.attempt_no desc limit 1
    ) la on true
   where s.course_id = _course
   order by s.sort_order, s.created_at
$$;
revoke all on function public.acad_step_states(uuid, uuid) from public, anon, authenticated;

-- Шаг открыт: курс не по порядку или все шаги до него пройдены (тест на
-- проверке не держит — проверка может занять время).
create or replace function public.acad_step_unlocked(_user_id uuid, _step uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not c.sequential or not exists (
    select 1 from public.acad_step_states(_user_id, s.course_id) st
     where (st.sort_order, st.step_id::text) < (s.sort_order, s.id::text)
       and st.state not in ('done', 'passed', 'review')
  )
    from public.acad_steps s join public.acad_courses c on c.id = s.course_id
   where s.id = _step
$$;
revoke all on function public.acad_step_unlocked(uuid, uuid) from public, anon, authenticated;

-- Курс пройден (все шаги) — отметить; дальше отметка не снимается.
create or replace function public.acad_touch(_user_id uuid, _course uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.acad_enrollments (course_id, user_id) values (_course, _user_id)
  on conflict (course_id, user_id) do update set last_activity_at = now();
  if exists (select 1 from public.acad_steps where course_id = _course)
     and not exists (
       select 1 from public.acad_step_states(_user_id, _course)
        where state not in ('done', 'passed')
     ) then
    update public.acad_enrollments set completed_at = coalesce(completed_at, now())
     where course_id = _course and user_id = _user_id;
  end if;
end;
$$;
revoke all on function public.acad_touch(uuid, uuid) from public, anon, authenticated;

-- Права и счётчики для рейки и меню.
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
                      then (select count(*) from public.acad_attempts where status = 'review')
                      else 0 end
  )
$$;

-- Ход курсов (курс × ученик). Внутренняя: её зовут RPC ниже после проверки прав.
create or replace function public.acad_progress_rows(p_course uuid default null, p_user uuid default null)
returns table (
  course_id uuid, user_id uuid, assigned_at timestamptz, due_date date,
  started_at timestamptz, completed_at timestamptz, last_activity_at timestamptz,
  steps_total integer, steps_done integer, in_review boolean, attempts integer,
  avg_percent numeric, status text, overdue boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with p as (select * from public.acad_pairs(p_course, p_user)),
  steps as (
    select s.course_id, s.id from public.acad_steps s
     where s.course_id in (select distinct p.course_id from p)
  ),
  tot as (select steps.course_id, count(*)::int n from steps group by steps.course_id),
  lessons as (
    select d.course_id, d.user_id, count(*)::int n
      from public.acad_lesson_done d join steps on steps.id = d.step_id
     where p_user is null or d.user_id = p_user
     group by d.course_id, d.user_id
  ),
  att as (
    select a.course_id, a.user_id, a.step_id, a.status, a.percent,
           a.attempt_no = max(a.attempt_no) over (partition by a.user_id, a.step_id) as is_last
      from public.acad_attempts a join steps on steps.id = a.step_id
     where p_user is null or a.user_id = p_user
  ),
  quiz as (
    select att.course_id, att.user_id,
           count(distinct att.step_id) filter (where att.status = 'passed')::int passed,
           coalesce(bool_or(att.status = 'review' and att.is_last), false) in_review,
           count(*)::int attempts,
           avg(att.percent) filter (where att.is_last and att.status <> 'review') avg_pct
      from att
     group by att.course_id, att.user_id
  )
  select p.course_id, p.user_id, p.assigned_at, p.due_date,
         e.started_at, e.completed_at, e.last_activity_at,
         coalesce(tot.n, 0), coalesce(l.n, 0) + coalesce(q.passed, 0),
         coalesce(q.in_review, false), coalesce(q.attempts, 0), round(q.avg_pct, 1),
         case when e.completed_at is not null then 'completed'
              when coalesce(q.in_review, false) then 'review'
              when e.started_at is not null then 'in_progress'
              else 'not_started' end,
         e.completed_at is null and p.due_date is not null and p.due_date < public.kb_today()
    from p
    left join public.acad_enrollments e on e.course_id = p.course_id and e.user_id = p.user_id
    left join tot on tot.course_id = p.course_id
    left join lessons l on l.course_id = p.course_id and l.user_id = p.user_id
    left join quiz q on q.course_id = p.course_id and q.user_id = p.user_id
$$;
revoke all on function public.acad_progress_rows(uuid, uuid) from public, anon, authenticated;

-- «Мои курсы»: назначенные опубликованные курсы и ход по ним.
create or replace function public.acad_my_courses()
returns table (
  course_id uuid, title text, description text, cover text, folder_title text,
  due_date date, started_at timestamptz, completed_at timestamptz,
  steps_total integer, steps_done integer, status text, overdue boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.title, c.description, c.cover, f.title, r.due_date, r.started_at, r.completed_at,
         r.steps_total, r.steps_done, r.status, r.overdue
    from public.acad_progress_rows(null, auth.uid()) r
    join public.acad_courses c on c.id = r.course_id and c.status = 'published'
    left join public.acad_folders f on f.id = c.folder_id
   order by (r.completed_at is not null), r.overdue desc, r.due_date nulls last, c.title
$$;

-- Курс для прохождения: шаги и их состояние. Ученик — назначенный курс
-- (открытие записывает начало), команда — просмотр любого курса.
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
               'locked', learner and not public.acad_step_unlocked(auth.uid(), st.step_id))
             order by st.sort_order)
        from public.acad_step_states(auth.uid(), p_course) st), '[]'::jsonb)
  );
end;
$$;

-- Урок: текст. Ученику — только открытый шаг назначенного курса.
create or replace function public.acad_lesson(p_step uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
begin
  select * into s from public.acad_steps where id = p_step and kind = 'lesson';
  if not found then
    raise exception 'acad_not_found';
  end if;
  if not public.acad_is_team(auth.uid()) then
    if not (s.course_id = any (public.acad_user_course_ids(auth.uid()))) then
      raise exception 'acad_forbidden';
    end if;
    if not public.acad_step_unlocked(auth.uid(), p_step) then
      raise exception 'acad_locked';
    end if;
  end if;
  return jsonb_build_object('id', s.id, 'title', s.title, 'content', s.content,
                            'course_id', s.course_id);
end;
$$;

create or replace function public.acad_lesson_complete(p_step uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
begin
  select * into s from public.acad_steps where id = p_step and kind = 'lesson';
  if not found then
    raise exception 'acad_not_found';
  end if;
  if not (s.course_id = any (public.acad_user_course_ids(auth.uid()))) then
    raise exception 'acad_forbidden';
  end if;
  if not public.acad_step_unlocked(auth.uid(), p_step) then
    raise exception 'acad_locked';
  end if;
  insert into public.acad_lesson_done (step_id, user_id, course_id)
  values (p_step, auth.uid(), s.course_id)
  on conflict do nothing;
  perform public.acad_touch(auth.uid(), s.course_id);
end;
$$;

-- Вопросы, которые осталось ответить: все, а после неудачной попытки — те, в
-- которых ошибся (и новые с тех пор). Верные из последней попытки переносятся.
create or replace function public.acad_quiz_pending(_user_id uuid, _step uuid)
returns setof public.acad_questions
language sql
stable
security definer
set search_path = public
as $$
  select q.* from public.acad_questions q
   where q.step_id = _step
     and not exists (
       select 1 from public.acad_answers an
        where an.question_id = q.id and an.correct
          and an.attempt_id = (
            select a.id from public.acad_attempts a
             where a.step_id = _step and a.user_id = _user_id
             order by a.attempt_no desc limit 1))
   order by q.sort_order, q.created_at
$$;
revoke all on function public.acad_quiz_pending(uuid, uuid) from public, anon, authenticated;

-- Проверки перед тестом. Возвращает шаг.
create or replace function public.acad_quiz_guard(_user_id uuid, _step uuid, _preview boolean)
returns public.acad_steps
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
  last_status text;
begin
  select * into s from public.acad_steps where id = _step and kind = 'quiz';
  if not found then
    raise exception 'acad_not_found';
  end if;
  if _preview and public.acad_is_team(_user_id) then
    return s;
  end if;
  if not (s.course_id = any (public.acad_user_course_ids(_user_id))) then
    raise exception 'acad_forbidden';
  end if;
  if not public.acad_step_unlocked(_user_id, _step) then
    raise exception 'acad_locked';
  end if;
  if exists (select 1 from public.acad_attempts
              where step_id = _step and user_id = _user_id and status = 'passed') then
    raise exception 'acad_already_passed';
  end if;
  select status into last_status from public.acad_attempts
   where step_id = _step and user_id = _user_id order by attempt_no desc limit 1;
  if last_status = 'review' then
    raise exception 'acad_in_review';
  end if;
  return s;
end;
$$;
revoke all on function public.acad_quiz_guard(uuid, uuid, boolean) from public, anon, authenticated;

-- Вопросы теста ученику — без отметок «верный». Команда — просмотр (все вопросы).
create or replace function public.acad_quiz_start(p_step uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
  preview boolean;
  total integer;
begin
  preview := not exists (
    select 1 from public.acad_steps x
     where x.id = p_step and x.course_id = any (public.acad_user_course_ids(auth.uid())));
  s := public.acad_quiz_guard(auth.uid(), p_step, preview);
  select count(*) into total from public.acad_questions where step_id = p_step;
  return jsonb_build_object(
    'step_id', s.id, 'title', s.title, 'total', total, 'preview', preview,
    'pass_percent', coalesce(s.pass_percent,
                             (select pass_percent from public.acad_courses where id = s.course_id)),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'kind', q.kind, 'text', q.text, 'points', q.points,
               'allow_file', q.allow_file,
               'options', (select coalesce(jsonb_agg(jsonb_build_object('id', o ->> 'id', 'text', o ->> 'text')), '[]')
                             from jsonb_array_elements(q.options) o))
             order by q.sort_order, q.created_at)
        from (select * from public.acad_quiz_pending(auth.uid(), p_step)
               where not preview
              union all
              select * from public.acad_questions where preview and step_id = p_step) q
    ), '[]'::jsonb)
  );
end;
$$;

-- Ответы на тест. p_answers — [{question_id, options: [id…], text, file}].
-- Закрытые проверяет сразу (всё или ничего), открытые ждут проверяющего.
create or replace function public.acad_quiz_submit(p_step uuid, p_answers jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.acad_steps;
  uid uuid := auth.uid();
  prev uuid;
  att uuid;
  q public.acad_questions;
  a jsonb;
  picked text[];
  right_ids text[];
  txt text;
  fil text;
  ok boolean;
  pass integer;
  total numeric;
  got numeric;
  pending boolean;
  no integer;
  todo uuid[];
begin
  s := public.acad_quiz_guard(uid, p_step, false);
  if jsonb_typeof(coalesce(p_answers, 'null'::jsonb)) <> 'array' then
    raise exception 'acad_incomplete';
  end if;
  pass := coalesce(s.pass_percent, (select pass_percent from public.acad_courses where id = s.course_id));
  select id into prev from public.acad_attempts
   where step_id = p_step and user_id = uid order by attempt_no desc limit 1;
  select coalesce(max(attempt_no), 0) + 1 into no from public.acad_attempts
   where step_id = p_step and user_id = uid;
  if not exists (select 1 from public.acad_questions where step_id = p_step) then
    raise exception 'acad_no_questions';
  end if;
  -- До записи новой попытки: «последняя» для переноса верных — прошлая.
  todo := array(select id from public.acad_quiz_pending(uid, p_step));

  insert into public.acad_attempts (course_id, step_id, user_id, attempt_no, status, pass_percent)
  values (s.course_id, p_step, uid, no, 'review', pass)
  returning id into att;

  for q in select * from public.acad_questions where id = any (todo) order by sort_order loop
    a := null;
    select x into a from jsonb_array_elements(p_answers) x where x ->> 'question_id' = q.id::text limit 1;
    if a is null then
      raise exception 'acad_incomplete';
    end if;
    picked := array(select distinct jsonb_array_elements_text(coalesce(a -> 'options', '[]'::jsonb)));
    txt := left(btrim(coalesce(a ->> 'text', '')), 4000);
    fil := nullif(a ->> 'file', '');
    if q.kind = 'open' then
      if fil is not null and (not q.allow_file or fil not like 'kbfile:academy/answers/' || uid || '/%') then
        raise exception 'acad_bad_file';
      end if;
      if txt = '' and fil is null then
        raise exception 'acad_incomplete';
      end if;
      ok := null;
    else
      if cardinality(picked) = 0 or (q.kind = 'single' and cardinality(picked) <> 1) then
        raise exception 'acad_incomplete';
      end if;
      right_ids := array(select o ->> 'id' from jsonb_array_elements(q.options) o
                          where coalesce((o ->> 'correct')::boolean, false));
      ok := picked @> right_ids and right_ids @> picked;
      txt := '';
      fil := null;
    end if;
    insert into public.acad_answers (attempt_id, question_id, question, answer, correct, score)
    values (att, q.id,
            jsonb_build_object('kind', q.kind, 'text', q.text, 'options', q.options, 'points', q.points,
                               'explanation', q.explanation, 'sort', q.sort_order,
                               'allow_file', q.allow_file),
            jsonb_build_object('options', to_jsonb(picked), 'text', txt, 'file', fil),
            ok, case when ok then q.points when ok is false then 0 end);
  end loop;

  -- Верные из прошлой попытки — переносом (вопрос не изменился по смыслу —
  -- его не спрашиваем заново; снимок — текущий вопрос).
  if prev is not null then
    insert into public.acad_answers (attempt_id, question_id, question, answer, correct, score,
                                     comment, carried, reviewed_by, reviewed_at)
    select att, an.question_id,
           jsonb_build_object('kind', q2.kind, 'text', q2.text, 'options', q2.options, 'points', q2.points,
                              'explanation', q2.explanation, 'sort', q2.sort_order,
                              'allow_file', q2.allow_file),
           an.answer, true, q2.points, an.comment, true, an.reviewed_by, an.reviewed_at
      from public.acad_answers an
      join public.acad_questions q2 on q2.id = an.question_id and q2.step_id = p_step
     where an.attempt_id = prev and an.correct;
  end if;

  select coalesce(sum(points), 0) into total from public.acad_questions where step_id = p_step;
  select coalesce(sum(score), 0), bool_or(correct is null) into got, pending
    from public.acad_answers where attempt_id = att;
  update public.acad_attempts
     set score = got, max_score = total,
         percent = case when total > 0 then round(got * 100 / total, 1) else 0 end,
         status = case when pending then 'review'
                       when total > 0 and got * 100 / total >= pass then 'passed'
                       else 'failed' end
   where id = att;
  perform public.acad_touch(uid, s.course_id);
  return att;
end;
$$;

-- Попытка с ответами. Ученику — своя, без отметок верных вариантов (видно,
-- где ошибся, но не правильный ответ); команде — любая, целиком.
create or replace function public.acad_attempt(p_attempt uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t public.acad_attempts;
  team boolean;
begin
  select * into t from public.acad_attempts where id = p_attempt;
  if not found then
    raise exception 'acad_not_found';
  end if;
  team := public.acad_is_team(auth.uid());
  if t.user_id <> auth.uid() and not team then
    raise exception 'acad_forbidden';
  end if;
  return jsonb_build_object(
    'id', t.id, 'status', t.status, 'attempt_no', t.attempt_no, 'score', t.score,
    'max_score', t.max_score, 'percent', t.percent, 'pass_percent', t.pass_percent,
    'submitted_at', t.submitted_at, 'reviewed_at', t.reviewed_at,
    'review_comment', t.review_comment,
    'reviewed_by_name', (select full_name from public.profiles where id = t.reviewed_by),
    'user_id', t.user_id,
    'user_name', (select full_name from public.profiles where id = t.user_id),
    'course_id', t.course_id,
    'course_title', (select title from public.acad_courses where id = t.course_id),
    'step_id', t.step_id,
    'step_title', (select title from public.acad_steps where id = t.step_id),
    'full', team,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', an.id, 'question_id', an.question_id,
               'question', case when team or an.correct is not false then an.question
                                else an.question - 'options' || jsonb_build_object(
                                       'options', (select coalesce(jsonb_agg(o - 'correct'), '[]')
                                                     from jsonb_array_elements(an.question -> 'options') o))
                           end,
               'answer', an.answer, 'correct', an.correct, 'score', an.score,
               'comment', an.comment, 'carried', an.carried)
             order by (an.question ->> 'sort')::int nulls last, an.id)
        from public.acad_answers an where an.attempt_id = t.id), '[]'::jsonb)
  );
end;
$$;

-- 7) Проверка открытых ответов ------------------------------------------------------
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
   where a.status = 'review'
   order by a.submitted_at;
end;
$$;

-- p_grades — [{answer_id, correct, comment}]; каждый ответ, ждущий проверки,
-- должен получить оценку. Комментарий можно и к закрытому вопросу.
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

-- 8) Отчёты (команде) ----------------------------------------------------------------
create or replace function public.acad_course_report(p_course uuid)
returns table (
  user_id uuid, full_name text, avatar_url text, assigned_at timestamptz, due_date date,
  started_at timestamptz, completed_at timestamptz, last_activity_at timestamptz,
  steps_total integer, steps_done integer, attempts integer, avg_percent numeric,
  status text, overdue boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select r.user_id, p.full_name, p.avatar_url, r.assigned_at, r.due_date, r.started_at,
         r.completed_at, r.last_activity_at, r.steps_total, r.steps_done, r.attempts,
         r.avg_percent, r.status, r.overdue
    from public.acad_progress_rows(p_course, null) r
    left join public.profiles p on p.id = r.user_id
   order by r.overdue desc, (r.completed_at is not null), p.full_name;
end;
$$;

-- Разбор ошибок: по каждому вопросу — сколько раз отвечали (без переносов) и
-- сколько неверно.
create or replace function public.acad_question_stats(p_course uuid)
returns table (
  question_id uuid, step_id uuid, step_title text, text text, kind text,
  answers integer, wrong integer, people integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select q.id, s.id, s.title, q.text, q.kind,
         count(an.id) filter (where an.correct is not null)::int,
         count(an.id) filter (where an.correct is false)::int,
         count(distinct a.user_id)::int
    from public.acad_questions q
    join public.acad_steps s on s.id = q.step_id
    left join public.acad_answers an on an.question_id = q.id and not an.carried
    left join public.acad_attempts a on a.id = an.attempt_id
   where q.course_id = p_course
   group by q.id, s.id, s.title, s.sort_order, q.text, q.kind, q.sort_order
   order by s.sort_order, q.sort_order;
end;
$$;

-- Все курсы: ученики по состояниям.
create or replace function public.acad_overview()
returns table (
  course_id uuid, title text, status text, folder_id uuid, learners integer,
  completed integer, in_progress integer, not_started integer, review integer, overdue integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select c.id, c.title, c.status, c.folder_id,
         count(r.user_id)::int,
         count(*) filter (where r.status = 'completed')::int,
         count(*) filter (where r.status = 'in_progress')::int,
         count(*) filter (where r.status = 'not_started')::int,
         count(*) filter (where r.status = 'review')::int,
         count(*) filter (where r.overdue)::int
    from public.acad_courses c
    left join public.acad_progress_rows(null, null) r on r.course_id = c.id
   group by c.id, c.title, c.status, c.folder_id, c.sort_order
   order by c.sort_order, c.title;
end;
$$;

-- По сотрудникам: курсы (опубликованные), пройдено, просрочено.
create or replace function public.acad_people_overview()
returns table (
  user_id uuid, full_name text, avatar_url text, courses integer, completed integer,
  in_progress integer, not_started integer, review integer, overdue integer,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select r.user_id, p.full_name, p.avatar_url,
         count(*)::int,
         count(*) filter (where r.status = 'completed')::int,
         count(*) filter (where r.status = 'in_progress')::int,
         count(*) filter (where r.status = 'not_started')::int,
         count(*) filter (where r.status = 'review')::int,
         count(*) filter (where r.overdue)::int,
         max(r.last_activity_at)
    from public.acad_progress_rows(null, null) r
    join public.acad_courses c on c.id = r.course_id and c.status = 'published'
    left join public.profiles p on p.id = r.user_id
   group by r.user_id, p.full_name, p.avatar_url
   order by count(*) filter (where r.overdue) desc, p.full_name;
end;
$$;

-- Карточка сотрудника: его курсы и попытки.
create or replace function public.acad_person(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return jsonb_build_object(
    'user_id', p_user,
    'full_name', (select full_name from public.profiles where id = p_user),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'course_id', r.course_id, 'title', c.title, 'status', r.status,
               'overdue', r.overdue, 'due_date', r.due_date, 'started_at', r.started_at,
               'completed_at', r.completed_at, 'steps_total', r.steps_total,
               'steps_done', r.steps_done, 'avg_percent', r.avg_percent)
             order by r.overdue desc, (r.completed_at is not null), c.title)
        from public.acad_progress_rows(null, p_user) r
        join public.acad_courses c on c.id = r.course_id), '[]'::jsonb),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'course_title', c.title, 'step_title', s.title,
               'attempt_no', a.attempt_no, 'status', a.status, 'percent', a.percent,
               'submitted_at', a.submitted_at)
             order by a.submitted_at desc)
        from public.acad_attempts a
        join public.acad_courses c on c.id = a.course_id
        join public.acad_steps s on s.id = a.step_id
       where a.user_id = p_user), '[]'::jsonb)
  );
end;
$$;

-- Кого можно назначить: сотрудники (с ролью хоть в одном клубе), их роли и клубы.
create or replace function public.acad_staff_directory()
returns table (user_id uuid, full_name text, avatar_url text, email text, roles jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select r.user_id, p.full_name, p.avatar_url, p.email,
         jsonb_agg(distinct jsonb_build_object('role', r.role::text, 'studio_id', r.studio_id))
    from public.user_roles r
    left join public.profiles p on p.id = r.user_id
   where r.role::text in ('owner', 'admin', 'trainer')
   group by r.user_id, p.full_name, p.avatar_url, p.email
   order by p.full_name;
end;
$$;

-- Уроки из статей: какая версия статьи сейчас опубликована (у создателя
-- курса может не быть доступа к базе — поэтому здесь, а не чтением kb_nodes).
create or replace function public.acad_course_sources(p_course uuid)
returns table (step_id uuid, node_id uuid, base_id uuid, node_title text, published_at timestamptz,
               available boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select s.id, n.id, n.base_id, n.title, n.published_at,
         n.status = 'published' and n.base_id = any (public.auth_kb_view_base_ids())
    from public.acad_steps s
    join public.kb_nodes n on n.id = s.source_node_id
   where s.course_id = p_course;
end;
$$;

-- Порядок шагов и курсов одной командой.
create or replace function public.acad_reorder(p_kind text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.acad_can_create(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  if p_kind = 'steps' then
    update public.acad_steps s set sort_order = x.n
      from unnest(p_ids) with ordinality x(id, n) where s.id = x.id;
  elsif p_kind = 'questions' then
    update public.acad_questions q set sort_order = x.n
      from unnest(p_ids) with ordinality x(id, n) where q.id = x.id;
  elsif p_kind = 'courses' then
    update public.acad_courses c set sort_order = x.n
      from unnest(p_ids) with ordinality x(id, n) where c.id = x.id;
  elsif p_kind = 'folders' then
    update public.acad_folders f set sort_order = x.n
      from unnest(p_ids) with ordinality x(id, n) where f.id = x.id;
  else
    raise exception 'acad_bad_kind';
  end if;
end;
$$;

revoke all on function public.acad_access(), public.acad_my_courses(), public.acad_course_view(uuid),
  public.acad_lesson(uuid), public.acad_lesson_complete(uuid), public.acad_quiz_start(uuid),
  public.acad_quiz_submit(uuid, jsonb), public.acad_attempt(uuid), public.acad_review_queue(),
  public.acad_review_submit(uuid, jsonb, text), public.acad_course_report(uuid),
  public.acad_question_stats(uuid), public.acad_overview(), public.acad_people_overview(),
  public.acad_person(uuid), public.acad_staff_directory(), public.acad_course_sources(uuid),
  public.acad_reorder(text, uuid[])
  from public, anon;
grant execute on function public.acad_access(), public.acad_my_courses(), public.acad_course_view(uuid),
  public.acad_lesson(uuid), public.acad_lesson_complete(uuid), public.acad_quiz_start(uuid),
  public.acad_quiz_submit(uuid, jsonb), public.acad_attempt(uuid), public.acad_review_queue(),
  public.acad_review_submit(uuid, jsonb, text), public.acad_course_report(uuid),
  public.acad_question_stats(uuid), public.acad_overview(), public.acad_people_overview(),
  public.acad_person(uuid), public.acad_staff_directory(), public.acad_course_sources(uuid),
  public.acad_reorder(text, uuid[])
  to authenticated, service_role;

-- 9) Файлы без ссылок и занятое место — с учётом Академии ---------------------------
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

create or replace function public.kb_storage_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  result jsonb;
begin
  if not public.kb_is_admin(auth.uid()) then
    raise exception 'kb_forbidden';
  end if;
  with files as (
    select split_part(o.name, '/', 1) as folder,
           coalesce((o.metadata ->> 'size')::bigint, 0) as size
      from storage.objects o
     where o.bucket_id = 'kb-media'
  )
  select jsonb_build_object(
    'bases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'title', b.title,
               'files', (select count(*) from files f where f.folder = b.id::text),
               'bytes', (select coalesce(sum(f.size), 0) from files f where f.folder = b.id::text),
               'articles', (select count(*) from public.kb_nodes n where n.base_id = b.id and n.kind = 'article'),
               'revisions', (select count(*) from public.kb_revisions v where v.base_id = b.id))
             order by b.sort_order, b.created_at)
        from public.kb_bases b), '[]'),
    'templates', jsonb_build_object(
      'files', (select count(*) from files f where f.folder = 'templates'),
      'bytes', (select coalesce(sum(f.size), 0) from files f where f.folder = 'templates')),
    'academy', jsonb_build_object(
      'files', (select count(*) from files f where f.folder = 'academy'),
      'bytes', (select coalesce(sum(f.size), 0) from files f where f.folder = 'academy'),
      'courses', (select count(*) from public.acad_courses)),
    'files_total', (select count(*) from files),
    'bytes_total', (select coalesce(sum(size), 0) from files),
    'db_bytes', (
      select coalesce(sum(pg_total_relation_size(c.oid)), 0)
        from pg_class c join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'public' and c.relkind = 'r'
         and (c.relname like 'kb\_%' or c.relname like 'acad\_%')
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.kb_storage_usage() from public, anon;
grant execute on function public.kb_storage_usage() to authenticated, service_role;

notify pgrst, 'reload schema';
