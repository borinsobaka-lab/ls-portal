-- ============================================================================
-- «Аналитика» → FitBase, часть 5 (ANALYTICS.md, «FitBase»): сборщик оснований
-- записей со страниц веб-интерфейса FitBase — их automatic-basis
-- (worker.py, web_source.py, configure_session.py). Список записей
-- `/client-schedule/index` отдаёт «Основание» записи (выбранная услуга или
-- абонемент), которого нет в API; сборщик кладёт его в an_fb_trial_basis
-- (часть 4), откуда тип записи берёт воронка пробных.
--
-- У них очередь — их queue.sqlite3 (jobs, seen, evidence) и status.json на
-- сервере; здесь — таблицы an_fb_basis_*. Сессию FitBase (cookies входа
-- владельца) сервер хранит шифртекстом в an_secrets (kind `fitbase_web`).
-- В очереди — только ID студии и записи, название основания, его ссылка и
-- дата занятия: без имён, телефонов и HTML (как у них).
--
-- Таблицы закрыты браузеру; администратору аналитики — RPC
-- an_fb_basis_overview, серверу (service_role) — таблицы напрямую.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- Их jobs: месяц студии (или «recent» — свежие записи за 3 дня), страница,
-- счётчики, сверка через сутки / неделю / 15 минут, обратный проход.
create table if not exists public.an_fb_basis_jobs (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  month text not null,
  owner text not null,
  lo text not null,
  hi text not null,
  page integer not null default 1,
  seen integer not null default 0,
  total integer,
  finished_at bigint not null default 0,
  failed_at bigint not null default 0,
  error text not null default '',
  interval_seconds integer not null default 3600,
  anchor text not null default '',
  direction integer not null default 0,
  passes integer not null default 1,
  last_fingerprint text not null default '',
  last_page integer not null default 0,
  last_attempt bigint not null default 0,
  primary key (connection_id, month)
);

-- Их seen: ID записей, увиденные заданием (для сверки со счётчиком FitBase).
create table if not exists public.an_fb_basis_seen (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  month text not null,
  registration_id text not null,
  primary key (connection_id, month, registration_id)
);

-- Их evidence: основания со страниц, ещё не сопоставленные с загрузкой API
-- (повторяются в следующих проходах).
create table if not exists public.an_fb_basis_evidence (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  registration_id text not null,
  label text not null,
  reason_ref text not null default '',
  lesson_time text not null default '',
  captured_at bigint not null,
  primary key (connection_id, registration_id)
);

-- Их status.json: состояние последнего прохода и его счётчики.
create table if not exists public.an_fb_basis_status (
  id integer primary key check (id = 1),
  state text not null default 'not_authorized',
  checked_at bigint,
  counts jsonb not null default '{}'
);
insert into public.an_fb_basis_status (id) values (1) on conflict (id) do nothing;

-- Одноразовые коды помощника входа: портал выдаёт код, помощник на компьютере
-- владельца после входа в FitBase передаёт сессию с ним (хранится SHA-256).
create table if not exists public.an_fb_web_tokens (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.an_fb_basis_jobs enable row level security;
alter table public.an_fb_basis_seen enable row level security;
alter table public.an_fb_basis_evidence enable row level security;
alter table public.an_fb_basis_status enable row level security;
alter table public.an_fb_web_tokens enable row level security;
revoke all on public.an_fb_basis_jobs, public.an_fb_basis_seen, public.an_fb_basis_evidence,
  public.an_fb_basis_status, public.an_fb_web_tokens
  from public, anon, authenticated;
grant select, insert, update, delete on public.an_fb_basis_jobs, public.an_fb_basis_seen,
  public.an_fb_basis_evidence, public.an_fb_basis_status, public.an_fb_web_tokens
  to service_role;

-- Страница сборщика: состояние, сессия (без значений), задания, основания.
create or replace function public.an_fb_basis_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'status', (select jsonb_build_object('state', s.state, 'checked_at', s.checked_at, 'counts', s.counts)
                 from public.an_fb_basis_status s where s.id = 1),
    'session', (select jsonb_build_object('updated_at', x.updated_at)
                  from public.an_secrets x
                 where x.kind = 'fitbase_web' and x.ref = 'session' and x.name = 'session'),
    'job', (select jsonb_build_object('enabled', j.enabled) from public.an_job_state j where j.job = 'fitbase_basis'),
    'connections', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
                      'domain', c.domain, 'club_id', c.club_id)
                    order by c.brand collate "C", c.city collate "C", c.name collate "C"), '[]')
                      from public.an_fb_connections c),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('connection_id', j.connection_id, 'month', j.month,
               'page', j.page, 'seen', j.seen, 'total', j.total, 'finished_at', j.finished_at,
               'failed_at', j.failed_at, 'error', j.error, 'passes', j.passes, 'direction', j.direction,
               'last_attempt', j.last_attempt)
             order by j.connection_id, j.month), '[]')
               from public.an_fb_basis_jobs j),
    'basis', (select coalesce(jsonb_object_agg(b.connection_id::text, b.n), '{}')
                from (select connection_id, count(*) as n from public.an_fb_trial_basis group by 1) b),
    -- Основания со страниц, чьих записей ещё нет в загрузке API (повторятся).
    'pending', (select count(*) from public.an_fb_basis_evidence e
                 where not exists (select 1 from public.an_fb_records r
                                    where r.connection_id = e.connection_id
                                      and r.registration_id = e.registration_id))
  );
end;
$$;
revoke all on function public.an_fb_basis_overview() from public, anon;
grant execute on function public.an_fb_basis_overview() to authenticated;

-- Их jobs(): задания студий — месяцы загруженных занятий и текущий (сверка
-- раз в сутки, старых — раз в неделю), «recent» — записи, созданные за 3 дня,
-- занятия ±60 дней, каждые 15 минут (сбрасывается с новым днём); новый
-- владелец подключения начинает заново. Возвращает задания, которым пора.
create or replace function public.an_fb_basis_plan(p_conns jsonb, p_today date, p_now bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c jsonb;
  v_id bigint;
  v_scope text;
  m text;
  v_lo date;
  v_hi date;
  v_old public.an_fb_basis_jobs;
  v_ids bigint[] := '{}';
begin
  for c in select * from jsonb_array_elements(p_conns) loop
    v_id := (c->>'id')::bigint;
    v_scope := c->>'owner';
    v_ids := v_ids || v_id;
    for m in
      select distinct x.month from (
        select substr(e.day, 1, 7) as month from public.an_fb_events e where e.connection_id = v_id
        union select to_char(p_today, 'YYYY-MM')) x
    loop
      v_lo := (m || '-01')::date;
      v_hi := (date_trunc('month', v_lo) + interval '1 month - 1 day')::date;
      select * into v_old from public.an_fb_basis_jobs where connection_id = v_id and month = m;
      if found and v_old.owner <> v_scope then
        delete from public.an_fb_basis_jobs where connection_id = v_id and month = m;
        delete from public.an_fb_basis_seen where connection_id = v_id and month = m;
      end if;
      insert into public.an_fb_basis_jobs (connection_id, month, owner, lo, hi)
      values (v_id, m, v_scope, v_lo::text, v_hi::text)
      on conflict (connection_id, month) do nothing;
      update public.an_fb_basis_jobs
         set interval_seconds = case when v_hi >= p_today - 45 then 86400 else 604800 end
       where connection_id = v_id and month = m;
    end loop;
    insert into public.an_fb_basis_jobs (connection_id, month, owner, lo, hi, interval_seconds)
    values (v_id, 'recent', v_scope, (p_today - 60)::text, (p_today + 60)::text, 900)
    on conflict (connection_id, month) do nothing;
    select * into v_old from public.an_fb_basis_jobs where connection_id = v_id and month = 'recent';
    if v_old.owner <> v_scope then
      delete from public.an_fb_basis_seen where connection_id = v_id and month = 'recent';
      update public.an_fb_basis_jobs set owner = v_scope, page = 1, seen = 0, total = null, finished_at = 0
       where connection_id = v_id and month = 'recent';
    end if;
    if v_old.anchor <> p_today::text then
      delete from public.an_fb_basis_seen where connection_id = v_id and month = 'recent';
      update public.an_fb_basis_jobs
         set lo = (p_today - 60)::text, hi = (p_today + 60)::text, page = 1, seen = 0, total = null,
             finished_at = 0, failed_at = 0, error = '', anchor = p_today::text, direction = 0, passes = 1,
             last_fingerprint = '', last_page = 0
       where connection_id = v_id and month = 'recent';
    end if;
  end loop;
  return (select coalesce(jsonb_agg(to_jsonb(j)), '[]')
            from public.an_fb_basis_jobs j
           where j.connection_id = any (v_ids)
             and (j.finished_at = 0 or j.finished_at + j.interval_seconds <= p_now)
             and j.failed_at < p_now - 900);
end;
$$;
revoke all on function public.an_fb_basis_plan(jsonb, date, bigint) from public, anon, authenticated;
grant execute on function public.an_fb_basis_plan(jsonb, date, bigint) to service_role;

-- Их apply_evidence: владелец подключения сейчас, запись загрузки API (её
-- занятие и день) и время прежнего основания — по ID записей страницы.
create or replace function public.an_fb_basis_lookup(p_id bigint, p_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owner', (select public.an_fb_owner(c.domain, c.club_id) from public.an_fb_connections c where c.id = p_id),
    'records', (select coalesce(jsonb_object_agg(r.registration_id, jsonb_build_array(r.event_id, e.day)), '{}')
                  from public.an_fb_records r
                  join public.an_fb_events e on e.connection_id = r.connection_id and e.event_id = r.event_id
                 where r.connection_id = p_id and r.registration_id = any (p_ids)),
    'basis', (select coalesce(jsonb_object_agg(b.registration_id, b.captured_at), '{}')
                from public.an_fb_trial_basis b
               where b.connection_id = p_id and b.registration_id = any (p_ids)));
$$;
revoke all on function public.an_fb_basis_lookup(bigint, text[]) from public, anon, authenticated;
grant execute on function public.an_fb_basis_lookup(bigint, text[]) to service_role;
