-- ============================================================================
-- «Аналитика» → FitBase, часть 1 (ANALYTICS.md, «FitBase»; ANALYTICS_PLAN.md,
-- §8.2): подключения студий, загрузка из API FitBase v2, ночная очередь,
-- правила этапов, источников и статусов записей — их fitbase_runtime.py
-- (FitBaseIntegration) и fitbase_trials.repair_metadata.
--
-- Их SQLite fitbase.sqlite3 → таблицы an_fb_*: connections → an_fb_connections
-- (ключ API — an_secrets kind 'fitbase', ref = id, шифрует сервер портала),
-- leads → an_fb_leads, subscription_sales / _history / _payments /
-- _refund_audit → an_fb_sales / an_fb_history / an_fb_payments /
-- an_fb_refund_audit, attendance_events / _records → an_fb_events /
-- an_fb_records, trial_products / trial_snapshots / fitbase_trial_evidence /
-- fitbase_trial_quality → an_fb_trial_*, revenue_payments / revenue_daily →
-- an_fb_revenue_*, sync_batch → an_fb_batch, nightly_schedule → an_fb_nightly.
-- Время фактов — секунды Unix, как у них (отчёты переводят их в МСК / Самару).
--
-- Их зашифрованные кэши выгрузок (incremental_data.payload, attendance_checks)
-- — файлы закрытого бакета an-fitbase (шифрует сервер, gzip + AES-256-GCM),
-- в базе — путь и метки (an_fb_incremental, an_fb_connections.checks_path).
-- Факты раздела сервер кладёт пачками в an_fb_staging и заменяет одной
-- транзакцией (an_fb_commit) — как их «DELETE + INSERT» в одной транзакции.
--
-- Таблицы закрыты браузеру; администратору аналитики — RPC an_fb_* (подключения,
-- правила, статусы), сервер портала (service_role) пишет загрузку.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Подключения -----------------------------------------------------------------------

create table if not exists public.an_fb_connections (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 150),
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  city text not null check (char_length(city) between 1 and 100),
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  club_id text not null default '',
  -- Их metadata: {clubs, funnels, steps, sources} из «Проверить подключение».
  metadata jsonb not null default '{}',
  step_rules jsonb not null default '{}',
  source_rules jsonb not null default '{}',
  sync_state text not null default 'Не синхронизировано',
  synced_at bigint,
  job_progress text not null default '',
  full_sync boolean not null default false,
  marketing_disabled boolean not null default false,
  partner_name text not null default '' check (char_length(partner_name) <= 150),
  sales_synced_at bigint,
  sales_payments_at bigint,
  sales_state text not null default 'Продажи ещё не загружены',
  refund_checked_at bigint,
  refund_state text not null default 'Возвраты ещё не сверены',
  sync_attempt_at bigint,
  -- Их job_started_at — и метка «жива ли загрузка» (обновляется на каждой
  -- странице выгрузки): загрузка без отметки дольше 15 минут считается
  -- прерванной (у них — перезапуск портала).
  job_started_at bigint,
  attendance_synced_at bigint,
  attendance_state text not null default 'Занятия ещё не загружены',
  attendance_from text not null default '',
  attendance_to text not null default '',
  attendance_rules jsonb not null default '{}',
  studio_status text not null default 'active' check (studio_status in ('active', 'archived')),
  revenue_synced_at bigint,
  revenue_state text not null default 'Выручка ещё не загружена',
  revenue_from text not null default '',
  revenue_to text not null default '',
  -- Их attendance_checks: подтверждённые выгрузки занятий — один файл бакета.
  checks_path text not null default '',
  created_at timestamptz not null default now(),
  unique (domain, club_id)
);

create table if not exists public.an_fb_leads (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  lead_id text not null,
  client_key text not null,
  created_at bigint not null,
  step_id text not null,
  source_id text not null,
  primary key (connection_id, lead_id)
);
create index if not exists an_fb_leads_created_idx on public.an_fb_leads (connection_id, created_at, lead_id);

create table if not exists public.an_fb_sales (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  contract_id text not null,
  client_id text not null,
  purchased_at bigint not null,
  price_cents bigint not null,
  paid_cents bigint not null,
  primary key (connection_id, contract_id)
);

create table if not exists public.an_fb_history (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  contract_id text not null,
  client_id text not null,
  purchased_at bigint not null,
  price_cents bigint not null,
  primary key (connection_id, contract_id)
);

create table if not exists public.an_fb_payments (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  operation text not null,
  step_id text not null,
  contract_id text not null,
  client_id text not null,
  pay_at bigint not null,
  day text not null,
  amount_cents bigint not null,
  primary key (connection_id, operation, step_id)
);
create index if not exists an_fb_payments_day_idx on public.an_fb_payments (connection_id, day);

create table if not exists public.an_fb_refund_audit (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  contract_id text not null,
  reported_paid bigint not null,
  gross bigint not null,
  refund bigint not null,
  net bigint not null,
  effective_paid bigint,
  status text not null,
  primary key (connection_id, contract_id)
);

create table if not exists public.an_fb_events (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  event_id text not null,
  day text not null,
  end_at bigint not null,
  training_id text not null,
  training_name text not null,
  cancelled boolean not null,
  primary key (connection_id, event_id)
);
create index if not exists an_fb_events_day_idx on public.an_fb_events (connection_id, day, end_at);

create table if not exists public.an_fb_records (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  registration_id text not null,
  event_id text not null,
  client_key text not null,
  status text not null,
  primary key (connection_id, registration_id)
);
create index if not exists an_fb_records_event_idx on public.an_fb_records (connection_id, event_id);

create table if not exists public.an_fb_trial_products (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  kind text not null check (kind in ('contract', 'registration')),
  item_id text not null,
  label text not null,
  is_trial integer not null,
  primary key (connection_id, kind, item_id)
);

create table if not exists public.an_fb_trial_snapshots (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  kind text not null,
  saved_at bigint not null,
  primary key (connection_id, kind)
);

create table if not exists public.an_fb_trial_evidence (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  registration_id text not null,
  signature text not null,
  label text not null,
  is_trial integer not null,
  checked_at bigint not null,
  primary key (connection_id, registration_id)
);

create table if not exists public.an_fb_trial_quality (
  connection_id bigint primary key references public.an_fb_connections(id) on delete cascade,
  checked_at bigint not null,
  unknown_rows integer not null,
  received integer not null,
  reported integer,
  exhausted boolean not null
);

create table if not exists public.an_fb_revenue_payments (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  operation text not null,
  step_id text not null,
  pay_at bigint not null,
  day text not null,
  amount_cents bigint not null,
  item_type text not null,
  primary key (connection_id, operation, step_id)
);
create index if not exists an_fb_revenue_payments_day_idx on public.an_fb_revenue_payments (connection_id, day);

create table if not exists public.an_fb_revenue_daily (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  day text not null,
  amount_cents bigint not null,
  primary key (connection_id, day)
);

-- Их incremental_data без payload: выгрузка раздела — файл бакета object_path.
create table if not exists public.an_fb_incremental (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  scope text not null,
  endpoint text not null,
  params jsonb not null default '{}',
  object_path text not null default '',
  cursor_at bigint not null default 0,
  full_at bigint not null default 0,
  pending_at bigint,
  primary key (connection_id, scope)
);

-- Их sync_batch: общая загрузка всех студий (одна строка).
create table if not exists public.an_fb_batch (
  id integer primary key check (id = 1),
  active boolean not null default false,
  payload jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
insert into public.an_fb_batch (id) values (1) on conflict (id) do nothing;

-- Их nightly_schedule (+ текст ошибки планировщика — у них в памяти процесса).
create table if not exists public.an_fb_nightly (
  id integer primary key check (id = 1),
  last_run_day text not null default '',
  error text not null default ''
);
insert into public.an_fb_nightly (id) values (1) on conflict (id) do nothing;

-- Пачки фактов раздела до замены (an_fb_commit).
create table if not exists public.an_fb_staging (
  run uuid not null,
  kind text not null,
  seq bigint generated always as identity,
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  created_at timestamptz not null default now(),
  primary key (run, kind, seq)
);

alter table public.an_fb_connections enable row level security;
alter table public.an_fb_leads enable row level security;
alter table public.an_fb_sales enable row level security;
alter table public.an_fb_history enable row level security;
alter table public.an_fb_payments enable row level security;
alter table public.an_fb_refund_audit enable row level security;
alter table public.an_fb_events enable row level security;
alter table public.an_fb_records enable row level security;
alter table public.an_fb_trial_products enable row level security;
alter table public.an_fb_trial_snapshots enable row level security;
alter table public.an_fb_trial_evidence enable row level security;
alter table public.an_fb_trial_quality enable row level security;
alter table public.an_fb_revenue_payments enable row level security;
alter table public.an_fb_revenue_daily enable row level security;
alter table public.an_fb_incremental enable row level security;
alter table public.an_fb_batch enable row level security;
alter table public.an_fb_nightly enable row level security;
alter table public.an_fb_staging enable row level security;
revoke all on public.an_fb_connections, public.an_fb_leads, public.an_fb_sales, public.an_fb_history,
  public.an_fb_payments, public.an_fb_refund_audit, public.an_fb_events, public.an_fb_records,
  public.an_fb_trial_products, public.an_fb_trial_snapshots, public.an_fb_trial_evidence,
  public.an_fb_trial_quality, public.an_fb_revenue_payments, public.an_fb_revenue_daily,
  public.an_fb_incremental, public.an_fb_batch, public.an_fb_nightly, public.an_fb_staging
  from anon, authenticated;
grant all on public.an_fb_connections, public.an_fb_leads, public.an_fb_sales, public.an_fb_history,
  public.an_fb_payments, public.an_fb_refund_audit, public.an_fb_events, public.an_fb_records,
  public.an_fb_trial_products, public.an_fb_trial_snapshots, public.an_fb_trial_evidence,
  public.an_fb_trial_quality, public.an_fb_revenue_payments, public.an_fb_revenue_daily,
  public.an_fb_incremental, public.an_fb_batch, public.an_fb_nightly, public.an_fb_staging
  to service_role;

-- Закрытый бакет кэша выгрузок: только сервер (service_role), политик нет.
insert into storage.buckets (id, name, public, file_size_limit)
values ('an-fitbase', 'an-fitbase', false, 209715200)
on conflict (id) do nothing;

-- 2) Общее ------------------------------------------------------------------------------

-- Загрузка «жива»: отметка job_started_at не старше 15 минут.
create or replace function public.an_fb_busy(p_state text, p_started bigint)
returns boolean
language sql
stable
as $$
  select p_state = 'Выполняется'
     and p_started is not null
     and p_started >= extract(epoch from now())::bigint - 900
$$;

-- Подключение для экранов: без ключа; оборванная загрузка — их текст после
-- перезапуска портала.
create or replace function public.an_fb_connection_json(c public.an_fb_connections)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'brand', c.brand, 'city', c.city, 'domain', c.domain,
    'club_id', c.club_id, 'partner_name', c.partner_name,
    'marketing_disabled', c.marketing_disabled, 'studio_status', c.studio_status,
    'sync_state', case
      when c.sync_state = 'Выполняется' and not public.an_fb_busy(c.sync_state, c.job_started_at)
        then 'Загрузка прервана перезапуском. Повторите обновление.'
      else c.sync_state end,
    'busy', public.an_fb_busy(c.sync_state, c.job_started_at),
    'job_progress', c.job_progress,
    'synced_at', c.synced_at, 'sync_attempt_at', c.sync_attempt_at,
    'sales_state', c.sales_state, 'sales_synced_at', c.sales_synced_at,
    'sales_payments_at', c.sales_payments_at,
    'refund_state', c.refund_state, 'refund_checked_at', c.refund_checked_at,
    'attendance_state', c.attendance_state, 'attendance_synced_at', c.attendance_synced_at,
    'attendance_from', c.attendance_from, 'attendance_to', c.attendance_to,
    'revenue_state', c.revenue_state, 'revenue_synced_at', c.revenue_synced_at,
    'revenue_from', c.revenue_from, 'revenue_to', c.revenue_to,
    'full_sync', c.full_sync,
    'has_key', exists (select 1 from public.an_secrets s
                        where s.kind = 'fitbase' and s.ref = c.id::text and s.name = 'api_key'))
$$;

-- Стереть загруженное студии (их сброс при смене домена или клуба). Пути
-- файлов бакета — серверу, он удалит их после ответа.
create or replace function public.an_fb_wipe(p_id bigint)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paths text[];
begin
  select coalesce(array_agg(object_path) filter (where object_path <> ''), '{}')
    into v_paths from public.an_fb_incremental where connection_id = p_id;
  select v_paths || case when checks_path <> '' then array[checks_path] else '{}'::text[] end
    into v_paths from public.an_fb_connections where id = p_id;
  delete from public.an_fb_leads where connection_id = p_id;
  delete from public.an_fb_payments where connection_id = p_id;
  delete from public.an_fb_history where connection_id = p_id;
  delete from public.an_fb_sales where connection_id = p_id;
  delete from public.an_fb_refund_audit where connection_id = p_id;
  delete from public.an_fb_trial_products where connection_id = p_id;
  delete from public.an_fb_trial_snapshots where connection_id = p_id;
  delete from public.an_fb_trial_evidence where connection_id = p_id;
  delete from public.an_fb_trial_quality where connection_id = p_id;
  delete from public.an_fb_records where connection_id = p_id;
  delete from public.an_fb_events where connection_id = p_id;
  delete from public.an_fb_incremental where connection_id = p_id;
  delete from public.an_fb_revenue_payments where connection_id = p_id;
  delete from public.an_fb_revenue_daily where connection_id = p_id;
  update public.an_fb_connections
     set sales_payments_at = null, refund_checked_at = null,
         refund_state = 'Возвраты ещё не сверены',
         revenue_synced_at = null, revenue_from = '', revenue_to = '',
         revenue_state = 'Выручка ещё не загружена',
         attendance_synced_at = null, attendance_from = '', attendance_to = '',
         attendance_rules = '{}', attendance_state = 'Занятия ещё не загружены',
         sales_synced_at = null, sales_state = 'Продажи ещё не загружены',
         checks_path = ''
   where id = p_id;
  return coalesce(v_paths, '{}');
end;
$$;
revoke all on function public.an_fb_wipe(bigint) from public, anon, authenticated;

-- 3) Подключения (администратору аналитики) ---------------------------------------------

-- Их fitbase_page: студии (направление, город, название), общая загрузка,
-- метка ночной загрузки.
create or replace function public.an_fb_connections()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(public.an_fb_connection_json(c)
                       order by c.brand collate "C", c.city collate "C", c.name collate "C")
        from public.an_fb_connections c), '[]'),
    'batch', (select b.payload || jsonb_build_object(
                'active', b.active and b.updated_at >= now() - interval '30 minutes',
                'interrupted', b.active and b.updated_at < now() - interval '30 minutes')
                from public.an_fb_batch b where b.id = 1),
    'nightly', (select jsonb_build_object('last_run_day', n.last_run_day, 'error', n.error)
                  from public.an_fb_nightly n where n.id = 1));
end;
$$;
revoke all on function public.an_fb_connections() from public, anon;
grant execute on function public.an_fb_connections() to authenticated;

-- Их настройки студии: подключение, справочники, правила, коды статусов
-- записей с примерами (их attendance_status_details).
create or replace function public.an_fb_connection(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
begin
  perform public.an_require_admin();
  select * into c from public.an_fb_connections where id = p_id;
  if c.id is null then
    raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
  end if;
  return public.an_fb_connection_json(c) || jsonb_build_object(
    'metadata', c.metadata, 'step_rules', c.step_rules, 'source_rules', c.source_rules,
    'attendance_rules', c.attendance_rules,
    'nightly', (select jsonb_build_object('last_run_day', n.last_run_day, 'error', n.error)
                  from public.an_fb_nightly n where n.id = 1),
    'status_details', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status', g.status, 'count', g.n,
               'examples', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'registration_id', x.registration_id, 'client_key', x.client_key,
                          'event_id', x.event_id, 'day', x.day, 'training_name', x.training_name))
                   from (select r.registration_id, r.client_key, r.event_id, e.day, e.training_name
                           from public.an_fb_records r
                           join public.an_fb_events e
                             on e.connection_id = r.connection_id and e.event_id = r.event_id
                          where r.connection_id = p_id and r.status = g.status
                          order by e.day collate "C" desc, r.registration_id collate "C"
                          limit 3) x), '[]'))
             order by (g.status !~ '^[0-9]+$'),
                      case when g.status ~ '^[0-9]{1,9}$' then g.status::integer end,
                      g.status collate "C")
        from (select status, count(*) as n from public.an_fb_records
               where connection_id = p_id group by status) g), '[]'));
end;
$$;
revoke all on function public.an_fb_connection(bigint) from public, anon;
grant execute on function public.an_fb_connection(bigint) to authenticated;

-- Их save(): поля уже очищены сервером (домен, ключ — их проверки до
-- шифрования); здесь — их проверки ещё раз, занятая студия, смена домена
-- (нужен ключ, всё загруженное стирается).
create or replace function public.an_fb_connection_save(p_id bigint, p_name text, p_brand text,
                                                        p_city text, p_domain text,
                                                        p_partner text,
                                                        p_marketing_disabled boolean,
                                                        p_key_cipher text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_city text := btrim(public.an_amo_canonical_city(p_brand, coalesce(p_city, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_partner text := btrim(coalesce(p_partner, ''));
  v_domain text := coalesce(p_domain, '');
  v_old public.an_fb_connections;
  v_id bigint;
  v_paths text[] := '{}';
begin
  perform public.an_require_admin();
  if v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception 'Нужен поддомен клуба FitBase, например lady-stretch.' using errcode = '22023';
  end if;
  if char_length(v_partner) > 150 then
    raise exception 'Имя партнёра — не больше 150 символов.' using errcode = '22023';
  end if;
  if v_name = '' or v_city = '' or char_length(v_name) > 150 or char_length(v_city) > 100
     or coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Заполните студию, направление и город.' using errcode = '22023';
  end if;
  if p_key_cipher is not null and p_key_cipher <> ''
     and p_key_cipher !~ '^[A-Za-z0-9+/]{38,}={0,2}$' then
    raise exception 'Ключ не зашифрован — сохраните его через портал.' using errcode = '22023';
  end if;
  if p_id is null then
    if coalesce(p_key_cipher, '') = '' then
      raise exception 'Введите API-ключ.' using errcode = '22023';
    end if;
    begin
      insert into public.an_fb_connections (name, brand, city, domain, partner_name, marketing_disabled)
      values (v_name, p_brand, v_city, v_domain, v_partner, coalesce(p_marketing_disabled, false))
      returning id into v_id;
    exception when unique_violation then
      raise exception 'Студия с этим доменом FitBase уже подключена.' using errcode = '23505';
    end;
  else
    select * into v_old from public.an_fb_connections where id = p_id for update;
    if v_old.id is null then
      raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
    end if;
    if public.an_fb_busy(v_old.sync_state, v_old.job_started_at) then
      raise exception 'Дождитесь завершения загрузки перед изменением подключения.' using errcode = '22023';
    end if;
    if v_old.domain <> v_domain and coalesce(p_key_cipher, '') = '' then
      raise exception 'При изменении домена введите его API-ключ.' using errcode = '22023';
    end if;
    begin
      update public.an_fb_connections
         set name = v_name, brand = p_brand, city = v_city, domain = v_domain,
             partner_name = v_partner, marketing_disabled = coalesce(p_marketing_disabled, false)
       where id = p_id;
    exception when unique_violation then
      raise exception 'Студия с этим доменом FitBase уже подключена.' using errcode = '23505';
    end;
    if v_old.domain <> v_domain then
      update public.an_fb_connections
         set club_id = '', metadata = '{}', step_rules = '{}', source_rules = '{}',
             synced_at = null, sync_state = 'Не синхронизировано'
       where id = p_id;
      v_paths := public.an_fb_wipe(p_id);
    end if;
    v_id := p_id;
  end if;
  if coalesce(p_key_cipher, '') <> '' then
    insert into public.an_secrets (kind, ref, name, ciphertext, updated_at, updated_by)
    values ('fitbase', v_id::text, 'api_key', p_key_cipher, now(), auth.uid())
    on conflict (kind, ref, name) do update
      set ciphertext = excluded.ciphertext, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by;
  end if;
  perform public.an_audit_add(auth.uid(), 'fitbase_save', v_id::text);
  return jsonb_build_object('id', v_id, 'removed_paths', to_jsonb(v_paths));
end;
$$;
revoke all on function public.an_fb_connection_save(bigint, text, text, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.an_fb_connection_save(bigint, text, text, text, text, text, boolean, text)
  to authenticated;

-- Их rules(): клуб — из справочника, все этапы с допустимыми исходами, все
-- источники с бюджетом; смена клуба стирает загруженное.
create or replace function public.an_fb_rules_save(p_id bigint, p_club text, p_steps jsonb,
                                                   p_sources jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
  v_paths text[] := '{}';
  v_valid text[];
  v_sources text[];
begin
  perform public.an_require_admin();
  select * into c from public.an_fb_connections where id = p_id for update;
  if c.id is null then
    raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
  end if;
  if public.an_fb_busy(c.sync_state, c.job_started_at) then
    raise exception 'Дождитесь завершения загрузки перед изменением правил.' using errcode = '22023';
  end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(c.metadata->'clubs', '[]')) x
                  where x->>'id' = coalesce(p_club, '')) then
    raise exception 'Выберите клуб из FitBase.' using errcode = '22023';
  end if;
  select coalesce(array_agg(x->>'id' order by x->>'id'), '{}') into v_valid
    from jsonb_array_elements(coalesce(c.metadata->'steps', '[]')) x;
  if jsonb_typeof(p_steps) <> 'object'
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_steps) k)
        is distinct from (select coalesce(array_agg(distinct v order by v), '{}') from unnest(v_valid) v)
     or exists (select 1 from jsonb_each(p_steps) e
                 where jsonb_typeof(e.value) <> 'string'
                    or e.value #>> '{}' not in ('new', 'working', 'booked', 'attended', 'paid',
                                                'no_show', 'no_purchase', 'lost', 'ignore')) then
    raise exception 'Обновите список этапов и проверьте правила.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x->>'id' order by x->>'id'), '{}') into v_sources
    from jsonb_array_elements(coalesce(c.metadata->'sources', '[]')) x;
  if jsonb_typeof(p_sources) <> 'object'
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_sources) k)
        is distinct from v_sources
     or exists (select 1 from jsonb_each(p_sources) e
                 where jsonb_typeof(e.value) <> 'string'
                    or e.value #>> '{}' not in ('none', 'community_messages', 'lead_forms')) then
    raise exception 'Некорректное сопоставление бюджетов.' using errcode = '22023';
  end if;
  if p_club <> c.club_id then
    v_paths := public.an_fb_wipe(p_id);
    update public.an_fb_connections set synced_at = null where id = p_id;
  end if;
  begin
    update public.an_fb_connections
       set club_id = p_club, step_rules = p_steps, source_rules = p_sources
     where id = p_id;
  exception when unique_violation then
    raise exception 'Этот клуб FitBase уже подключён другой студией с тем же доменом.' using errcode = '23505';
  end;
  perform public.an_audit_add(auth.uid(), 'fitbase_rules', p_id::text);
  return jsonb_build_object('removed_paths', to_jsonb(v_paths));
end;
$$;
revoke all on function public.an_fb_rules_save(bigint, text, jsonb, jsonb) from public, anon;
grant execute on function public.an_fb_rules_save(bigint, text, jsonb, jsonb) to authenticated;

-- Их attendance_settings(): статус студии и значения кодов записей (ровно
-- встреченные коды; пусто — «не определён»).
create or replace function public.an_fb_attendance_settings(p_id bigint, p_status text, p_rules jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
begin
  perform public.an_require_admin();
  select * into c from public.an_fb_connections where id = p_id for update;
  if c.id is null then
    raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
  end if;
  if public.an_fb_busy(c.sync_state, c.job_started_at) then
    raise exception 'Дождитесь окончания загрузки.' using errcode = '22023';
  end if;
  if coalesce(p_status, '') not in ('active', 'archived') then
    raise exception 'Выберите статус студии.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rules) <> 'object'
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_rules) k)
        is distinct from (select coalesce(array_agg(distinct status order by status), '{}')
                            from public.an_fb_records where connection_id = p_id)
     or exists (select 1 from jsonb_each(p_rules) e
                 where jsonb_typeof(e.value) <> 'string'
                    or e.value #>> '{}' not in ('', 'registered', 'confirmed', 'visited', 'no_show',
                                                'late_cancel', 'refused', 'waiting', 'pending_payment')) then
    raise exception 'Обновите страницу и проверьте статусы записей.' using errcode = '22023';
  end if;
  update public.an_fb_connections
     set studio_status = p_status, attendance_rules = p_rules,
         attendance_state = case when attendance_synced_at is not null then 'Занятия загружены'
                                 else attendance_state end
   where id = p_id;
  perform public.an_audit_add(auth.uid(), 'fitbase_attendance_rules', p_id::text);
end;
$$;
revoke all on function public.an_fb_attendance_settings(bigint, text, jsonb) from public, anon;
grant execute on function public.an_fb_attendance_settings(bigint, text, jsonb) to authenticated;

-- 4) Загрузка (сервер портала, service_role) ----------------------------------------------

-- Их start_job: студия — «Выполняется» (вторая загрузка — их ошибка;
-- оборванная перезапуском — снова можно); «всё» — full_sync.
create or replace function public.an_fb_job_begin(p_id bigint, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
  v_now bigint := extract(epoch from now())::bigint;
begin
  select * into c from public.an_fb_connections where id = p_id for update;
  if c.id is null then
    raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
  end if;
  if public.an_fb_busy(c.sync_state, c.job_started_at) then
    raise exception 'Для студии уже выполняется загрузка.' using errcode = '55006';
  end if;
  update public.an_fb_connections
     set sync_state = 'Выполняется', job_progress = 'Подключаемся к FitBase…',
         sync_attempt_at = v_now, job_started_at = v_now,
         full_sync = full_sync or p_action = 'all'
   where id = p_id
  returning * into c;
  return to_jsonb(c);
end;
$$;
revoke all on function public.an_fb_job_begin(bigint, text) from public, anon, authenticated;
grant execute on function public.an_fb_job_begin(bigint, text) to service_role;

-- Их incremental_fetch, первый шаг: выгрузка раздела отмечается
-- «в работе» (pending_at), новая — заводится пустой.
create or replace function public.an_fb_incremental_open(p_id bigint, p_scope text, p_endpoint text,
                                                         p_params jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.an_fb_incremental;
  v_now bigint := extract(epoch from now())::bigint;
begin
  select * into v_old from public.an_fb_incremental
   where connection_id = p_id and scope = p_scope for update;
  if v_old.scope is null then
    insert into public.an_fb_incremental (connection_id, scope, endpoint, params, pending_at)
    values (p_id, p_scope, p_endpoint, coalesce(p_params, '{}'), v_now);
    return null;
  end if;
  if v_old.pending_at is null then
    update public.an_fb_incremental set pending_at = v_now
     where connection_id = p_id and scope = p_scope;
  end if;
  return to_jsonb(v_old);
end;
$$;
revoke all on function public.an_fb_incremental_open(bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_incremental_open(bigint, text, text, jsonb) to service_role;

create or replace function public.an_fb_stage(p_run uuid, p_kind text, p_rows jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_fb_staging (run, kind, rows) values (p_run, p_kind, p_rows)
$$;
revoke all on function public.an_fb_stage(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_stage(uuid, text, jsonb) to service_role;

-- Строки пачек вида p_kind (порядок пачек — порядок отправки).
create or replace function public.an_fb_staged(p_run uuid, p_kind text)
returns setof jsonb
language sql
stable
set search_path = public
as $$
  select r.value
    from public.an_fb_staging s, jsonb_array_elements(s.rows) with ordinality r(value, n)
   where s.run = p_run and s.kind = p_kind
   order by s.seq, r.n
$$;
revoke all on function public.an_fb_staged(uuid, text) from public, anon, authenticated;

-- Их «DELETE + INSERT + commit_incremental» раздела одной транзакцией.
-- p_phase: leads / sales / refund / attendance / revenue / trials; p_state —
-- поля подключения; p_incremental — [{scope, endpoint, params, path,
-- cursor_at, full_at}]. Возвращает пути прежних файлов бакета (удалит сервер).
create or replace function public.an_fb_commit(p_run uuid, p_id bigint, p_phase text, p_state jsonb,
                                               p_incremental jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_old text;
  v_paths text[] := '{}';
  v_now bigint := extract(epoch from now())::bigint;
  v_state jsonb := coalesce(p_state, '{}');
begin
  perform 1 from public.an_fb_connections where id = p_id for update;
  if not found then
    raise exception 'Подключение FitBase не найдено.' using errcode = 'P0002';
  end if;

  if p_phase = 'leads' then
    delete from public.an_fb_leads where connection_id = p_id;
    insert into public.an_fb_leads (connection_id, lead_id, client_key, created_at, step_id, source_id)
    select p_id, r->>0, r->>1, (r->>2)::bigint, r->>3, r->>4 from public.an_fb_staged(p_run, 'leads') r
    on conflict (connection_id, lead_id) do update
      set client_key = excluded.client_key, created_at = excluded.created_at,
          step_id = excluded.step_id, source_id = excluded.source_id;
  elsif p_phase = 'sales' then
    delete from public.an_fb_sales where connection_id = p_id;
    delete from public.an_fb_history where connection_id = p_id;
    insert into public.an_fb_history (connection_id, contract_id, client_id, purchased_at, price_cents)
    select p_id, r->>0, r->>1, (r->>2)::bigint, (r->>3)::bigint from public.an_fb_staged(p_run, 'history') r
    on conflict (connection_id, contract_id) do update
      set client_id = excluded.client_id, purchased_at = excluded.purchased_at,
          price_cents = excluded.price_cents;
    delete from public.an_fb_trial_products where connection_id = p_id and kind = 'contract';
    insert into public.an_fb_trial_products (connection_id, kind, item_id, label, is_trial)
    select p_id, 'contract', r->>0, r->>1, (r->>2)::integer from public.an_fb_staged(p_run, 'products') r
    on conflict (connection_id, kind, item_id) do update
      set label = excluded.label, is_trial = excluded.is_trial;
    insert into public.an_fb_trial_snapshots (connection_id, kind, saved_at)
    values (p_id, 'contract', v_now)
    on conflict (connection_id, kind) do update set saved_at = excluded.saved_at;
    delete from public.an_fb_refund_audit where connection_id = p_id;
    update public.an_fb_connections
       set refund_checked_at = null, refund_state = 'Возвраты ещё не сверены'
     where id = p_id;
    insert into public.an_fb_sales (connection_id, contract_id, client_id, purchased_at, price_cents, paid_cents)
    select p_id, r->>0, r->>1, (r->>2)::bigint, (r->>3)::bigint, (r->>4)::bigint
      from public.an_fb_staged(p_run, 'sales') r
    on conflict (connection_id, contract_id) do update
      set client_id = excluded.client_id, purchased_at = excluded.purchased_at,
          price_cents = excluded.price_cents, paid_cents = excluded.paid_cents;
  elsif p_phase = 'refund' then
    delete from public.an_fb_refund_audit where connection_id = p_id;
    insert into public.an_fb_refund_audit (connection_id, contract_id, reported_paid, gross, refund,
                                           net, effective_paid, status)
    select p_id, r->>0, (r->>1)::bigint, (r->>2)::bigint, (r->>3)::bigint, (r->>4)::bigint,
           (r->>5)::bigint, r->>6
      from public.an_fb_staged(p_run, 'audit') r;
    delete from public.an_fb_payments where connection_id = p_id;
    insert into public.an_fb_payments (connection_id, operation, step_id, contract_id, client_id,
                                       pay_at, day, amount_cents)
    select p_id, r->>0, r->>1, r->>2, r->>3, (r->>4)::bigint, r->>5, (r->>6)::bigint
      from public.an_fb_staged(p_run, 'payments') r;
  elsif p_phase = 'attendance' then
    delete from public.an_fb_records where connection_id = p_id;
    delete from public.an_fb_events where connection_id = p_id;
    insert into public.an_fb_events (connection_id, event_id, day, end_at, training_id, training_name, cancelled)
    select p_id, r->>0, r->>1, (r->>2)::bigint, r->>3, r->>4, (r->>5)::boolean
      from public.an_fb_staged(p_run, 'events') r
    on conflict (connection_id, event_id) do update
      set day = excluded.day, end_at = excluded.end_at, training_id = excluded.training_id,
          training_name = excluded.training_name, cancelled = excluded.cancelled;
    insert into public.an_fb_records (connection_id, registration_id, event_id, client_key, status)
    select p_id, r->>0, r->>1, r->>2, r->>3 from public.an_fb_staged(p_run, 'records') r
    on conflict (connection_id, registration_id) do update
      set event_id = excluded.event_id, client_key = excluded.client_key, status = excluded.status;
    delete from public.an_fb_trial_products where connection_id = p_id and kind = 'registration';
    insert into public.an_fb_trial_products (connection_id, kind, item_id, label, is_trial)
    select p_id, 'registration', r->>0, r->>1, (r->>2)::integer from public.an_fb_staged(p_run, 'products') r
    on conflict (connection_id, kind, item_id) do update
      set label = excluded.label, is_trial = excluded.is_trial;
    if coalesce((v_state->>'trial_snapshot')::boolean, false) then
      insert into public.an_fb_trial_snapshots (connection_id, kind, saved_at)
      values (p_id, 'registration', v_now)
      on conflict (connection_id, kind) do update set saved_at = excluded.saved_at;
    else
      delete from public.an_fb_trial_snapshots where connection_id = p_id and kind = 'registration';
    end if;
  elsif p_phase = 'revenue' then
    delete from public.an_fb_revenue_payments where connection_id = p_id;
    insert into public.an_fb_revenue_payments (connection_id, operation, step_id, pay_at, day,
                                               amount_cents, item_type)
    select p_id, r->>0, r->>1, (r->>2)::bigint, r->>3, (r->>4)::bigint, r->>5
      from public.an_fb_staged(p_run, 'revenue') r
    on conflict (connection_id, operation, step_id) do update
      set pay_at = excluded.pay_at, day = excluded.day, amount_cents = excluded.amount_cents,
          item_type = excluded.item_type;
    delete from public.an_fb_revenue_daily where connection_id = p_id;
    insert into public.an_fb_revenue_daily (connection_id, day, amount_cents)
    select connection_id, day, sum(amount_cents) from public.an_fb_revenue_payments
     where connection_id = p_id group by connection_id, day;
  elsif p_phase = 'trials' then
    delete from public.an_fb_trial_products where connection_id = p_id and kind = 'registration';
    insert into public.an_fb_trial_products (connection_id, kind, item_id, label, is_trial)
    select p_id, 'registration', r->>0, r->>1, (r->>2)::integer from public.an_fb_staged(p_run, 'products') r
    on conflict (connection_id, kind, item_id) do update
      set label = excluded.label, is_trial = excluded.is_trial;
    delete from public.an_fb_trial_evidence where connection_id = p_id;
    insert into public.an_fb_trial_evidence (connection_id, registration_id, signature, label, is_trial, checked_at)
    select p_id, r->>0, r->>1, r->>2, (r->>3)::integer, v_now from public.an_fb_staged(p_run, 'evidence') r
    on conflict (connection_id, registration_id) do nothing;
    delete from public.an_fb_trial_snapshots where connection_id = p_id and kind = 'registration';
    if coalesce((v_state->>'trial_snapshot')::boolean, false) then
      insert into public.an_fb_trial_snapshots (connection_id, kind, saved_at)
      values (p_id, 'registration', v_now);
    end if;
    insert into public.an_fb_trial_quality (connection_id, checked_at, unknown_rows, received, reported, exhausted)
    values (p_id, v_now, (v_state->'quality'->>'unknown')::integer,
            (v_state->'quality'->>'received')::integer, (v_state->'quality'->>'reported')::integer,
            (v_state->'quality'->>'exhausted')::boolean)
    on conflict (connection_id) do update
      set checked_at = excluded.checked_at, unknown_rows = excluded.unknown_rows,
          received = excluded.received, reported = excluded.reported, exhausted = excluded.exhausted;
  else
    raise exception 'Неизвестный раздел загрузки FitBase.' using errcode = '22023';
  end if;

  -- Их commit_incremental: выгрузки раздела и подтверждённые занятия.
  for v_item in select value from jsonb_array_elements(coalesce(p_incremental, '[]')) loop
    select object_path into v_old from public.an_fb_incremental
     where connection_id = p_id and scope = v_item->>'scope';
    if v_old is not null and v_old <> '' and v_old <> v_item->>'path' then
      v_paths := v_paths || v_old;
    end if;
    insert into public.an_fb_incremental (connection_id, scope, endpoint, params, object_path,
                                          cursor_at, full_at, pending_at)
    values (p_id, v_item->>'scope', v_item->>'endpoint', coalesce(v_item->'params', '{}'),
            v_item->>'path', (v_item->>'cursor_at')::bigint, (v_item->>'full_at')::bigint, null)
    on conflict (connection_id, scope) do update
      set params = excluded.params, object_path = excluded.object_path,
          cursor_at = excluded.cursor_at, full_at = excluded.full_at, pending_at = null;
  end loop;
  if v_state ? 'checks_path' then
    select checks_path into v_old from public.an_fb_connections where id = p_id;
    if v_old <> '' and v_old <> v_state->>'checks_path' then
      v_paths := v_paths || v_old;
    end if;
  end if;

  -- Поля подключения раздела (их UPDATE connections SET … в той же транзакции).
  update public.an_fb_connections c
     set synced_at = case when v_state ? 'synced_at' then (v_state->>'synced_at')::bigint else c.synced_at end,
         sync_state = case when v_state ? 'sync_state' then v_state->>'sync_state' else c.sync_state end,
         job_progress = case when v_state ? 'job_progress' then v_state->>'job_progress' else c.job_progress end,
         sales_synced_at = case when v_state ? 'sales_synced_at' then (v_state->>'sales_synced_at')::bigint else c.sales_synced_at end,
         sales_state = case when v_state ? 'sales_state' then v_state->>'sales_state' else c.sales_state end,
         sales_payments_at = case when v_state ? 'sales_payments_at' then (v_state->>'sales_payments_at')::bigint else c.sales_payments_at end,
         refund_checked_at = case when v_state ? 'refund_checked_at' then (v_state->>'refund_checked_at')::bigint else c.refund_checked_at end,
         refund_state = case when v_state ? 'refund_state' then v_state->>'refund_state' else c.refund_state end,
         attendance_synced_at = case when v_state ? 'attendance_synced_at' then (v_state->>'attendance_synced_at')::bigint else c.attendance_synced_at end,
         attendance_state = case when v_state ? 'attendance_state' then v_state->>'attendance_state' else c.attendance_state end,
         attendance_from = case when v_state ? 'attendance_from' then v_state->>'attendance_from' else c.attendance_from end,
         attendance_to = case when v_state ? 'attendance_to' then v_state->>'attendance_to' else c.attendance_to end,
         attendance_rules = case when v_state ? 'attendance_rules' then v_state->'attendance_rules' else c.attendance_rules end,
         revenue_synced_at = case when v_state ? 'revenue_synced_at' then (v_state->>'revenue_synced_at')::bigint else c.revenue_synced_at end,
         revenue_state = case when v_state ? 'revenue_state' then v_state->>'revenue_state' else c.revenue_state end,
         revenue_from = case when v_state ? 'revenue_from' then v_state->>'revenue_from' else c.revenue_from end,
         revenue_to = case when v_state ? 'revenue_to' then v_state->>'revenue_to' else c.revenue_to end,
         checks_path = case when v_state ? 'checks_path' then v_state->>'checks_path' else c.checks_path end
   where c.id = p_id;

  delete from public.an_fb_staging where run = p_run or created_at < now() - interval '1 day';
  return jsonb_build_object('removed_paths', to_jsonb(v_paths));
end;
$$;
revoke all on function public.an_fb_commit(uuid, bigint, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_commit(uuid, bigint, text, jsonb, jsonb) to service_role;

-- Их start_all: общая загрузка — одна на портал (оборванная перезапуском —
-- снова можно).
create or replace function public.an_fb_batch_begin(p_payload jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.an_fb_batch
     set active = true, payload = p_payload, updated_at = now()
   where id = 1 and (not active or updated_at < now() - interval '30 minutes');
  return found;
end;
$$;
revoke all on function public.an_fb_batch_begin(jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_batch_begin(jsonb) to service_role;
