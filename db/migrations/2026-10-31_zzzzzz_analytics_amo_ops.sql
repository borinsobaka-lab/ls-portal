-- ============================================================================
-- «Аналитика» → «Операционная аналитика amoCRM» (ANALYTICS.md; их пилот
-- amocrm-operations: collector.py, api_client.py, metrics.py, report.py,
-- ui/report.html). Пилот: по одному подключению amoCRM за прошедший день
-- (МСК) — ограниченный GET-сбор сделок, событий и задач, очищенные факты
-- (только ID, время, этапы, ID ответственных; без текстов, имён и контактов
-- клиентов), отчёт «Реакция / Задачи / Источники и неквал / Полнота данных».
--
-- Их windows (снимок окна) → an_amo_ops_windows; их facts (последняя версия
-- каждого факта) отчёт не читает — не переносится; ручной запуск их
-- server_wizard → an_amo_ops_runs. Настройки (поля источника и оснований
-- закрытия, неквалифицирующие основания, имена ответственных) — из
-- «Интеграции amoCRM» (an_amo_settings, an_amo_basis, an_amo_responsibles,
-- an_amo_metadata), токен — an_secrets kind 'amocrm'.
--
-- Только администратору аналитики; сбор выполняет сервер портала
-- (service_role). Только чтение amoCRM. Идемпотентно.
-- ============================================================================

create table if not exists public.an_amo_ops_windows (
  connection_id bigint not null references public.an_amo_connections(id) on delete cascade,
  window_start bigint not null,
  window_end bigint not null,
  captured_at timestamptz not null default now(),
  -- Их snapshot: leads, tasks, events (очищенные), config, humans, bots,
  -- coverage, request_count, limitations.
  snapshot jsonb not null,
  primary key (connection_id, window_start, window_end)
);

create table if not exists public.an_amo_ops_runs (
  id bigint generated always as identity primary key,
  connection_id bigint not null references public.an_amo_connections(id) on delete cascade,
  day date not null,
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  message text not null default '',
  requests integer not null default 0,
  leads integer not null default 0,
  tasks integer not null default 0,
  events integer not null default 0,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists an_amo_ops_runs_started_idx on public.an_amo_ops_runs (started_at desc);

alter table public.an_amo_ops_windows enable row level security;
alter table public.an_amo_ops_runs enable row level security;
revoke all on public.an_amo_ops_windows, public.an_amo_ops_runs from public, anon, authenticated;
grant all on public.an_amo_ops_windows, public.an_amo_ops_runs to service_role;

-- Подключения (их list_connections: активные), запуски и собранные окна.
create or replace function public.an_amo_ops_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
               'has_settings', exists (select 1 from public.an_amo_settings s where s.connection_id = c.id))
             order by c.id), '[]')
        from public.an_amo_connections c where c.is_active),
    'runs', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'connection_id', r.connection_id,
               'connection', c.name, 'day', r.day, 'status', r.status, 'message', r.message,
               'requests', r.requests, 'leads', r.leads, 'tasks', r.tasks, 'events', r.events,
               'started_at', r.started_at, 'finished_at', r.finished_at)
             order by r.started_at desc), '[]')
        from (select * from public.an_amo_ops_runs order by started_at desc limit 20) r
        join public.an_amo_connections c on c.id = r.connection_id),
    'windows', (
      select coalesce(jsonb_agg(jsonb_build_object('connection_id', w.connection_id, 'connection', c.name,
               'start', w.window_start, 'end', w.window_end, 'captured_at', w.captured_at)
             order by w.window_start desc, w.connection_id), '[]')
        from public.an_amo_ops_windows w join public.an_amo_connections c on c.id = w.connection_id));
end;
$$;
revoke all on function public.an_amo_ops_overview() from public, anon;
grant execute on function public.an_amo_ops_overview() to authenticated;

-- Их build_report: снимок окна (без текстов и контактов клиентов).
create or replace function public.an_amo_ops_window(p_connection bigint, p_start bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  perform public.an_require_admin();
  select jsonb_build_object('account', w.connection_id::text, 'start', w.window_start, 'end', w.window_end,
           'captured_at', floor(extract(epoch from w.captured_at))::bigint, 'snapshot', w.snapshot)
    into v
    from public.an_amo_ops_windows w
   where w.connection_id = p_connection and w.window_start = p_start
   order by w.captured_at desc limit 1;
  if v is null then
    raise exception 'No complete pilot window for this account' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function public.an_amo_ops_window(bigint, bigint) from public, anon;
grant execute on function public.an_amo_ops_window(bigint, bigint) to authenticated;

-- Их load_connection: адрес, настройки, неквалифицирующие основания и имена
-- ответственных (сопоставления, затем пользователи из справочников).
create or replace function public.an_amo_ops_context(p_connection bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.an_amo_connections%rowtype;
  v_s public.an_amo_settings%rowtype;
  v_labels jsonb;
begin
  select * into v_c from public.an_amo_connections where id = p_connection;
  if not found or not v_c.is_active then
    raise exception 'Active portal connection not found' using errcode = 'P0002';
  end if;
  select * into v_s from public.an_amo_settings where connection_id = p_connection;
  if not found then
    raise exception 'Existing source/qualification settings are required' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_object_agg(x.id, x.name), '{}') into v_labels
    from (select distinct on (id) id, name from (
            select r.amo_user_id as id, r.amo_user_name as name, 0 as pri
              from public.an_amo_responsibles r where r.connection_id = p_connection
            union all
            select u->>'id', left(u->>'name', 150), 1
              from public.an_amo_metadata m, jsonb_array_elements(m.users) u
             where m.connection_id = p_connection and jsonb_typeof(u) = 'object'
               and coalesce(u->>'id', '') <> '' and coalesce(u->>'name', '') <> '') a
          order by id, pri) x;
  return jsonb_build_object(
    'id', v_c.id::text, 'base_url', v_c.base_url,
    'config', jsonb_build_object(
      'close_basis_field_id', v_s.close_basis_field_id,
      'auto_source_field_id', v_s.auto_source_field_id,
      'manual_source_field_id', v_s.manual_source_field_id,
      'unqualified_reasons', (select coalesce(jsonb_object_agg(b.field_value_id, b.field_value_name), '{}')
                                from public.an_amo_basis b
                               where b.connection_id = p_connection and b.is_unqualified),
      'user_labels', v_labels));
end;
$$;
revoke all on function public.an_amo_ops_context(bigint) from public, anon, authenticated;
grant execute on function public.an_amo_ops_context(bigint) to service_role;
