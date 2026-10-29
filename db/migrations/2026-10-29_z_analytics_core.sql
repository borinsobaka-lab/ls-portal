-- ============================================================================
-- «Аналитика» — перенос портала аналитики Lady Stretch
-- (analytics.lady-stretching.ru), решения владельца 2026-10-29
-- (ANALYTICS_PLAN.md). Этот файл — фундамент раздела:
--
--   * права блока «Аналитика» в каталоге «Пользователей и ролей» — по одному
--     на каждый их «дашборд» (user_dashboard_access) и их типы людей:
--     администратор, партнёр, таргетолог, лид-менеджер;
--   * an_me — что открыто человеку, по их алгоритму allowed_dashboards
--     (app.py): администратор — всё; таргетолог — реестр таргета и маркетинг
--     LS/LJ всегда + выданное; партнёр (право «Партнёр» или есть города
--     партнёра) — «Мой город» + из выданного маркетинг, отзывы и отчёты
--     FitBase; остальным — выданное;
--   * города и карточки партнёров (их user_partner_cities, partner_profiles,
--     partner_city_settings);
--   * режимы модулей: «Зеркало» (данные приходят со старого портала агентом
--     синхронизации), «Проверка», «Основной»;
--   * ключи интеграций (an_secrets) — только сервер (service_role);
--   * фоновые задачи (an_job_state / an_job_runs) — аренда вместо блокировок:
--     сервер портала ходит в базу только через PostgREST;
--   * приём синхронизации: реестр таблиц-получателей и an_replica_apply
--     (upsert по ключу + удаление ключей; только service_role).
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Права ---------------------------------------------------------------------
insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('an.admin', 'analytics', 'Администратор аналитики',
   'Всё, что на старом портале аналитики делал администратор: все отчёты по всей сети, загрузки, подключения, планы, партнёры, посещаемость, диалоги VK.',
   'network', '{on}', null, 400),
  ('an.onec.revenue', 'analytics', '1С: Выручка', null, 'network', '{on}', null, 410),
  ('an.onec.sales', 'analytics', '1С: Продажи абонементов', null, 'network', '{on}', null, 411),
  ('an.onec.classes', 'analytics', '1С: Занятия', null, 'network', '{on}', null, 412),
  ('an.onec.trials', 'analytics', '1С: Воронка пробных', null, 'network', '{on}', null, 413),
  ('an.onec.zero', 'analytics', '1С: Нулевая номенклатура', null, 'network', '{on}', null, 414),
  ('an.onec.mycity', 'analytics', '1С: Мой город',
   'Партнёру — по его городам. Сотруднику без городов открывается, только если у него есть все четыре отчёта 1С: выручка, продажи, занятия и воронка (как на старом портале).',
   'network', '{on}', null, 415),
  ('an.fb.revenue', 'analytics', 'FitBase: Выручка (вся сеть)', null, 'network', '{on}', null, 420),
  ('an.fb.marketing', 'analytics', 'FitBase: Маркетинг (вся сеть)', null, 'network', '{on}', null, 421),
  ('an.fb.sales', 'analytics', 'FitBase: Продажи абонементов (вся сеть)', null, 'network', '{on}', null, 422),
  ('an.fb.attendance', 'analytics', 'FitBase: Занятия и посещаемость (вся сеть)', null, 'network', '{on}', null, 423),
  ('an.fb.trials', 'analytics', 'FitBase: Воронка пробных (вся сеть)', null, 'network', '{on}', null, 424),
  ('an.fb.mycity', 'analytics', 'FitBase: Мой город',
   'Только студии FitBase, отмеченные человеку в «Аналитике» → «Партнёры».',
   'network', '{on}', null, 425),
  ('an.mkt.ls', 'analytics', 'Маркетинг Lady Stretch', null, 'network', '{on}', null, 430),
  ('an.mkt.lj', 'analytics', 'Маркетинг Lady Jump', null, 'network', '{on}', null, 431),
  ('an.vk.register', 'analytics', 'Реестр таргета', null, 'network', '{on}', null, 432),
  ('an.avito.register', 'analytics', 'Реестр Авито', 'Всегда по всем городам, как на старом портале.',
   'network', '{on}', null, 433),
  ('an.reviews', 'analytics', 'Отзывы и оценки', 'Партнёру — по его городам.', 'network', '{on}', null, 434),
  ('an.partner', 'analytics', 'Партнёр: только свои города',
   'Отчёты — только по городам партнёра из «Аналитики» → «Партнёры»; без городов — ничего. Партнёру открыты «Мой город» и из выданного — маркетинг, отзывы и отчёты FitBase.',
   'network', '{on}', null, 440),
  ('an.targetologist', 'analytics', 'Таргетолог',
   'Реестр таргета и маркетинговые отчёты — всегда, только по парам «бренд + город», где он назначен таргетологом (по ФИО), как на старом портале.',
   'network', '{on}', null, 441),
  ('an.inbox', 'analytics', 'Лид-менеджер: диалоги VK',
   'Диалоги в назначенных сообществах, шаблоны, статистика менеджеров.',
   'network', '{on}', null, 442)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

-- 2) Стартовые роли (их типы людей) ----------------------------------------------
select public.access_seed_role('an_admin', 'Администратор аналитики',
  'Администратор старого портала аналитики: все отчёты, загрузки, подключения, партнёры.', '#7c3aed', 95, false,
  array['an.admin']);
select public.access_seed_role('an_partner', 'Партнёр — аналитика',
  '«Мой город», маркетинг Lady Stretch и отзывы — только по городам партнёра.', '#a21caf', 96, false,
  array['an.partner', 'an.onec.mycity', 'an.mkt.ls', 'an.reviews']);
select public.access_seed_role('an_targetologist', 'Таргетолог',
  'Реестр таргета и маркетинг по назначенным парам «бренд + город».', '#0284c7', 97, false,
  array['an.targetologist']);
select public.access_seed_role('an_lead_manager', 'Лид-менеджер',
  'Диалоги VK в назначенных сообществах.', '#16a34a', 98, false,
  array['an.inbox']);
select public.access_seed_role('an_staff', 'Сотрудник — аналитика',
  'Отчёты 1С по всей сети: выручка, продажи, занятия, воронка, нулевая номенклатура, «Мой город».', '#64748b', 99, false,
  array['an.onec.revenue', 'an.onec.sales', 'an.onec.classes', 'an.onec.trials', 'an.onec.zero',
        'an.onec.mycity']);

-- 3) Города и карточки партнёров ----------------------------------------------------
-- Как их user_partner_cities: город — строка («город» 1С: территория партнёра,
-- «Новосибирск 2», «Казань Восстания + Копылова»).
create table if not exists public.an_partner_cities (
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null check (char_length(btrim(city)) between 1 and 200),
  primary key (user_id, city)
);
create table if not exists public.an_partner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text check (phone is null or char_length(phone) <= 100),
  telegram text check (telegram is null or char_length(telegram) <= 200),
  max_messenger text check (max_messenger is null or char_length(max_messenger) <= 200),
  individual_entrepreneur text check (individual_entrepreneur is null or char_length(individual_entrepreneur) <= 300),
  inn text check (inn is null or inn ~ '^([0-9]{10}|[0-9]{12})$'),
  updated_at timestamptz not null default now()
);
create table if not exists public.an_partner_city_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null,
  trial_price text check (trial_price is null or char_length(trial_price) <= 200),
  directions text check (directions is null or char_length(directions) <= 2000),
  primary key (user_id, city)
);

-- 3б) Ядро старого портала (зеркало) ---------------------------------------------
-- Их таблицы portal.sqlite3 как есть: те же колонки, время — unix-секунды,
-- id — их. Без паролей и токенов сессий. Пишет только приём синхронизации
-- (агент на их сервере); связи между таблицами не проверяются — строки
-- приходят в любом порядке, как и у них внешние ключи не включены.
-- user_id / imported_at / imported_by у an_legacy_users — свои колонки
-- портала: кем человек стал у нас после переноса (ANALYTICS_PLAN.md, §10);
-- агент их не присылает и не перезаписывает.
create table if not exists public.an_legacy_users (
  id bigint primary key,
  login text not null,
  full_name text not null,
  role text not null,
  is_active integer not null default 1,
  created_at bigint not null,
  position text not null default '',
  partner_city text not null default '',
  is_targetologist integer not null default 0,
  is_lead_manager integer not null default 0,
  user_id uuid references auth.users(id) on delete set null,
  imported_at timestamptz,
  imported_by uuid references auth.users(id) on delete set null
);
create index if not exists an_legacy_users_user_idx on public.an_legacy_users (user_id);
create table if not exists public.an_legacy_dashboard_access (
  user_id bigint not null,
  dashboard_name text not null,
  primary key (user_id, dashboard_name)
);
create table if not exists public.an_legacy_partner_cities (
  user_id bigint not null,
  city text not null,
  primary key (user_id, city)
);
create table if not exists public.an_legacy_partner_profiles (
  user_id bigint primary key,
  phone text not null default '',
  telegram text not null default '',
  max_messenger text not null default '',
  individual_entrepreneur text not null default '',
  inn text not null default ''
);
create table if not exists public.an_legacy_partner_city_settings (
  user_id bigint not null,
  city text not null,
  trial_price text not null default '',
  directions text not null default '',
  primary key (user_id, city)
);
create table if not exists public.an_legacy_fitbase_connections (
  user_id bigint not null,
  connection_id bigint not null,
  domain text not null,
  club_id text not null,
  primary key (user_id, connection_id)
);
-- Сессии — без token_hash: для «Посещаемости» (входы, активное время).
create table if not exists public.an_legacy_sessions (
  id bigint primary key,
  user_id bigint not null,
  created_at bigint not null,
  last_seen_at bigint not null,
  ended_at bigint,
  last_active_at bigint not null default 0,
  active_seconds bigint not null default 0,
  expires_at bigint not null default 0
);
create index if not exists an_legacy_sessions_user_idx on public.an_legacy_sessions (user_id, last_seen_at);
create table if not exists public.an_legacy_activity (
  id bigint primary key,
  session_id bigint not null,
  user_id bigint not null,
  dashboard_name text not null,
  recorded_at bigint not null,
  active_seconds bigint not null
);
create index if not exists an_legacy_activity_user_idx on public.an_legacy_activity (user_id, recorded_at);
create table if not exists public.an_legacy_audit (
  id bigint primary key,
  user_id bigint,
  event text not null,
  details text,
  created_at bigint not null
);
create index if not exists an_legacy_audit_at_idx on public.an_legacy_audit (created_at);

-- 4) Режимы модулей ------------------------------------------------------------------
create table if not exists public.an_modules (
  module text primary key
    check (module in ('core', 'onec', 'fitbase', 'crm', 'vk', 'avito', 'reviews', 'quiz', 'inbox', 'content')),
  mode text not null default 'mirror' check (mode in ('mirror', 'check', 'primary')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into public.an_modules (module)
select m from unnest(array['core', 'onec', 'fitbase', 'crm', 'vk', 'avito', 'reviews', 'quiz', 'inbox', 'content']) m
on conflict (module) do nothing;

-- 5) Ключи интеграций ------------------------------------------------------------------
-- Шифртекст AES-256-GCM (ключ ANALYTICS_SECRETS_KEY — только у сервера портала).
-- Из браузера не читается и не пишется: ни грантов, ни политик.
create table if not exists public.an_secrets (
  kind text not null,
  ref text not null,
  name text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (kind, ref, name)
);

-- 6) Фоновые задачи ------------------------------------------------------------------
create table if not exists public.an_job_state (
  job text primary key check (char_length(job) between 1 and 80),
  enabled boolean not null default true,
  -- Аренда: пока не истекла, задачу выполняет кто-то другой.
  running_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status in ('success', 'partial', 'error')),
  last_message text,
  last_duration_ms integer
);
create table if not exists public.an_job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  status text not null check (status in ('success', 'partial', 'error')),
  message text,
  details jsonb not null default '{}'
);
create index if not exists an_job_runs_job_idx on public.an_job_runs (job, started_at desc);

-- 7) Приём синхронизации ------------------------------------------------------------
-- Таблица-получатель регистрируется своей миграцией модуля: ключ upsert.
create table if not exists public.an_replica_targets (
  target text primary key,
  module text not null references public.an_modules(module),
  key_cols text[] not null check (cardinality(key_cols) > 0)
);
create table if not exists public.an_replica_log (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  batch text,
  target text not null,
  upserts integer not null default 0,
  deletes integer not null default 0,
  duration_ms integer,
  error text,
  -- У отметки агента (target = 'agent'): версия, сервер, итог по таблицам.
  details jsonb
);
create index if not exists an_replica_log_target_idx on public.an_replica_log (target, received_at desc);
create index if not exists an_replica_log_at_idx on public.an_replica_log (received_at desc);

insert into public.an_replica_targets (target, module, key_cols) values
  ('an_legacy_users', 'core', '{id}'),
  ('an_legacy_dashboard_access', 'core', '{user_id,dashboard_name}'),
  ('an_legacy_partner_cities', 'core', '{user_id,city}'),
  ('an_legacy_partner_profiles', 'core', '{user_id}'),
  ('an_legacy_partner_city_settings', 'core', '{user_id,city}'),
  ('an_legacy_fitbase_connections', 'core', '{user_id,connection_id}'),
  ('an_legacy_sessions', 'core', '{id}'),
  ('an_legacy_activity', 'core', '{id}'),
  ('an_legacy_audit', 'core', '{id}')
on conflict (target) do update set module = excluded.module, key_cols = excluded.key_cols;

-- 8) Доступ к таблицам ------------------------------------------------------------------
alter table public.an_partner_cities enable row level security;
alter table public.an_partner_profiles enable row level security;
alter table public.an_partner_city_settings enable row level security;
alter table public.an_modules enable row level security;
alter table public.an_secrets enable row level security;
alter table public.an_job_state enable row level security;
alter table public.an_job_runs enable row level security;
alter table public.an_replica_targets enable row level security;
alter table public.an_replica_log enable row level security;
alter table public.an_legacy_users enable row level security;
alter table public.an_legacy_dashboard_access enable row level security;
alter table public.an_legacy_partner_cities enable row level security;
alter table public.an_legacy_partner_profiles enable row level security;
alter table public.an_legacy_partner_city_settings enable row level security;
alter table public.an_legacy_fitbase_connections enable row level security;
alter table public.an_legacy_sessions enable row level security;
alter table public.an_legacy_activity enable row level security;
alter table public.an_legacy_audit enable row level security;

revoke all on public.an_partner_cities, public.an_partner_profiles, public.an_partner_city_settings,
  public.an_modules, public.an_secrets, public.an_job_state, public.an_job_runs,
  public.an_replica_targets, public.an_replica_log,
  public.an_legacy_users, public.an_legacy_dashboard_access, public.an_legacy_partner_cities,
  public.an_legacy_partner_profiles, public.an_legacy_partner_city_settings,
  public.an_legacy_fitbase_connections, public.an_legacy_sessions, public.an_legacy_activity,
  public.an_legacy_audit from anon, authenticated;
grant all on public.an_partner_cities, public.an_partner_profiles, public.an_partner_city_settings,
  public.an_modules, public.an_secrets, public.an_job_state, public.an_job_runs,
  public.an_replica_targets, public.an_replica_log,
  public.an_legacy_users, public.an_legacy_dashboard_access, public.an_legacy_partner_cities,
  public.an_legacy_partner_profiles, public.an_legacy_partner_city_settings,
  public.an_legacy_fitbase_connections, public.an_legacy_sessions, public.an_legacy_activity,
  public.an_legacy_audit to service_role;

-- 9) Права человека ---------------------------------------------------------------------
-- Администратор аналитики: право «Администратор аналитики» или суперадминистратор.
create or replace function public.an_is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(_user_id, 'an.admin') or public.access_has_right(_user_id, 'portal.admin')
$$;
revoke all on function public.an_is_admin(uuid) from public, anon;
grant execute on function public.an_is_admin(uuid) to authenticated, service_role;

-- Что открыто человеку — их allowed_dashboards (app.py) на правах из ролей.
create or replace function public.an_me_for(_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_all text[] := array['onec.revenue', 'onec.sales', 'onec.classes', 'onec.trials', 'onec.zero',
    'onec.mycity', 'fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity',
    'mkt.ls', 'mkt.lj', 'vk.register', 'avito.register', 'reviews'];
  v_fb text[] := array['fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity'];
  v_rights text[];
  v_admin boolean;
  v_granted text[];
  v_cities text[];
  v_partner boolean;
  v_target text;
  v_reports text[];
  v_inbox boolean;
begin
  if _user_id is null then
    return null;
  end if;
  select coalesce(r.rights, '{}') into v_rights
    from public.access_user_rights r where r.user_id = _user_id and r.portal;
  v_rights := coalesce(v_rights, '{}');
  v_admin := 'an.admin' = any (v_rights) or 'portal.admin' = any (v_rights);
  v_granted := array(select substr(x, 4) from unnest(v_rights) x
                      where x like 'an.%' and substr(x, 4) = any (v_all));
  select array_agg(city order by city) into v_cities
    from public.an_partner_cities where user_id = _user_id;
  v_partner := not v_admin and ('an.partner' = any (v_rights) or v_cities is not null);
  if not v_admin and 'an.targetologist' = any (v_rights) then
    -- ФИО — ключ назначений таргетологов (как у них). Перенесённому со
    -- старого портала — его ФИО там: назначения приходят оттуда зеркалом.
    select nullif(btrim(full_name), '') into v_target
      from public.an_legacy_users where user_id = _user_id order by is_active desc, id limit 1;
    if v_target is null then
      select nullif(btrim(full_name), '') into v_target from public.profiles where id = _user_id;
    end if;
    v_target := coalesce(v_target, '');
  end if;

  if v_admin then
    v_reports := v_all;
  elsif v_target is not null then
    -- Таргетолог: реестр таргета и маркетинг всегда + всё выданное.
    v_reports := array(select distinct x from unnest(array['vk.register', 'mkt.ls', 'mkt.lj'] || v_granted) x);
  elsif v_partner then
    -- Партнёр: «Мой город» + маркетинг и отзывы + отчёты FitBase из выданного.
    v_reports := array(select distinct x from unnest(
      array['onec.mycity']
      || array(select g from unnest(v_granted) g
                where g = any (array['mkt.ls', 'mkt.lj', 'reviews'] || v_fb))) x);
  else
    v_reports := v_granted;
  end if;
  v_inbox := v_admin or 'an.inbox' = any (v_rights);

  return jsonb_build_object(
    'visible', v_admin or cardinality(v_reports) > 0 or v_inbox,
    'admin', v_admin,
    'reports', to_jsonb(v_reports),
    'partner_cities', case when v_partner then to_jsonb(coalesce(v_cities, '{}')) end,
    'targetologist', v_target,
    'inbox', v_inbox
  );
end;
$$;
revoke all on function public.an_me_for(uuid) from public, anon, authenticated;
grant execute on function public.an_me_for(uuid) to service_role;

create or replace function public.an_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.an_me_for(auth.uid())
$$;
revoke all on function public.an_me() from public, anon;
grant execute on function public.an_me() to authenticated, service_role;

create or replace function public.an_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.an_is_admin(auth.uid()) then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.an_require_admin() from public, anon;
grant execute on function public.an_require_admin() to authenticated, service_role;

-- 10) Режимы модулей: чтение — всем в разделе, смена — администратору ---------------
create or replace function public.an_modules_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('module', m.module, 'mode', m.mode,
           'updated_at', m.updated_at, 'updated_by', public.access_user_name(m.updated_by))
           order by m.module), '[]'::jsonb)
    from public.an_modules m
   where (public.an_me_for(auth.uid()) ->> 'visible')::boolean
$$;
revoke all on function public.an_modules_list() from public, anon;
grant execute on function public.an_modules_list() to authenticated, service_role;

create or replace function public.an_module_set(p_module text, p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if p_mode not in ('mirror', 'check', 'primary') then
    raise exception 'an_bad_mode' using errcode = '22023';
  end if;
  update public.an_modules
     set mode = p_mode, updated_at = now(), updated_by = auth.uid()
   where module = p_module and mode <> p_mode;
end;
$$;
revoke all on function public.an_module_set(text, text) from public, anon;
grant execute on function public.an_module_set(text, text) to authenticated, service_role;

-- 11) Фоновые задачи: аренда и итог (сервер, service_role) ---------------------------
create or replace function public.an_job_claim(p_job text, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  insert into public.an_job_state (job) values (p_job) on conflict (job) do nothing;
  update public.an_job_state
     set running_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
         last_started_at = now()
   where job = p_job and enabled and (running_until is null or running_until < now())
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;
revoke all on function public.an_job_claim(text, integer) from public, anon, authenticated;
grant execute on function public.an_job_claim(text, integer) to service_role;

create or replace function public.an_job_finish(p_job text, p_status text, p_message text, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz;
begin
  update public.an_job_state
     set running_until = null, last_finished_at = now(), last_status = p_status,
         last_message = left(p_message, 2000),
         last_duration_ms = (extract(epoch from now() - last_started_at) * 1000)::integer
   where job = p_job
  returning last_started_at into v_started;
  insert into public.an_job_runs (job, started_at, status, message, details)
  values (p_job, coalesce(v_started, now()), p_status, left(p_message, 2000), coalesce(p_details, '{}'));
  -- Журнал — 30 дней (у старого портала журналы росли без очистки).
  delete from public.an_job_runs where job = p_job and started_at < now() - interval '30 days';
end;
$$;
revoke all on function public.an_job_finish(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_job_finish(text, text, text, jsonb) to service_role;

create or replace function public.an_jobs_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.an_is_admin(auth.uid()) then
    coalesce((select jsonb_agg(to_jsonb(s) order by s.job) from public.an_job_state s), '[]'::jsonb)
  end
$$;
revoke all on function public.an_jobs_list() from public, anon;
grant execute on function public.an_jobs_list() to authenticated, service_role;

-- 12) Приём синхронизации (сервер, service_role) --------------------------------------
-- Строки — json-объекты с колонками таблицы-получателя: upsert по её ключу.
-- Пишутся только присланные колонки (по первой строке пачки): свои колонки
-- получателя (например, связь с пользователем портала) синхронизация не
-- трогает. p_delete — объекты с ключевыми колонками: удалить. Пачка — одна
-- транзакция.
create or replace function public.an_replica_apply(p_target text, p_rows jsonb, p_delete jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keys text[];
  v_cols text;
  v_set text;
  v_key_list text;
  v_upserts integer := 0;
  v_deletes integer := 0;
begin
  select key_cols into v_keys from public.an_replica_targets where target = p_target;
  if v_keys is null then
    raise exception 'an_replica_unknown_target %', p_target using errcode = '22023';
  end if;
  v_key_list := (select string_agg(format('%I', k), ', ') from unnest(v_keys) k);

  if p_delete is not null and jsonb_array_length(p_delete) > 0 then
    execute format(
      'delete from public.%I t using jsonb_populate_recordset(null::public.%I, $1) d where (%s) = (%s)',
      p_target, p_target,
      (select string_agg(format('t.%I', k), ', ') from unnest(v_keys) k),
      (select string_agg(format('d.%I', k), ', ') from unnest(v_keys) k))
    using p_delete;
    get diagnostics v_deletes = row_count;
  end if;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(format('%I = excluded.%I', a.attname, a.attname), ', ' order by a.attnum)
             filter (where not a.attname = any (v_keys))
      into v_cols, v_set
      from pg_attribute a
     where a.attrelid = format('public.%I', p_target)::regclass
       and a.attnum > 0 and not a.attisdropped
       and a.attname in (select jsonb_object_keys(p_rows -> 0));
    if v_cols is null then
      raise exception 'an_replica_no_columns %', p_target using errcode = '22023';
    end if;
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict (%s) do %s',
      p_target, v_cols, v_cols, p_target, v_key_list,
      case when v_set is null then 'nothing' else 'update set ' || v_set end)
    using p_rows;
    get diagnostics v_upserts = row_count;
  end if;

  return jsonb_build_object('upserts', v_upserts, 'deletes', v_deletes);
end;
$$;
revoke all on function public.an_replica_apply(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.an_replica_apply(text, jsonb, jsonb) to service_role;

-- Состояние синхронизации для экрана «Синхронизация» (администратору).
create or replace function public.an_replica_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.an_is_admin(auth.uid()) then coalesce((
    select jsonb_agg(jsonb_build_object(
             'target', t.target, 'module', t.module,
             'rows', greatest(coalesce(c.reltuples, 0), 0)::bigint,
             'last_at', l.received_at, 'last_error', l.error,
             'day_upserts', coalesce(d.upserts, 0), 'day_deletes', coalesce(d.deletes, 0))
             order by t.module, t.target)
      from public.an_replica_targets t
      left join pg_class c on c.oid = to_regclass(format('public.%I', t.target))
      left join lateral (select received_at, error from public.an_replica_log x
                          where x.target = t.target order by received_at desc limit 1) l on true
      left join lateral (select sum(upserts)::integer as upserts, sum(deletes)::integer as deletes
                           from public.an_replica_log x
                          where x.target = t.target and x.received_at > now() - interval '1 day') d on true
  ), '[]'::jsonb) end
$$;
revoke all on function public.an_replica_status() from public, anon;
grant execute on function public.an_replica_status() to authenticated, service_role;

-- Агент на старом сервере: последняя отметка «на связи» и последняя проверка.
create or replace function public.an_replica_agent()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.an_is_admin(auth.uid()) then (
    select jsonb_build_object('received_at', l.received_at, 'error', l.error, 'details', l.details)
      from public.an_replica_log l
     where l.target = 'agent'
     order by l.received_at desc, l.id desc
     limit 1)
  end
$$;
revoke all on function public.an_replica_agent() from public, anon;
grant execute on function public.an_replica_agent() to authenticated, service_role;

-- Журнал приёма — 30 дней.
create or replace function public.an_replica_log_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.an_replica_log where received_at < now() - interval '30 days'
$$;
revoke all on function public.an_replica_log_cleanup() from public, anon, authenticated;
grant execute on function public.an_replica_log_cleanup() to service_role;

-- 13) Люди старого портала: список и связь с человеком портала -------------------
-- Тип — их приоритет (users_page): администратор, партнёр (есть города),
-- таргетолог, лид-менеджер, сотрудник. match_user_id — учётная запись
-- портала с той же почтой (логин у них — почта).
create or replace function public.an_legacy_people()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', u.id, 'login', u.login, 'full_name', u.full_name, 'role', u.role,
             'is_active', u.is_active = 1, 'position', u.position,
             'kind', case when u.role = 'admin' then 'admin'
                          when cardinality(c.cities) > 0 then 'partner'
                          when u.is_targetologist = 1 then 'targetologist'
                          when u.is_lead_manager = 1 then 'lead_manager'
                          else 'staff' end,
             'is_targetologist', u.is_targetologist = 1, 'is_lead_manager', u.is_lead_manager = 1,
             'grants', to_jsonb(g.grants), 'cities', to_jsonb(c.cities),
             'created_at', to_timestamp(u.created_at),
             'last_seen_at', (select to_timestamp(max(s.last_seen_at)) from public.an_legacy_sessions s
                               where s.user_id = u.id),
             'user_id', u.user_id, 'user_name', public.access_user_name(u.user_id),
             'imported_at', u.imported_at,
             'match_user_id', m.id, 'match_in_portal', m.in_portal)
             order by u.role, u.full_name, u.id)
      from public.an_legacy_users u
      cross join lateral (select coalesce(array_agg(dashboard_name order by dashboard_name), '{}') as grants
                            from public.an_legacy_dashboard_access a where a.user_id = u.id) g
      cross join lateral (select coalesce(array_agg(city order by city), '{}') as cities
                            from public.an_legacy_partner_cities pc where pc.user_id = u.id) c
      left join lateral (
        select p.id, exists (select 1 from public.portal_users pu where pu.user_id = p.id) as in_portal
          from public.profiles p
         where u.user_id is null and position('@' in u.login) > 1
           and lower(btrim(p.email)) = lower(btrim(u.login))
         order by p.id limit 1) m on true
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.an_legacy_people() from public, anon;
grant execute on function public.an_legacy_people() to authenticated, service_role;

-- Связать человека старого портала с человеком портала после переноса (роли
-- и учётную запись к этому времени выдал сервер портала): один раз
-- переносятся его города партнёра, карточка и условия по городам — дальше
-- доступ в двух порталах ведётся независимо (ANALYTICS_PLAN.md, §3.3).
-- Уже внесённое в портале не перезаписывается. Только суперадминистратор.
create or replace function public.an_legacy_link(p_legacy_id bigint, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_legacy public.an_legacy_users;
begin
  if not public.access_has_right(auth.uid(), 'portal.admin') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  select * into v_legacy from public.an_legacy_users where id = p_legacy_id for update;
  if not found then
    raise exception 'an_legacy_not_found' using errcode = 'P0002';
  end if;
  if v_legacy.user_id is not null and v_legacy.user_id <> p_user then
    raise exception 'an_legacy_linked' using errcode = '23505';
  end if;
  if not exists (select 1 from public.portal_users where user_id = p_user) then
    raise exception 'access_user_not_found' using errcode = 'P0002';
  end if;

  insert into public.an_partner_cities (user_id, city)
  select p_user, btrim(city) from public.an_legacy_partner_cities
   where user_id = p_legacy_id and btrim(city) <> ''
  on conflict do nothing;
  insert into public.an_partner_profiles (user_id, phone, telegram, max_messenger, individual_entrepreneur, inn)
  select p_user, nullif(btrim(phone), ''), nullif(btrim(telegram), ''), nullif(btrim(max_messenger), ''),
         nullif(btrim(individual_entrepreneur), ''),
         case when btrim(inn) ~ '^([0-9]{10}|[0-9]{12})$' then btrim(inn) end
    from public.an_legacy_partner_profiles where user_id = p_legacy_id
  on conflict (user_id) do nothing;
  insert into public.an_partner_city_settings (user_id, city, trial_price, directions)
  select p_user, btrim(city), nullif(btrim(trial_price), ''), nullif(btrim(directions), '')
    from public.an_legacy_partner_city_settings
   where user_id = p_legacy_id and btrim(city) <> ''
  on conflict do nothing;

  update public.an_legacy_users
     set user_id = p_user, imported_at = coalesce(imported_at, now()), imported_by = coalesce(imported_by, auth.uid())
   where id = p_legacy_id;
  perform public.access_log_add('analytics.import',
    format('Перенесён со старого портала аналитики — %s', public.access_user_name(p_user)),
    p_user, null, jsonb_build_object('legacy_id', p_legacy_id, 'login', v_legacy.login,
                                     'full_name', v_legacy.full_name));
end;
$$;
revoke all on function public.an_legacy_link(bigint, uuid) from public, anon;
grant execute on function public.an_legacy_link(bigint, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
