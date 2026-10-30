-- ============================================================================
-- «Аналитика» → «Обработка 1С» (ANALYTICS_PLAN.md §6, §8.1; решения владельца
-- 2026-10-29): их Windows-обработчик 1С на портале, логика — как у них.
--
--   * выгрузки 1С (an_onec_files) — четыре вида, как их папки: «Выгрузки для
--     НДЯ», «Продажи», «Занятия и направления», «Занятия с членством и
--     клиентом». Сами файлы — в закрытом бакете an-onec (только
--     администратору аналитики): в них коды клиентов, в снимок они не
--     попадают (как у них);
--   * справочники обработчика в их Excel-формате: студии (studios_unique.xlsx),
--     номенклатура (nomenclature_reference.xlsx), точка 0
--     (city_break_even_reference.xlsx). Порядок строк сохраняется
--     (sort_order): у них «позже в файле — главнее»;
--   * запуски (an_onec_runs): очередь, ход и журнал, окно новых номенклатур
--     (review), итог. Считает сервер портала (фоновый цикл,
--     lib/analytics/server/onec.server.ts); живость — heartbeat;
--   * снимок отчётов — их items / facts / metadata: an_onec_snapshots (meta —
--     их metadata.snapshot), an_onec_items, an_onec_facts. Три слота:
--     текущий, предыдущий (откат — как их previous.sqlite3) и новый
--     (обработан, ещё не загружен — их onec-test.zip до «2. Загрузить»).
--     Слоты — разделы таблиц (partition by list): освобождённый слот
--     очищает truncate при следующей обработке.
--
-- Все таблицы закрыты браузеру: администратору аналитики — RPC an_onec_*
-- (an_require_admin), серверу — RPC только для service_role. Идемпотентно.
-- ============================================================================

-- 1) Выгрузки 1С ------------------------------------------------------------------
-- name — имя файла в папке без «_очищено» (у них обработчик берёт
-- «*_очищено.xlsx» — результат ExcelCleaner; здесь очистку делает сам
-- обработчик). Windows не различает регистр имён — и здесь одно имя на вид.
create table if not exists public.an_onec_files (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('cash', 'sales', 'classes', 'visits')),
  name text not null check (name ~* '\.xlsx$' and length(name) between 6 and 200 and name !~ '[/\\]'),
  path text not null unique,
  size bigint not null check (size > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  cleaned boolean not null default false,
  -- План очистки (какие строки и столбцы пустые) — считается при первой
  -- обработке файла, дальше берётся отсюда.
  plan jsonb,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users (id) on delete set null
);
create unique index if not exists an_onec_files_name_uq on public.an_onec_files (kind, lower(name));

-- 2) Справочники ----------------------------------------------------------------------
-- studios_unique.xlsx: Студия_1С, Статус студии, Город, Партнер, Комментарий.
create table if not exists public.an_onec_studios (
  sort_order integer primary key,
  studio text,
  status text,
  city text,
  partner text,
  comment text
);

-- nomenclature_reference.xlsx: Код, Название (« | » между названиями),
-- Обозначение (категория), Направление. Каждая обработка пересобирает его
-- целиком (их build_reference), категории — из прежнего и окна новых.
create table if not exists public.an_onec_nomenclature (
  sort_order integer primary key,
  code text not null,
  names text not null default '',
  category text not null default '',
  direction text not null default ''
);
create index if not exists an_onec_nomenclature_code on public.an_onec_nomenclature (code);

-- city_break_even_reference.xlsx — все 11 колонок; обработке нужны
-- «Направление», «Город для борда», «Точка 0 в месяц». Числа хранятся
-- текстом, как в ячейке.
create table if not exists public.an_onec_break_even (
  sort_order integer primary key,
  direction text,
  source_city text,
  source_partner text,
  amount text,
  studios_count text,
  source_status text,
  source_comment text,
  board_city text,
  board_partner text,
  match_status text,
  check_comment text
);

-- Когда и кем справочник менялся последним.
create table if not exists public.an_onec_refs (
  ref text primary key check (ref in ('studios', 'nomenclature', 'break_even')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  source text not null check (source in ('import', 'edit', 'run'))
);

-- 3) Запуски обработки -------------------------------------------------------------------
create table if not exists public.an_onec_runs (
  id bigint generated always as identity primary key,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'review', 'answered', 'done', 'error', 'cancelled')),
  -- Позиции окна новых номенклатур, на которые уже ответили ([[код,
  -- название], …]): у них после окна обработка шла дальше в том же запуске,
  -- здесь — новым запуском, и эти позиции второй раз не спрашиваются.
  answered jsonb not null default '[]',
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  cancel_requested boolean not null default false,
  progress text,
  log text[] not null default '{}',
  review jsonb,
  result jsonb,
  error text,
  snapshot_id bigint
);
create unique index if not exists an_onec_runs_one_active on public.an_onec_runs ((true))
  where status in ('queued', 'running');
create index if not exists an_onec_runs_recent on public.an_onec_runs (id desc);

-- 4) Снимок отчётов --------------------------------------------------------------------
create table if not exists public.an_onec_snapshots (
  id bigint generated always as identity primary key,
  slot smallint not null check (slot between 1 and 3),
  state text not null check (state in ('building', 'ready', 'current', 'previous', 'discarded')),
  run_id bigint references public.an_onec_runs (id) on delete set null,
  -- Их metadata.snapshot: version, generated_at, coverage, issues,
  -- breakEven, zeroControls, coverage_notice, semantics.
  meta jsonb,
  -- Номер последней записанной пачки фактов: повтор пачки после обрыва
  -- связи не складывается второй раз.
  facts_seq integer not null default 0,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  activated_at timestamptz,
  activated_by uuid references auth.users (id) on delete set null
);
create unique index if not exists an_onec_snapshots_slot_live on public.an_onec_snapshots (slot)
  where state <> 'discarded';
create unique index if not exists an_onec_snapshots_state_one on public.an_onec_snapshots (state)
  where state <> 'discarded';

-- Их items(report, city, studio, dimension, code, status) и facts(day,
-- item_id, v1…v8): значения v — по отчёту (ONEC_REPORTS в process.ts).
create table if not exists public.an_onec_items (
  slot smallint not null,
  id integer not null,
  report text not null check (report in ('revenue', 'sales', 'activities', 'funnel', 'trial_products', 'zero')),
  city text not null,
  studio text not null,
  dimension text not null,
  code text not null,
  status text not null,
  primary key (slot, id)
) partition by list (slot);
create table if not exists public.an_onec_items_1 partition of public.an_onec_items for values in (1);
create table if not exists public.an_onec_items_2 partition of public.an_onec_items for values in (2);
create table if not exists public.an_onec_items_3 partition of public.an_onec_items for values in (3);
create index if not exists an_onec_items_scope on public.an_onec_items (slot, report, city, studio);

create table if not exists public.an_onec_facts (
  slot smallint not null,
  item_id integer not null,
  day date not null,
  v1 double precision not null,
  v2 double precision not null,
  v3 double precision not null,
  v4 double precision not null,
  v5 double precision not null,
  v6 double precision not null,
  v7 double precision not null,
  v8 double precision not null,
  primary key (slot, item_id, day)
) partition by list (slot);
create table if not exists public.an_onec_facts_1 partition of public.an_onec_facts for values in (1);
create table if not exists public.an_onec_facts_2 partition of public.an_onec_facts for values in (2);
create table if not exists public.an_onec_facts_3 partition of public.an_onec_facts for values in (3);

-- 5) Доступ: всё закрыто браузеру ------------------------------------------------------
-- Разделы — отдельные таблицы: права и RLS у них свои (у Supabase новые
-- таблицы public по умолчанию открыты anon/authenticated).
do $$
declare
  t text;
begin
  foreach t in array array['an_onec_files', 'an_onec_studios', 'an_onec_nomenclature',
    'an_onec_break_even', 'an_onec_refs', 'an_onec_runs', 'an_onec_snapshots',
    'an_onec_items', 'an_onec_items_1', 'an_onec_items_2', 'an_onec_items_3',
    'an_onec_facts', 'an_onec_facts_1', 'an_onec_facts_2', 'an_onec_facts_3']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- 6) Хранилище выгрузок -----------------------------------------------------------------
-- Путь объекта: <вид>/<uuid>.xlsx (имя файла — в an_onec_files).
insert into storage.buckets (id, name, public, file_size_limit)
values ('an-onec', 'an-onec', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "an-onec admin" on storage.objects;
create policy "an-onec admin" on storage.objects
  for all to authenticated
  using (bucket_id = 'an-onec' and (select public.an_is_admin(auth.uid())))
  with check (bucket_id = 'an-onec' and (select public.an_is_admin(auth.uid())));

-- 7) Служебное ----------------------------------------------------------------------------
create or replace function public.an_onec_person(_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(btrim(p.full_name), '') from public.profiles p where p.id = _user_id
$$;
revoke all on function public.an_onec_person(uuid) from public, anon, authenticated;
grant execute on function public.an_onec_person(uuid) to service_role;

-- Идёт обработка — справочники и выгрузки не меняются (у них кнопки
-- неактивны, пока обработчик работает).
create or replace function public.an_onec_require_idle()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.an_onec_runs where status in ('queued', 'running')) then
    raise exception 'an_onec_busy' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.an_onec_require_idle() from public, anon, authenticated;
grant execute on function public.an_onec_require_idle() to service_role;

create or replace function public.an_onec_ref_touch(p_ref text, p_source text, p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_onec_refs (ref, updated_at, updated_by, source)
  values (p_ref, now(), p_user, p_source)
  on conflict (ref) do update
    set updated_at = excluded.updated_at, updated_by = excluded.updated_by, source = excluded.source
$$;
revoke all on function public.an_onec_ref_touch(text, text, uuid) from public, anon, authenticated;
grant execute on function public.an_onec_ref_touch(text, text, uuid) to service_role;

-- Строки справочника в порядке файла (jsonb-массив объектов).
create or replace function public.an_onec_ref_json(p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if p_ref = 'studios' then
    select coalesce(jsonb_agg(jsonb_build_object('studio', studio, 'status', status, 'city', city,
      'partner', partner, 'comment', comment) order by sort_order), '[]')
      into v from public.an_onec_studios;
  elsif p_ref = 'nomenclature' then
    select coalesce(jsonb_agg(jsonb_build_object('code', code, 'names', names, 'category', category,
      'direction', direction) order by sort_order), '[]')
      into v from public.an_onec_nomenclature;
  elsif p_ref = 'break_even' then
    select coalesce(jsonb_agg(jsonb_build_object('direction', direction, 'source_city', source_city,
      'source_partner', source_partner, 'amount', amount, 'studios_count', studios_count,
      'source_status', source_status, 'source_comment', source_comment, 'board_city', board_city,
      'board_partner', board_partner, 'match_status', match_status, 'check_comment', check_comment)
      order by sort_order), '[]')
      into v from public.an_onec_break_even;
  else
    raise exception 'an_onec_bad_ref' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public.an_onec_ref_json(text) from public, anon, authenticated;
grant execute on function public.an_onec_ref_json(text) to service_role;

-- Заменить справочник целиком (строки — как отдаёт an_onec_ref_json).
create or replace function public.an_onec_ref_write(p_ref text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'an_onec_bad_rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object') then
    raise exception 'an_onec_bad_rows' using errcode = '22023';
  end if;
  if p_ref = 'studios' then
    delete from public.an_onec_studios;
    insert into public.an_onec_studios (sort_order, studio, status, city, partner, comment)
    select o, r->>'studio', r->>'status', r->>'city', r->>'partner', r->>'comment'
      from jsonb_array_elements(p_rows) with ordinality x(r, o);
  elsif p_ref = 'nomenclature' then
    if exists (select 1 from jsonb_array_elements(p_rows) r where btrim(coalesce(r->>'code', '')) = '') then
      raise exception 'an_onec_no_code' using errcode = '22023';
    end if;
    delete from public.an_onec_nomenclature;
    insert into public.an_onec_nomenclature (sort_order, code, names, category, direction)
    select o, r->>'code', coalesce(r->>'names', ''), coalesce(r->>'category', ''),
           coalesce(r->>'direction', '')
      from jsonb_array_elements(p_rows) with ordinality x(r, o);
  elsif p_ref = 'break_even' then
    delete from public.an_onec_break_even;
    insert into public.an_onec_break_even (sort_order, direction, source_city, source_partner, amount,
      studios_count, source_status, source_comment, board_city, board_partner, match_status, check_comment)
    select o, r->>'direction', r->>'source_city', r->>'source_partner', r->>'amount',
           r->>'studios_count', r->>'source_status', r->>'source_comment', r->>'board_city',
           r->>'board_partner', r->>'match_status', r->>'check_comment'
      from jsonb_array_elements(p_rows) with ordinality x(r, o);
  else
    raise exception 'an_onec_bad_ref' using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.an_onec_ref_write(text, jsonb) from public, anon, authenticated;
grant execute on function public.an_onec_ref_write(text, jsonb) to service_role;

-- Слот снимка в состоянии (для отчётов — 'current').
create or replace function public.an_onec_slot(p_state text)
returns smallint
language sql
stable
security definer
set search_path = public
as $$
  select slot from public.an_onec_snapshots where state = p_state
$$;
revoke all on function public.an_onec_slot(text) from public, anon, authenticated;
grant execute on function public.an_onec_slot(text) to service_role;

-- Краткие сведения о снимке для страницы: без итогов и точки 0 (как их
-- public_meta — контрольные суммы не показываются).
create or replace function public.an_onec_snapshot_card(s public.an_onec_snapshots)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id, 'state', s.state, 'run_id', s.run_id, 'created_at', s.created_at,
    'ready_at', s.ready_at, 'activated_at', s.activated_at,
    'activated_by', public.an_onec_person(s.activated_by),
    'generated_at', s.meta->'generated_at',
    'coverage', (select jsonb_object_agg(k, jsonb_build_object('rows', v->'rows', 'min', v->'min',
                   'max', v->'max', 'source_rows', v->'source_rows'))
                   from jsonb_each(coalesce(s.meta->'coverage', '{}')) e(k, v)),
    'issues', coalesce(s.meta->'issues', '{}'),
    'zeroControls', coalesce(s.meta->'zeroControls', '{}'),
    'breakEvenCities', (select count(*) from jsonb_object_keys(coalesce(s.meta->'breakEven', '{}')))
  )
$$;
revoke all on function public.an_onec_snapshot_card(public.an_onec_snapshots) from public, anon, authenticated;
grant execute on function public.an_onec_snapshot_card(public.an_onec_snapshots) to service_role;

create or replace function public.an_onec_run_card(r public.an_onec_runs)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'requested_at', r.requested_at,
    'requested_by', public.an_onec_person(r.requested_by), 'started_at', r.started_at,
    'heartbeat_at', r.heartbeat_at, 'finished_at', r.finished_at,
    'cancel_requested', r.cancel_requested, 'progress', r.progress, 'error', r.error,
    'snapshot_id', r.snapshot_id, 'log_lines', cardinality(r.log)
  )
$$;
revoke all on function public.an_onec_run_card(public.an_onec_runs) from public, anon, authenticated;
grant execute on function public.an_onec_run_card(public.an_onec_runs) to service_role;

-- 8) Администратору аналитики: страница «Обработка 1С» ----------------------------------
create or replace function public.an_onec_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'name', f.name,
                'size', f.size, 'sha256', f.sha256, 'cleaned', f.cleaned, 'uploaded_at', f.uploaded_at,
                'uploaded_by', public.an_onec_person(f.uploaded_by)) order by f.kind, lower(f.name)), '[]')
              from public.an_onec_files f),
    'refs', (select jsonb_object_agg(x.ref, jsonb_build_object(
                'rows', x.n, 'updated_at', r.updated_at, 'updated_by', public.an_onec_person(r.updated_by),
                'source', r.source))
              from (values ('studios', (select count(*) from public.an_onec_studios)),
                           ('nomenclature', (select count(*) from public.an_onec_nomenclature)),
                           ('break_even', (select count(*) from public.an_onec_break_even))) x(ref, n)
              left join public.an_onec_refs r on r.ref = x.ref),
    'runs', (select coalesce(jsonb_agg(public.an_onec_run_card(r) order by r.id desc), '[]')
              from public.an_onec_runs r
             where r.id in (select id from public.an_onec_runs order by id desc limit 20)),
    'snapshots', (select coalesce(jsonb_agg(public.an_onec_snapshot_card(s) order by s.id desc), '[]')
                   from public.an_onec_snapshots s where s.state in ('ready', 'current', 'previous'))
  );
end;
$$;
revoke all on function public.an_onec_overview() from public, anon;
grant execute on function public.an_onec_overview() to authenticated, service_role;

-- Запуск целиком: журнал, окно новых номенклатур, итог.
create or replace function public.an_onec_run_get(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.an_onec_runs;
begin
  perform public.an_require_admin();
  select * into r from public.an_onec_runs where id = p_id;
  if r.id is null then
    raise exception 'an_onec_no_run' using errcode = 'P0002';
  end if;
  return public.an_onec_run_card(r)
    || jsonb_build_object('log', to_jsonb(r.log), 'review', r.review, 'result', r.result);
end;
$$;
revoke all on function public.an_onec_run_get(bigint) from public, anon;
grant execute on function public.an_onec_run_get(bigint) to authenticated, service_role;

create or replace function public.an_onec_ref_rows(p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return public.an_onec_ref_json(p_ref);
end;
$$;
revoke all on function public.an_onec_ref_rows(text) from public, anon;
grant execute on function public.an_onec_ref_rows(text) to authenticated, service_role;

-- Загрузить справочник из файла или сохранить правку (весь справочник).
create or replace function public.an_onec_ref_replace(p_ref text, p_rows jsonb, p_source text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  if p_source not in ('import', 'edit') then
    raise exception 'an_onec_bad_source' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 50000 then
    raise exception 'an_onec_too_many_rows' using errcode = '22023';
  end if;
  n := public.an_onec_ref_write(p_ref, p_rows);
  perform public.an_onec_ref_touch(p_ref, p_source, auth.uid());
  return n;
end;
$$;
revoke all on function public.an_onec_ref_replace(text, jsonb, text) from public, anon;
grant execute on function public.an_onec_ref_replace(text, jsonb, text) to authenticated, service_role;

-- Категория и направление номенклатуры: [{code, category, direction}, …]
-- (как правка их справочника в Excel: меняются только эти две колонки).
create or replace function public.an_onec_nomenclature_update(p_changes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'an_onec_bad_rows' using errcode = '22023';
  end if;
  update public.an_onec_nomenclature t
     set category = coalesce(c->>'category', t.category),
         direction = coalesce(c->>'direction', t.direction)
    from jsonb_array_elements(p_changes) c
   where t.code = c->>'code';
  get diagnostics n = row_count;
  if n > 0 then
    perform public.an_onec_ref_touch('nomenclature', 'edit', auth.uid());
  end if;
  return n;
end;
$$;
revoke all on function public.an_onec_nomenclature_update(jsonb) from public, anon;
grant execute on function public.an_onec_nomenclature_update(jsonb) to authenticated, service_role;

-- Выгрузка загружена в бакет (браузером) — записать её; прежний файл того же
-- имени заменяется: путь его объекта возвращается, браузер его удаляет.
create or replace function public.an_onec_file_register(
  p_kind text, p_name text, p_path text, p_sha256 text, p_cleaned boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size bigint;
  v_old text;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  if p_kind not in ('cash', 'sales', 'classes', 'visits')
     or p_path !~ ('^' || p_kind || '/[0-9a-f-]{36}\.xlsx$') then
    raise exception 'an_onec_bad_file' using errcode = '22023';
  end if;
  select coalesce((o.metadata->>'size')::bigint, (o.metadata->>'contentLength')::bigint, 0)
    into v_size from storage.objects o where o.bucket_id = 'an-onec' and o.name = p_path;
  if v_size is null then
    raise exception 'an_onec_no_object' using errcode = 'P0002';
  end if;
  select path into v_old from public.an_onec_files where kind = p_kind and lower(name) = lower(p_name);
  delete from public.an_onec_files where kind = p_kind and lower(name) = lower(p_name);
  insert into public.an_onec_files (kind, name, path, size, sha256, cleaned, uploaded_by)
  values (p_kind, p_name, p_path, greatest(v_size, 1), nullif(p_sha256, ''), coalesce(p_cleaned, false), auth.uid());
  return v_old;
end;
$$;
revoke all on function public.an_onec_file_register(text, text, text, text, boolean) from public, anon;
grant execute on function public.an_onec_file_register(text, text, text, text, boolean) to authenticated, service_role;

create or replace function public.an_onec_file_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  delete from public.an_onec_files where id = p_id returning path into v_path;
  return v_path;
end;
$$;
revoke all on function public.an_onec_file_delete(uuid) from public, anon;
grant execute on function public.an_onec_file_delete(uuid) to authenticated, service_role;

-- «1. Обработать». Окно новых номенклатур без ответа отменяется (у них
-- закрытое окно = «Обработка отменена»).
create or replace function public.an_onec_run_start()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  update public.an_onec_runs
     set status = 'cancelled', finished_at = coalesce(finished_at, now()),
         error = 'Обработка отменена: новые номенклатуры не были классифицированы.'
   where status = 'review';
  insert into public.an_onec_runs (status, requested_by, log)
  values ('queued', auth.uid(), array['Начата полная обработка. HTML-дашборды не создаются.'])
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.an_onec_run_start() from public, anon;
grant execute on function public.an_onec_run_start() to authenticated, service_role;

create or replace function public.an_onec_run_cancel(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  update public.an_onec_runs
     set status = 'cancelled', finished_at = now(), error = 'Обработка отменена.'
   where id = p_id and status in ('queued', 'review');
  update public.an_onec_runs set cancel_requested = true where id = p_id and status = 'running';
end;
$$;
revoke all on function public.an_onec_run_cancel(bigint) from public, anon;
grant execute on function public.an_onec_run_cancel(bigint) to authenticated, service_role;

-- Окно «Новые номенклатуры» → «Сохранить и продолжить»: категории — в
-- справочник (их save_designations: только колонка «Обозначение» у строк с
-- этим кодом), обработка — дальше (новым запуском).
create or replace function public.an_onec_review_submit(p_run bigint, p_assignments jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.an_onec_runs;
  v_codes text[];
  v_choices text[];
  v_id bigint;
begin
  perform public.an_require_admin();
  perform public.an_onec_require_idle();
  select * into r from public.an_onec_runs where id = p_run for update;
  if r.id is null or r.status <> 'review' or r.review is null then
    raise exception 'an_onec_no_review' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_assignments) is distinct from 'object' then
    raise exception 'an_onec_bad_assignments' using errcode = '22023';
  end if;
  v_codes := array(select distinct i->>'code' from jsonb_array_elements(r.review->'items') i);
  v_choices := array(select jsonb_array_elements_text(r.review->'choices'));
  if array(select k from jsonb_object_keys(p_assignments) k order by k)
     is distinct from array(select c from unnest(v_codes) c order by c) then
    raise exception 'an_onec_review_incomplete' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_assignments) e
              where jsonb_typeof(e.value) <> 'string' or btrim(e.value #>> '{}') = ''
                 or (e.value #>> '{}') = 'Не определено' or not ((e.value #>> '{}') = any (v_choices))) then
    raise exception 'an_onec_review_bad_category' using errcode = '22023';
  end if;
  update public.an_onec_nomenclature t
     set category = btrim(p_assignments->>btrim(t.code))
   where p_assignments ? btrim(t.code);
  perform public.an_onec_ref_touch('nomenclature', 'edit', auth.uid());
  update public.an_onec_runs set status = 'answered', finished_at = coalesce(finished_at, now())
   where id = p_run;
  insert into public.an_onec_runs (status, requested_by, answered, log)
  values ('queued', auth.uid(),
          r.answered || coalesce((select jsonb_agg(jsonb_build_array(i->>'code', i->>'name'))
                                     from jsonb_array_elements(r.review->'items') i), '[]'),
          array['Категории сохранены в справочник. Продолжаем обработку.'])
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.an_onec_review_submit(bigint, jsonb) from public, anon;
grant execute on function public.an_onec_review_submit(bigint, jsonb) to authenticated, service_role;

-- «2. Загрузить»: новый снимок становится данными отчётов, прежний —
-- предыдущим (откат), ещё более ранний освобождает слот. У них: «При
-- загрузке заменяется весь снимок данных», на сервере — текущая база и одна
-- предыдущая копия.
create or replace function public.an_onec_snapshot_activate(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if not exists (select 1 from public.an_onec_snapshots where id = p_id and state = 'ready') then
    raise exception 'an_onec_no_snapshot' using errcode = 'P0002';
  end if;
  update public.an_onec_snapshots set state = 'discarded' where state = 'previous';
  update public.an_onec_snapshots set state = 'previous' where state = 'current';
  update public.an_onec_snapshots
     set state = 'current', activated_at = now(), activated_by = auth.uid()
   where id = p_id;
end;
$$;
revoke all on function public.an_onec_snapshot_activate(bigint) from public, anon;
grant execute on function public.an_onec_snapshot_activate(bigint) to authenticated, service_role;

-- Вернуть предыдущий снимок (текущий становится предыдущим — можно вернуть
-- обратно).
create or replace function public.an_onec_snapshot_rollback()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current bigint;
  v_previous bigint;
begin
  perform public.an_require_admin();
  select id into v_previous from public.an_onec_snapshots where state = 'previous' for update;
  if v_previous is null then
    raise exception 'an_onec_no_previous' using errcode = 'P0002';
  end if;
  select id into v_current from public.an_onec_snapshots where state = 'current' for update;
  -- Уникальность состояния проверяется построчно: меняются местами через
  -- временное «discarded» (слот при этом свободен лишь внутри транзакции).
  update public.an_onec_snapshots set state = 'discarded' where id = v_current;
  update public.an_onec_snapshots set state = 'current', activated_at = now(), activated_by = auth.uid()
   where id = v_previous;
  update public.an_onec_snapshots set state = 'previous' where id = v_current;
end;
$$;
revoke all on function public.an_onec_snapshot_rollback() from public, anon;
grant execute on function public.an_onec_snapshot_rollback() to authenticated, service_role;

create or replace function public.an_onec_snapshot_discard(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  update public.an_onec_snapshots set state = 'discarded' where id = p_id and state = 'ready';
end;
$$;
revoke all on function public.an_onec_snapshot_discard(bigint) from public, anon;
grant execute on function public.an_onec_snapshot_discard(bigint) to authenticated, service_role;

-- 9) Серверу портала (service_role) ---------------------------------------------------------
-- Взять запуск из очереди. Зависший (сервер перезапустился посреди
-- обработки — heartbeat старше 3 минут) завершается ошибкой.
create or replace function public.an_onec_run_claim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.an_onec_runs;
begin
  update public.an_onec_snapshots s set state = 'discarded'
    from public.an_onec_runs r2
   where s.state = 'building' and s.run_id = r2.id and r2.status = 'running'
     and r2.heartbeat_at < now() - interval '3 minutes';
  update public.an_onec_runs
     set status = 'error', finished_at = now(),
         error = 'Сервер портала перезапустился во время обработки. Запустите обработку ещё раз.'
   where status = 'running' and heartbeat_at < now() - interval '3 minutes';

  select * into r from public.an_onec_runs where status = 'queued' order by id limit 1
    for update skip locked;
  if r.id is null then
    return null;
  end if;
  update public.an_onec_runs
     set status = 'running', started_at = now(), heartbeat_at = now(),
         progress = 'Обрабатываем всю доступную историю…'
   where id = r.id;
  return jsonb_build_object(
    'id', r.id,
    'answered', r.answered,
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'name', f.name,
               'path', f.path, 'size', f.size, 'cleaned', f.cleaned, 'plan', f.plan)), '[]')
              from public.an_onec_files f),
    'studios', public.an_onec_ref_json('studios'),
    'nomenclature', public.an_onec_ref_json('nomenclature'),
    'break_even', public.an_onec_ref_json('break_even')
  );
end;
$$;
revoke all on function public.an_onec_run_claim() from public, anon, authenticated;
grant execute on function public.an_onec_run_claim() to service_role;

-- Ход: строка состояния, новые строки журнала (хранится 1500 последних —
-- у них окно держит 1200). Ответ — просили ли отменить.
create or replace function public.an_onec_run_progress(p_run bigint, p_progress text, p_log text[])
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log text[];
  v_cancel boolean;
begin
  select log || coalesce(p_log, '{}') into v_log from public.an_onec_runs
   where id = p_run and status = 'running' for update;
  if v_log is null then
    raise exception 'an_onec_run_gone' using errcode = 'P0002';
  end if;
  if cardinality(v_log) > 1500 then
    v_log := v_log[cardinality(v_log) - 1499:];
  end if;
  update public.an_onec_runs
     set heartbeat_at = now(), progress = coalesce(p_progress, progress), log = v_log
   where id = p_run
  returning cancel_requested into v_cancel;
  return v_cancel;
end;
$$;
revoke all on function public.an_onec_run_progress(bigint, text, text[]) from public, anon, authenticated;
grant execute on function public.an_onec_run_progress(bigint, text, text[]) to service_role;

create or replace function public.an_onec_file_plan(p_file uuid, p_plan jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.an_onec_files set plan = p_plan where id = p_file
$$;
revoke all on function public.an_onec_file_plan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.an_onec_file_plan(uuid, jsonb) to service_role;

-- Пересобранный справочник номенклатуры (их build_reference пишет файл до
-- окна новых номенклатур).
create or replace function public.an_onec_nomenclature_store(p_run bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not exists (select 1 from public.an_onec_runs where id = p_run and status = 'running') then
    raise exception 'an_onec_run_gone' using errcode = 'P0002';
  end if;
  n := public.an_onec_ref_write('nomenclature', p_rows);
  perform public.an_onec_ref_touch('nomenclature', 'run', null);
  return n;
end;
$$;
revoke all on function public.an_onec_nomenclature_store(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.an_onec_nomenclature_store(bigint, jsonb) to service_role;

-- Новый снимок: свободный слот очищается, прежний необработанный «новый»
-- снимок уходит (у них новая обработка перезаписывает пакет).
create or replace function public.an_onec_snapshot_begin(p_run bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '20s'
as $$
declare
  v_slot smallint;
  v_id bigint;
begin
  if not exists (select 1 from public.an_onec_runs where id = p_run and status = 'running') then
    raise exception 'an_onec_run_gone' using errcode = 'P0002';
  end if;
  update public.an_onec_snapshots set state = 'discarded' where state in ('ready', 'building');
  select s into v_slot from generate_series(1, 3) s
   where s not in (select slot from public.an_onec_snapshots where state <> 'discarded')
   order by s limit 1;
  if v_slot is null then
    raise exception 'an_onec_no_slot' using errcode = 'P0001';
  end if;
  execute format('truncate table public.%I, public.%I', 'an_onec_facts_' || v_slot, 'an_onec_items_' || v_slot);
  insert into public.an_onec_snapshots (slot, state, run_id) values (v_slot, 'building', p_run)
  returning id into v_id;
  update public.an_onec_runs set snapshot_id = v_id where id = p_run;
  return jsonb_build_object('id', v_id, 'slot', v_slot);
end;
$$;
revoke all on function public.an_onec_snapshot_begin(bigint) from public, anon, authenticated;
grant execute on function public.an_onec_snapshot_begin(bigint) to service_role;

create or replace function public.an_onec_building_slot(p_snapshot bigint)
returns smallint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slot smallint;
begin
  select slot into v_slot from public.an_onec_snapshots where id = p_snapshot and state = 'building';
  if v_slot is null then
    raise exception 'an_onec_snapshot_gone' using errcode = 'P0002';
  end if;
  return v_slot;
end;
$$;
revoke all on function public.an_onec_building_slot(bigint) from public, anon, authenticated;
grant execute on function public.an_onec_building_slot(bigint) to service_role;

create or replace function public.an_onec_snapshot_items(
  p_snapshot bigint, p_ids integer[], p_report text[], p_city text[], p_studio text[],
  p_dimension text[], p_code text[], p_status text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot smallint := public.an_onec_building_slot(p_snapshot);
  n integer;
begin
  insert into public.an_onec_items (slot, id, report, city, studio, dimension, code, status)
  select v_slot, x.id, x.report, x.city, x.studio, x.dimension, x.code, x.status
    from unnest(p_ids, p_report, p_city, p_studio, p_dimension, p_code, p_status)
         x(id, report, city, studio, dimension, code, status)
  on conflict (slot, id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.an_onec_snapshot_items(bigint, integer[], text[], text[], text[], text[], text[], text[])
  from public, anon, authenticated;
grant execute on function public.an_onec_snapshot_items(bigint, integer[], text[], text[], text[], text[], text[], text[])
  to service_role;

-- Факты пачкой: один (item, день) может прийти и в следующей пачке — тогда
-- значения складываются (их ON CONFLICT … v = facts.v + excluded.v). p_seq —
-- номер пачки по порядку с 1: уже записанная (повтор после обрыва связи)
-- пропускается, пропуск номера — ошибка.
create or replace function public.an_onec_snapshot_facts(
  p_snapshot bigint, p_seq integer, p_item integer[], p_day date[],
  p_v1 double precision[], p_v2 double precision[], p_v3 double precision[], p_v4 double precision[],
  p_v5 double precision[], p_v6 double precision[], p_v7 double precision[], p_v8 double precision[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot smallint := public.an_onec_building_slot(p_snapshot);
  v_seq integer;
  n integer;
begin
  select facts_seq into v_seq from public.an_onec_snapshots where id = p_snapshot for update;
  if p_seq <= v_seq then
    return 0;
  end if;
  if p_seq <> v_seq + 1 then
    raise exception 'an_onec_seq_gap' using errcode = 'P0001';
  end if;
  update public.an_onec_snapshots set facts_seq = p_seq where id = p_snapshot;
  insert into public.an_onec_facts as f (slot, item_id, day, v1, v2, v3, v4, v5, v6, v7, v8)
  select v_slot, x.item, x.day, x.v1, x.v2, x.v3, x.v4, x.v5, x.v6, x.v7, x.v8
    from unnest(p_item, p_day, p_v1, p_v2, p_v3, p_v4, p_v5, p_v6, p_v7, p_v8)
         x(item, day, v1, v2, v3, v4, v5, v6, v7, v8)
  on conflict (slot, item_id, day) do update
    set v1 = f.v1 + excluded.v1, v2 = f.v2 + excluded.v2, v3 = f.v3 + excluded.v3,
        v4 = f.v4 + excluded.v4, v5 = f.v5 + excluded.v5, v6 = f.v6 + excluded.v6,
        v7 = f.v7 + excluded.v7, v8 = f.v8 + excluded.v8;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.an_onec_snapshot_facts(bigint, integer, integer[], date[], double precision[],
  double precision[], double precision[], double precision[], double precision[], double precision[],
  double precision[], double precision[]) from public, anon, authenticated;
grant execute on function public.an_onec_snapshot_facts(bigint, integer, integer[], date[], double precision[],
  double precision[], double precision[], double precision[], double precision[], double precision[],
  double precision[], double precision[]) to service_role;

-- Окно новых номенклатур: обработка остановлена, ждёт выбора категорий.
create or replace function public.an_onec_run_review(p_run bigint, p_review jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_review->'items') is distinct from 'array'
     or jsonb_typeof(p_review->'choices') is distinct from 'array' then
    raise exception 'an_onec_bad_review' using errcode = '22023';
  end if;
  update public.an_onec_runs
     set status = 'review', review = p_review, finished_at = now(), heartbeat_at = now(),
         progress = 'Выберите категории новых номенклатур…'
   where id = p_run and status = 'running';
  if not found then
    raise exception 'an_onec_run_gone' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.an_onec_run_review(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.an_onec_run_review(bigint, jsonb) to service_role;

-- Итог: покрытие считается по записанному снимку (их build: coverage), meta
-- — как их metadata.snapshot, проверки — их onec_validate.
create or replace function public.an_onec_run_finish(p_run bigint, p_snapshot bigint, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot smallint := public.an_onec_building_slot(p_snapshot);
  v_reports text[] := array['revenue', 'sales', 'activities', 'funnel', 'trial_products', 'zero'];
  v_coverage jsonb := '{}';
  v_meta jsonb;
  v_be jsonb := coalesce(p_result->'breakEven', '{}');
  rec record;
  rep text;
begin
  if not exists (select 1 from public.an_onec_snapshots where id = p_snapshot and run_id = p_run) then
    raise exception 'an_onec_snapshot_gone' using errcode = 'P0002';
  end if;
  if jsonb_typeof(v_be) <> 'object' or (select count(*) from jsonb_object_keys(v_be)) > 10000
     or exists (select 1 from jsonb_each(v_be) e where jsonb_typeof(e.value) <> 'number') then
    raise exception 'Неверный справочник точки 0';
  end if;
  foreach rep in array v_reports loop
    v_coverage := v_coverage || jsonb_build_object(rep, jsonb_build_object(
      'rows', 0, 'min', null, 'max', null, 'totals', jsonb_build_array(0, 0, 0, 0, 0, 0, 0, 0),
      'source_rows', coalesce((p_result->'source_rows'->>rep)::bigint, 0)));
  end loop;
  for rec in
    select i.report, count(*) as n, min(f.day) as dmin, max(f.day) as dmax,
           jsonb_build_array(sum(f.v1), sum(f.v2), sum(f.v3), sum(f.v4), sum(f.v5), sum(f.v6),
                             sum(f.v7), sum(f.v8)) as totals
      from public.an_onec_facts f
      join public.an_onec_items i on i.slot = f.slot and i.id = f.item_id
     where f.slot = v_slot and i.slot = v_slot
     group by i.report
  loop
    v_coverage := jsonb_set(v_coverage, array[rec.report], jsonb_build_object(
      'rows', rec.n, 'min', to_char(rec.dmin, 'YYYY-MM-DD'), 'max', to_char(rec.dmax, 'YYYY-MM-DD'),
      'totals', rec.totals,
      'source_rows', coalesce((p_result->'source_rows'->>rec.report)::bigint, 0)));
  end loop;
  v_meta := jsonb_build_object(
    'version', 1,
    'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
    'coverage', v_coverage,
    'issues', coalesce(p_result->'issues', '{}'),
    'breakEven', v_be,
    'zeroControls', coalesce(p_result->'zeroControls', '{}'),
    'coverage_notice', 'Диапазон наблюдаемых записей; полнота исходных выгрузок не подтверждена.',
    'semantics', 'Новые продажи и атрибуция пробных рассчитаны локально по полной доступной истории; период воронки по дате пробного.'
  );
  update public.an_onec_snapshots set state = 'ready', meta = v_meta, ready_at = now() where id = p_snapshot;
  update public.an_onec_runs
     set status = 'done', finished_at = now(), heartbeat_at = now(),
         progress = 'Обработка завершена. Можно загрузить данные в отчёты.',
         result = jsonb_build_object('coverage', v_coverage, 'issues', v_meta->'issues',
           'zeroControls', v_meta->'zeroControls', 'breakEvenCities', (select count(*) from jsonb_object_keys(v_be)),
           'stats', coalesce(p_result->'stats', '{}'), 'seconds', p_result->'seconds')
   where id = p_run and status = 'running';
  if not found then
    raise exception 'an_onec_run_gone' using errcode = 'P0002';
  end if;
  return v_meta;
end;
$$;
revoke all on function public.an_onec_run_finish(bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.an_onec_run_finish(bigint, bigint, jsonb) to service_role;

-- Ошибка или отмена: снимок этого запуска не сохраняется (у них пакет не
-- создаётся и на сервер не загружается).
create or replace function public.an_onec_run_fail(p_run bigint, p_error text, p_cancelled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.an_onec_snapshots set state = 'discarded' where run_id = p_run and state = 'building';
  update public.an_onec_runs
     set status = case when p_cancelled then 'cancelled' else 'error' end,
         error = left(coalesce(p_error, 'Ошибка обработки'), 4000), finished_at = now(),
         progress = 'Операция не завершена — смотрите журнал.'
   where id = p_run and status = 'running';
end;
$$;
revoke all on function public.an_onec_run_fail(bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.an_onec_run_fail(bigint, text, boolean) to service_role;
