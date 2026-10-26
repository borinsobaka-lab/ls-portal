-- ============================================================================
-- «Аналитика сети» — отчёты для клубов сети на своих учётных системах (1С,
-- FitBase, АДИС, Мобифитнес…), а не на нашей CRM. Решение владельца
-- 2026-10-26 (уточнение к 2026-10-26_zz_analytics.sql): раздел переносит на
-- наш портал аналитику, которую Lady Stretch строила в своём портале
-- analytics.lady-stretching.ru, и считает её здесь. С нашими клубами,
-- продажами и расписанием он НЕ связан: у них свой дашборд. Когда клуб
-- переедет на нашу CRM, его отчёты будут в дашборде.
--
-- Прежняя версия (отчёты по нашим продажам, раздел клуба club.analytics,
-- analytics_studio_settings, RPC analytics_*) удаляется этим файлом.
--
-- Модель (что было у Lady Stretch — ANALYTICS.md):
--   * an_studios — студии сети, как они названы в учётной системе: город,
--     партнёр, бренд, закрыта с; новая студия из загрузки — «проверить».
--   * an_city_targets — точка 0 города (месячная выручка «в ноль»).
--   * an_nomenclature — справочник номенклатуры: код учётной системы →
--     категория (Абонемент, Пробное занятие, Разовое, Персональные…). Только
--     «Абонемент» идёт в продажи абонементов, только «Пробное занятие» — в
--     воронку; новые позиции — «Требует классификации».
--   * an_imports — загрузки выгрузок; факты загрузки: an_revenue (движение
--     денег: студия × день × статья), an_sales (строки продаж: клиент —
--     только хэш кода, номенклатура, стоимость, оплата), an_classes
--     (занятия: студия × день × направление), an_visits (посещения с
--     членством — для воронки пробных; клиент — хэш). Отчёты видят только
--     завершённые загрузки; новая загрузка заменяет данные того же вида у
--     своих студий за свой период.
--   * an_user_cities — города партнёра («Мой город»).
--
-- Права (каталог «Пользователей и ролей», сеть): analytics.view — все
-- студии; analytics.cities — только назначенные города (an_user_cities);
-- analytics.manage — загрузка данных, справочники, точка 0, города
-- партнёров. У людей вне модели прав — владелец клуба.
--
-- Персональных данных нет: код клиента приходит хэшем (браузер считает
-- SHA-256 до отправки), имён и телефонов нет.
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 0) Прежняя версия ---------------------------------------------------------------
-- Сначала таблица: её политика читает auth_analytics_studio_ids.
drop table if exists public.analytics_studio_settings;
drop function if exists public.analytics_revenue(uuid[], date, date, text);
drop function if exists public.analytics_sales(uuid[], date, date, text);
drop function if exists public.analytics_classes(uuid[], date, date, text);
drop function if exists public.analytics_trials(uuid[], date, date, text);
drop function if exists public.analytics_zero(uuid[], date, date);
drop function if exists public.analytics_scope();
drop function if exists public.analytics_settings_save(uuid, numeric, date);
drop function if exists public.analytics_sale_origins(uuid[]);
drop function if exists public.analytics_ids(uuid[]);
drop function if exists public.analytics_can_manage(uuid, uuid);
drop function if exists public.auth_analytics_studio_ids();
drop function if exists public.analytics_bucket(date, text);
-- Раздел клуба уходит из каталога; строки ролей удаляются каскадом, их
-- триггеры помечают людей на пересчёт прав.
delete from public.access_permissions where key = 'club.analytics';

-- 1) Права ------------------------------------------------------------------------
insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('analytics.view', 'sections', 'Аналитика сети: все клубы',
   'Отчёты по клубам сети на 1С, FitBase и других учётных системах: выручка, продажи, занятия, пробные — все города.',
   'network', '{on}', null, 130),
  ('analytics.cities', 'sections', 'Аналитика сети: свои города',
   'Партнёр: отчёты только по городам, назначенным ему в «Аналитике» → «Доступ партнёров».',
   'network', '{on}', null, 131),
  ('analytics.manage', 'sections', 'Аналитика сети: загрузка и справочники',
   'Загружает выгрузки учётных систем, ведёт студии, номенклатуру, точку 0 и города партнёров.',
   'network', '{on}', null, 132)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

-- Право вызывающего; у человека вне модели прав — владелец клуба.
create or replace function public.an_has(_user_id uuid, _right text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.access_user_rights where user_id = _user_id)
      then public.access_has_right(_user_id, _right)
    else exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
  end
$$;
revoke all on function public.an_has(uuid, text) from public, anon;
grant execute on function public.an_has(uuid, text) to authenticated, service_role;

create or replace function public.an_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.an_has(auth.uid(), 'analytics.manage')
$$;
revoke all on function public.an_can_manage() from public, anon;
grant execute on function public.an_can_manage() to authenticated, service_role;

-- 2) Справочники ------------------------------------------------------------------
create table if not exists public.an_studios (
  id uuid primary key default gen_random_uuid(),
  -- Как студия названа в учётной системе (по нему сопоставляются выгрузки).
  name text not null check (char_length(btrim(name)) between 1 and 200),
  source text not null default '1c'
    check (source in ('1c', 'fitbase', 'adis', 'mobifitness', 'other')),
  city text check (city is null or char_length(city) <= 80),
  partner text check (partner is null or char_length(partner) <= 200),
  brand_id uuid references public.org_brands(id) on delete set null,
  closed_on date,
  -- Появилась из загрузки и ещё не проверена (город, партнёр, статус).
  needs_review boolean not null default true,
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists an_studios_name_uidx on public.an_studios (source, lower(btrim(name)));
create index if not exists an_studios_city_idx on public.an_studios (city);

create table if not exists public.an_city_targets (
  city text primary key check (char_length(btrim(city)) between 1 and 80),
  point_zero numeric(14, 2) check (point_zero is null or point_zero >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.an_nomenclature (
  id uuid primary key default gen_random_uuid(),
  source text not null default '1c'
    check (source in ('1c', 'fitbase', 'adis', 'mobifitness', 'other')),
  -- Неизменный код учётной системы; без кода — «name:<название>».
  code text not null check (char_length(code) between 1 and 300),
  name text not null check (char_length(name) between 1 and 300),
  category text not null default 'unclassified'
    check (category in ('subscription', 'trial', 'single', 'personal', 'service', 'gift',
                        'massage', 'other', 'undefined', 'unclassified')),
  direction text check (direction is null or char_length(direction) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists an_nomenclature_code_uidx on public.an_nomenclature (source, code);
create index if not exists an_nomenclature_name_idx on public.an_nomenclature (lower(btrim(name)));

create table if not exists public.an_user_cities (
  user_id uuid not null references auth.users(id) on delete cascade,
  city text not null check (char_length(btrim(city)) between 1 and 80),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (user_id, city)
);

-- 3) Загрузки и факты -------------------------------------------------------------
create table if not exists public.an_imports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('revenue', 'sales', 'classes', 'visits')),
  source text not null check (source in ('1c', 'fitbase', 'adis', 'mobifitness', 'other')),
  file_name text check (file_name is null or char_length(file_name) <= 300),
  date_from date not null,
  date_to date not null check (date_to >= date_from),
  studio_ids uuid[] not null default '{}',
  rows_count integer not null default 0,
  status text not null default 'loading' check (status in ('loading', 'done')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  finished_at timestamptz
);
create index if not exists an_imports_kind_idx on public.an_imports (kind, status, created_at desc);

create table if not exists public.an_revenue (
  import_id uuid not null references public.an_imports(id) on delete cascade,
  studio_id uuid not null references public.an_studios(id) on delete cascade,
  day date not null,
  article text not null default '',
  income numeric(16, 2) not null default 0,
  expense numeric(16, 2) not null default 0
);
create index if not exists an_revenue_studio_day_idx on public.an_revenue (studio_id, day);
create index if not exists an_revenue_import_idx on public.an_revenue (import_id);

create table if not exists public.an_sales (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.an_imports(id) on delete cascade,
  studio_id uuid not null references public.an_studios(id) on delete cascade,
  day date not null,
  -- Время продажи (порядок продаж одного дня), если есть в выгрузке.
  sold_at timestamp,
  client_key text check (client_key is null or char_length(client_key) <= 80),
  nomenclature_id uuid not null references public.an_nomenclature(id) on delete cascade,
  cost numeric(14, 2),
  paid numeric(14, 2)
);
create index if not exists an_sales_studio_day_idx on public.an_sales (studio_id, day);
create index if not exists an_sales_client_idx on public.an_sales (client_key, day) where client_key is not null;
create index if not exists an_sales_import_idx on public.an_sales (import_id);

create table if not exists public.an_classes (
  import_id uuid not null references public.an_imports(id) on delete cascade,
  studio_id uuid not null references public.an_studios(id) on delete cascade,
  day date not null,
  direction text not null default '',
  classes integer not null check (classes > 0),
  booked integer not null check (booked > 0),
  attended integer not null check (attended > 0)
);
create index if not exists an_classes_studio_day_idx on public.an_classes (studio_id, day);
create index if not exists an_classes_import_idx on public.an_classes (import_id);

create table if not exists public.an_visits (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.an_imports(id) on delete cascade,
  studio_id uuid not null references public.an_studios(id) on delete cascade,
  day date not null,
  client_key text check (client_key is null or char_length(client_key) <= 80),
  -- Членство / пакет услуг записи (по названию сверяется со справочником).
  membership text not null default '',
  attended boolean not null
);
create index if not exists an_visits_studio_day_idx on public.an_visits (studio_id, day);
create index if not exists an_visits_import_idx on public.an_visits (import_id);

-- Таблицы напрямую: справочники читают те, кто видит аналитику; пишут —
-- только RPC (проверка права внутри). Факты напрямую закрыты.
alter table public.an_studios enable row level security;
alter table public.an_city_targets enable row level security;
alter table public.an_nomenclature enable row level security;
alter table public.an_user_cities enable row level security;
alter table public.an_imports enable row level security;
alter table public.an_revenue enable row level security;
alter table public.an_sales enable row level security;
alter table public.an_classes enable row level security;
alter table public.an_visits enable row level security;
revoke all on public.an_studios, public.an_city_targets, public.an_nomenclature, public.an_user_cities,
  public.an_imports, public.an_revenue, public.an_sales, public.an_classes, public.an_visits
  from anon, authenticated;
grant all on public.an_studios, public.an_city_targets, public.an_nomenclature, public.an_user_cities,
  public.an_imports, public.an_revenue, public.an_sales, public.an_classes, public.an_visits
  to service_role;
grant select on public.an_nomenclature, public.an_imports to authenticated;
drop policy if exists "an nomenclature manage read" on public.an_nomenclature;
create policy "an nomenclature manage read" on public.an_nomenclature
  for select to authenticated using ((select public.an_can_manage()));
drop policy if exists "an imports manage read" on public.an_imports;
create policy "an imports manage read" on public.an_imports
  for select to authenticated using ((select public.an_can_manage()));

-- 4) Кто что видит ----------------------------------------------------------------
-- Студии, чьи отчёты видит вызывающий: все (view или manage) или студии его
-- городов (cities + an_user_cities).
create or replace function public.auth_an_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.an_has(auth.uid(), 'analytics.view') or public.an_has(auth.uid(), 'analytics.manage') then
    return (select coalesce(array_agg(id), '{}'::uuid[]) from public.an_studios);
  end if;
  if public.an_has(auth.uid(), 'analytics.cities') then
    return (select coalesce(array_agg(s.id), '{}'::uuid[])
              from public.an_studios s
              join public.an_user_cities c on c.city = s.city and c.user_id = auth.uid());
  end if;
  return '{}'::uuid[];
end;
$$;
revoke all on function public.auth_an_studio_ids() from public, anon;
grant execute on function public.auth_an_studio_ids() to authenticated, service_role;

-- Запрошенные студии ∩ доступные (null — все доступные). Внутренняя.
create or replace function public.an_ids(p_studio_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(x), '{}'::uuid[])
    from unnest(public.auth_an_studio_ids()) x
   where p_studio_ids is null or x = any (p_studio_ids)
$$;
revoke all on function public.an_ids(uuid[]) from public, anon, authenticated;

create or replace function public.an_bucket(d date, p_bucket text)
returns date
language sql
immutable
as $$
  select case when p_bucket = 'month' then date_trunc('month', d)::date else d end
$$;

-- Доступ к разделу (рейка): видит ли что-нибудь, управляет ли.
create or replace function public.an_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'view', public.an_has(auth.uid(), 'analytics.view'),
    'manage', public.an_has(auth.uid(), 'analytics.manage'),
    'cities', case when public.an_has(auth.uid(), 'analytics.cities')
                   then coalesce((select jsonb_agg(city order by city) from public.an_user_cities
                                   where user_id = auth.uid()), '[]'::jsonb)
                   else '[]'::jsonb end)
$$;
revoke all on function public.an_access() from public, anon;
grant execute on function public.an_access() to authenticated;

-- Студии отчётов, точки 0 их городов и свежесть данных по видам.
create or replace function public.an_scope()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.auth_an_studio_ids() as a)
  select jsonb_build_object(
    'today', (now() at time zone 'Asia/Tbilisi')::date,
    'can_manage', public.an_can_manage(),
    'studios', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'city', s.city, 'partner', s.partner, 'source', s.source,
               'brand_id', s.brand_id, 'brand_name', b.name, 'closed_on', s.closed_on,
               'needs_review', s.needs_review)
             order by s.city nulls last, s.name)
        from public.an_studios s
        left join public.org_brands b on b.id = s.brand_id, ids
       where s.id = any (ids.a)), '[]'::jsonb),
    'targets', coalesce((
      select jsonb_object_agg(t.city, t.point_zero)
        from public.an_city_targets t, ids
       where t.point_zero is not null
         and exists (select 1 from public.an_studios s where s.city = t.city and s.id = any (ids.a))),
      '{}'::jsonb),
    'loaded', coalesce((
      select jsonb_object_agg(kind, jsonb_build_object('to', max_to, 'at', max_at))
        from (select kind, max(date_to) as max_to, max(finished_at) as max_at
                from public.an_imports where status = 'done' group by kind) k), '{}'::jsonb)
  )
$$;
revoke all on function public.an_scope() from public, anon;
grant execute on function public.an_scope() to authenticated;

-- 5) Отчёты ------------------------------------------------------------------------
-- Выручка — «Приход минус расход» движения денег (как у Lady Stretch).
-- Строка: [студия, дата, приход, расход].
create or replace function public.an_revenue_report(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.an_ids(p_studio_ids) as a)
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, d, inc, exp) order by d, studio_id), '[]'::jsonb)
    from (select r.studio_id, public.an_bucket(r.day, p_bucket) as d,
                 sum(r.income) as inc, sum(r.expense) as exp
            from public.an_revenue r
            join public.an_imports i on i.id = r.import_id and i.status = 'done', ids
           where r.studio_id = any (ids.a) and r.day between p_from and p_to
           group by 1, 2) t
$$;
revoke all on function public.an_revenue_report(uuid[], date, date, text) from public, anon;
grant execute on function public.an_revenue_report(uuid[], date, date, text) to authenticated;

-- Оплаченные продажи абонементов (категория «Абонемент», оплата > 0) с видом:
-- new — самая ранняя такая покупка клиента во всей истории (по всем
-- студиям); renewal — повторная, прошлая покупка не раньше чем за p_gap
-- дней; return — повторная после перерыва дольше p_gap. Внутренняя.
create or replace function public.an_paid_subscriptions(p_clients text[], p_gap integer)
returns table (id bigint, studio_id uuid, day date, client_key text, nomenclature_id uuid,
               cost numeric, paid numeric, origin text)
language sql
stable
security definer
set search_path = public
as $$
  select x.id, x.studio_id, x.day, x.client_key, x.nomenclature_id, x.cost, x.paid,
         case when x.prev_day is null then 'new'
              when x.prev_day >= x.day - p_gap then 'renewal'
              else 'return' end
    from (select s.*, lag(s.day) over (partition by s.client_key
                                       order by s.day, s.sold_at nulls first, s.id) as prev_day
            from public.an_sales s
            join public.an_nomenclature n on n.id = s.nomenclature_id and n.category = 'subscription'
            join public.an_imports i on i.id = s.import_id and i.status = 'done'
           where s.paid > 0 and s.client_key = any (p_clients)) x
$$;
revoke all on function public.an_paid_subscriptions(text[], integer) from public, anon, authenticated;

-- Продажи абонементов за период. Строка sold: [студия, дата, номенклатура,
-- вид, продаж, оплачено, стоимость]; продажи без кода клиента — вид new
-- нельзя определить, они идут как 'unknown'. names — {номенклатура: название}.
create or replace function public.an_sales_report(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day', p_gap integer default 60)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.an_ids(p_studio_ids) as a),
  period as (
    select s.*
      from public.an_sales s
      join public.an_nomenclature n on n.id = s.nomenclature_id and n.category = 'subscription'
      join public.an_imports i on i.id = s.import_id and i.status = 'done', ids
     where s.studio_id = any (ids.a) and s.day between p_from and p_to and s.paid > 0
  ),
  origins as (
    select o.id, o.origin
      from public.an_paid_subscriptions(
             (select coalesce(array_agg(distinct client_key), '{}') from period where client_key is not null),
             p_gap) o
  ),
  rows as (
    select p.studio_id, public.an_bucket(p.day, p_bucket) as d, p.nomenclature_id,
           coalesce(o.origin, 'unknown') as origin, p.paid, p.cost
      from period p left join origins o on o.id = p.id
  )
  select jsonb_build_object(
    'sold', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, d, nomenclature_id, origin, n, paid, cost) order by d)
        from (select studio_id, d, nomenclature_id, origin, count(*) as n,
                     sum(paid) as paid, sum(coalesce(cost, 0)) as cost
                from rows group by 1, 2, 3, 4) t), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(n.id, n.name)
        from public.an_nomenclature n where n.id in (select nomenclature_id from period)), '{}'::jsonb)
  )
$$;
revoke all on function public.an_sales_report(uuid[], date, date, text, integer) from public, anon;
grant execute on function public.an_sales_report(uuid[], date, date, text, integer) to authenticated;

-- Занятия: [студия, дата, направление, занятий, записано, посетило].
create or replace function public.an_classes_report(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.an_ids(p_studio_ids) as a)
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, d, direction, n, booked, attended) order by d), '[]'::jsonb)
    from (select c.studio_id, public.an_bucket(c.day, p_bucket) as d, c.direction,
                 sum(c.classes) as n, sum(c.booked) as booked, sum(c.attended) as attended
            from public.an_classes c
            join public.an_imports i on i.id = c.import_id and i.status = 'done', ids
           where c.studio_id = any (ids.a) and c.day between p_from and p_to
           group by 1, 2, 3) t
$$;
revoke all on function public.an_classes_report(uuid[], date, date, text) from public, anon;
grant execute on function public.an_classes_report(uuid[], date, date, text) to authenticated;

-- Воронка пробных (как у Lady Stretch): пробная запись — членство записи
-- совпадает по названию с номенклатурой категории «Пробное занятие»;
-- пришёл — отметка «прибыл». Покупка — оплаченный абонемент того же клиента
-- (любая студия) в день пробного или в следующие 13 дней; одна покупка
-- засчитывается только последнему пришедшему пробному клиента, попавшему в
-- её 14-дневное окно. Строка: [студия, дата, пробное, записей, пришли,
-- купили в день, купили за 14 дней, окно открыто].
create or replace function public.an_trials_report(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.an_ids(p_studio_ids) as a),
  trial_names as (
    select distinct lower(btrim(name)) as nm from public.an_nomenclature where category = 'trial'
  ),
  t as (
    select v.id, v.studio_id, v.day, v.client_key, v.membership, v.attended
      from public.an_visits v
      join public.an_imports i on i.id = v.import_id and i.status = 'done', ids
     where v.studio_id = any (ids.a) and v.day between p_from and p_to
       and lower(btrim(v.membership)) in (select nm from trial_names)
  ),
  -- Все пришедшие пробные этих клиентов (и вне периода): покупка уходит
  -- последнему из них.
  att as (
    select v.id, v.day, v.client_key
      from public.an_visits v
      join public.an_imports i on i.id = v.import_id and i.status = 'done'
     where v.attended and v.client_key in (select client_key from t where attended)
       and lower(btrim(v.membership)) in (select nm from trial_names)
  ),
  buys as (
    select s.day, s.client_key
      from public.an_sales s
      join public.an_nomenclature n on n.id = s.nomenclature_id and n.category = 'subscription'
      join public.an_imports i on i.id = s.import_id and i.status = 'done'
     where s.paid > 0 and s.client_key in (select client_key from att)
       and s.day between p_from and p_to + 13
  ),
  assigned as (
    select distinct on (b.client_key, b.day) a.id as trial_id, (b.day = a.day) as same_day
      from buys b
      join att a on a.client_key = b.client_key and a.day <= b.day and a.day >= b.day - 13
     order by b.client_key, b.day, a.day desc, a.id desc
  ),
  res as (
    select t.*,
           exists (select 1 from assigned x where x.trial_id = t.id and x.same_day) as day0,
           exists (select 1 from assigned x where x.trial_id = t.id) as d14
      from t
  )
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, d, membership, n, attended, day0, d14, open) order by d), '[]'::jsonb)
    from (select studio_id, public.an_bucket(day, p_bucket) as d, membership,
                 count(*) as n,
                 count(*) filter (where attended) as attended,
                 count(*) filter (where day0) as day0,
                 count(*) filter (where d14) as d14,
                 count(*) filter (where attended and not d14
                                    and day + 13 >= (now() at time zone 'Asia/Tbilisi')::date) as open
            from res group by 1, 2, 3) x
$$;
revoke all on function public.an_trials_report(uuid[], date, date, text) from public, anon;
grant execute on function public.an_trials_report(uuid[], date, date, text) to authenticated;

-- Нулевая номенклатура: строки продаж с пустой или нулевой стоимостью, кроме
-- «Пробного занятия» (оплата не важна). Строка: [студия, номенклатура,
-- категория, строк, последняя дата].
create or replace function public.an_zero_report(p_studio_ids uuid[], p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.an_ids(p_studio_ids) as a)
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, name, category, n, last_on) order by n desc), '[]'::jsonb)
    from (select s.studio_id, n.name, n.category, count(*) as n, max(s.day) as last_on
            from public.an_sales s
            join public.an_nomenclature n on n.id = s.nomenclature_id and n.category <> 'trial'
            join public.an_imports i on i.id = s.import_id and i.status = 'done', ids
           where s.studio_id = any (ids.a) and s.day between p_from and p_to
             and coalesce(s.cost, 0) = 0
           group by 1, 2, 3) t
$$;
revoke all on function public.an_zero_report(uuid[], date, date) from public, anon;
grant execute on function public.an_zero_report(uuid[], date, date) to authenticated;

-- 6) Загрузка -----------------------------------------------------------------------
-- Начало загрузки: заводит недостающие студии («проверить») и номенклатуру
-- («Требует классификации»), возвращает id загрузки и соответствия
-- {название студии: id}, {код номенклатуры: id}. p_nomenclature —
-- [{code, name}]; у посещений — названия членств с «пробн», которых нет в
-- справочнике (их надо разметить, чтобы воронка их увидела).
create or replace function public.an_import_start(
  p_kind text, p_source text, p_file_name text, p_date_from date, p_date_to date,
  p_studios text[], p_nomenclature jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_studios jsonb;
  v_nom jsonb;
  v_new_studios integer;
  v_new_nom integer;
begin
  if not public.an_can_manage() then
    raise exception 'Нет права загружать данные аналитики' using errcode = '42501';
  end if;
  if p_kind not in ('revenue', 'sales', 'classes', 'visits') then
    raise exception 'Неизвестный вид загрузки' using errcode = '22023';
  end if;
  if coalesce(array_length(p_studios, 1), 0) = 0 then
    raise exception 'В файле нет ни одной студии' using errcode = '22023';
  end if;

  with ins as (
    insert into public.an_studios (name, source)
    select distinct btrim(n), p_source from unnest(p_studios) n
     where btrim(n) <> ''
    on conflict (source, lower(btrim(name))) do nothing
    returning id
  )
  select count(*) into v_new_studios from ins;

  with ins as (
    insert into public.an_nomenclature (source, code, name)
    select distinct on (x->>'code') p_source, x->>'code', coalesce(nullif(btrim(x->>'name'), ''), x->>'code')
      from jsonb_array_elements(p_nomenclature) x
     where coalesce(x->>'code', '') <> ''
    on conflict (source, code) do nothing
    returning id
  )
  select count(*) into v_new_nom from ins;

  select coalesce(jsonb_object_agg(n, s.id), '{}'::jsonb) into v_studios
    from unnest(p_studios) n
    join public.an_studios s on s.source = p_source and lower(btrim(s.name)) = lower(btrim(n));

  select coalesce(jsonb_object_agg(x->>'code', m.id), '{}'::jsonb) into v_nom
    from jsonb_array_elements(p_nomenclature) x
    join public.an_nomenclature m on m.source = p_source and m.code = x->>'code';

  insert into public.an_imports (kind, source, file_name, date_from, date_to, studio_ids,
                                 created_by, created_by_name)
  values (p_kind, p_source, p_file_name, p_date_from, p_date_to,
          (select array_agg(distinct (value #>> '{}')::uuid) from jsonb_each(v_studios)),
          auth.uid(), (select full_name from public.profiles where id = auth.uid()))
  returning id into v_id;

  return jsonb_build_object('import_id', v_id, 'studios', v_studios, 'nomenclature', v_nom,
                            'new_studios', v_new_studios, 'new_nomenclature', v_new_nom);
end;
$$;
revoke all on function public.an_import_start(text, text, text, date, date, text[], jsonb) from public, anon;
grant execute on function public.an_import_start(text, text, text, date, date, text[], jsonb) to authenticated;

-- Пачка строк загрузки (массивы, порядок полей — по виду):
--   revenue: [студия, день, статья, приход, расход]
--   sales:   [студия, день, время|null, клиент|null, номенклатура, стоимость|null, оплата|null]
--   classes: [студия, день, направление, занятий, записано, посетило]
--   visits:  [студия, день, клиент|null, членство, пришёл]
-- Студии — только этой загрузки, даты — внутри её периода.
create or replace function public.an_import_rows(p_import_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imp public.an_imports;
  v_n integer;
begin
  if not public.an_can_manage() then
    raise exception 'Нет права загружать данные аналитики' using errcode = '42501';
  end if;
  select * into v_imp from public.an_imports where id = p_import_id for update;
  if v_imp.id is null or v_imp.status <> 'loading' then
    raise exception 'Загрузка не найдена или уже завершена' using errcode = 'P0002';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
              where not ((r->>0)::uuid = any (v_imp.studio_ids))
                 or (r->>1)::date not between v_imp.date_from and v_imp.date_to) then
    raise exception 'Строка вне студий или периода загрузки' using errcode = '22023';
  end if;

  if v_imp.kind = 'revenue' then
    insert into public.an_revenue (import_id, studio_id, day, article, income, expense)
    select p_import_id, (r->>0)::uuid, (r->>1)::date, coalesce(r->>2, ''),
           coalesce((r->>3)::numeric, 0), coalesce((r->>4)::numeric, 0)
      from jsonb_array_elements(p_rows) r;
  elsif v_imp.kind = 'sales' then
    insert into public.an_sales (import_id, studio_id, day, sold_at, client_key, nomenclature_id, cost, paid)
    select p_import_id, (r->>0)::uuid, (r->>1)::date, (r->>2)::timestamp, nullif(r->>3, ''),
           (r->>4)::uuid, (r->>5)::numeric, (r->>6)::numeric
      from jsonb_array_elements(p_rows) r;
  elsif v_imp.kind = 'classes' then
    insert into public.an_classes (import_id, studio_id, day, direction, classes, booked, attended)
    select p_import_id, (r->>0)::uuid, (r->>1)::date, coalesce(r->>2, ''),
           (r->>3)::integer, (r->>4)::integer, (r->>5)::integer
      from jsonb_array_elements(p_rows) r;
  else
    insert into public.an_visits (import_id, studio_id, day, client_key, membership, attended)
    select p_import_id, (r->>0)::uuid, (r->>1)::date, nullif(r->>2, ''), coalesce(r->>3, ''),
           (r->>4)::boolean
      from jsonb_array_elements(p_rows) r;
  end if;
  get diagnostics v_n = row_count;
  update public.an_imports set rows_count = rows_count + v_n where id = p_import_id;
  return v_n;
end;
$$;
revoke all on function public.an_import_rows(uuid, jsonb) from public, anon;
grant execute on function public.an_import_rows(uuid, jsonb) to authenticated;

-- Завершение: данные того же вида у студий загрузки за её период из
-- прежних загрузок удаляются (исправления старых дат приходят новой
-- выгрузкой), загрузка становится видна отчётам. Пустые прежние загрузки
-- остаются в журнале с нулём строк.
create or replace function public.an_import_finish(p_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imp public.an_imports;
  v_removed integer := 0;
begin
  if not public.an_can_manage() then
    raise exception 'Нет права загружать данные аналитики' using errcode = '42501';
  end if;
  select * into v_imp from public.an_imports where id = p_import_id for update;
  if v_imp.id is null or v_imp.status <> 'loading' then
    raise exception 'Загрузка не найдена или уже завершена' using errcode = 'P0002';
  end if;

  if v_imp.kind = 'revenue' then
    delete from public.an_revenue f using public.an_imports i
     where i.id = f.import_id and i.kind = 'revenue' and i.status = 'done' and i.id <> p_import_id
       and f.studio_id = any (v_imp.studio_ids) and f.day between v_imp.date_from and v_imp.date_to;
  elsif v_imp.kind = 'sales' then
    delete from public.an_sales f using public.an_imports i
     where i.id = f.import_id and i.kind = 'sales' and i.status = 'done' and i.id <> p_import_id
       and f.studio_id = any (v_imp.studio_ids) and f.day between v_imp.date_from and v_imp.date_to;
  elsif v_imp.kind = 'classes' then
    delete from public.an_classes f using public.an_imports i
     where i.id = f.import_id and i.kind = 'classes' and i.status = 'done' and i.id <> p_import_id
       and f.studio_id = any (v_imp.studio_ids) and f.day between v_imp.date_from and v_imp.date_to;
  else
    delete from public.an_visits f using public.an_imports i
     where i.id = f.import_id and i.kind = 'visits' and i.status = 'done' and i.id <> p_import_id
       and f.studio_id = any (v_imp.studio_ids) and f.day between v_imp.date_from and v_imp.date_to;
  end if;
  get diagnostics v_removed = row_count;

  update public.an_imports set status = 'done', finished_at = now() where id = p_import_id;
  -- Строки прежних загрузок, которые целиком заменены, — 0 в журнале.
  update public.an_imports i
     set rows_count = case i.kind
       when 'revenue' then (select count(*) from public.an_revenue f where f.import_id = i.id)
       when 'sales' then (select count(*) from public.an_sales f where f.import_id = i.id)
       when 'classes' then (select count(*) from public.an_classes f where f.import_id = i.id)
       else (select count(*) from public.an_visits f where f.import_id = i.id) end
   where i.kind = v_imp.kind and i.status = 'done' and i.id <> p_import_id
     and i.studio_ids && v_imp.studio_ids;
  return jsonb_build_object('replaced', v_removed);
end;
$$;
revoke all on function public.an_import_finish(uuid) from public, anon;
grant execute on function public.an_import_finish(uuid) to authenticated;

-- Удалить загрузку (и незавершённую) вместе с её данными.
create or replace function public.an_import_delete(p_import_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.an_can_manage() then
    raise exception 'Нет права менять данные аналитики' using errcode = '42501';
  end if;
  delete from public.an_imports where id = p_import_id;
end;
$$;
revoke all on function public.an_import_delete(uuid) from public, anon;
grant execute on function public.an_import_delete(uuid) to authenticated;

-- 7) Справочники: правка ----------------------------------------------------------
create or replace function public.an_studio_save(
  p_id uuid, p_city text, p_partner text, p_brand_id uuid, p_closed_on date, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.an_can_manage() then
    raise exception 'Нет права менять справочники аналитики' using errcode = '42501';
  end if;
  update public.an_studios
     set city = nullif(btrim(p_city), ''), partner = nullif(btrim(p_partner), ''),
         brand_id = p_brand_id, closed_on = p_closed_on, note = nullif(btrim(p_note), ''),
         needs_review = false, updated_at = now(), updated_by = auth.uid()
   where id = p_id;
  if not found then
    raise exception 'Студия не найдена' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.an_studio_save(uuid, text, text, uuid, date, text) from public, anon;
grant execute on function public.an_studio_save(uuid, text, text, uuid, date, text) to authenticated;

-- Студии для справочника: все, с числом строк фактов (что удаляется вместе).
create or replace function public.an_studios_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not public.an_can_manage() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.name, 'source', s.source, 'city', s.city, 'partner', s.partner,
             'brand_id', s.brand_id, 'closed_on', s.closed_on, 'needs_review', s.needs_review,
             'note', s.note,
             'first_day', (select min(day) from public.an_revenue r where r.studio_id = s.id),
             'last_day', (select max(day) from public.an_revenue r where r.studio_id = s.id))
           order by s.needs_review desc, s.city nulls first, s.name)
      from public.an_studios s), '[]'::jsonb) end
$$;
revoke all on function public.an_studios_list() from public, anon;
grant execute on function public.an_studios_list() to authenticated;

create or replace function public.an_nomenclature_set(p_ids uuid[], p_category text, p_direction text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not public.an_can_manage() then
    raise exception 'Нет права менять справочники аналитики' using errcode = '42501';
  end if;
  update public.an_nomenclature
     set category = p_category,
         direction = coalesce(nullif(btrim(p_direction), ''), direction),
         updated_at = now(), updated_by = auth.uid()
   where id = any (p_ids);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.an_nomenclature_set(uuid[], text, text) from public, anon;
grant execute on function public.an_nomenclature_set(uuid[], text, text) to authenticated;

create or replace function public.an_city_target_save(p_city text, p_point_zero numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.an_can_manage() then
    raise exception 'Нет права менять точку 0' using errcode = '42501';
  end if;
  if p_point_zero is null then
    delete from public.an_city_targets where city = btrim(p_city);
    return;
  end if;
  if p_point_zero < 0 then
    raise exception 'Точка 0 не может быть отрицательной' using errcode = '22023';
  end if;
  insert into public.an_city_targets (city, point_zero, updated_at, updated_by)
  values (btrim(p_city), p_point_zero, now(), auth.uid())
  on conflict (city) do update
    set point_zero = excluded.point_zero, updated_at = now(), updated_by = auth.uid();
end;
$$;
revoke all on function public.an_city_target_save(text, numeric) from public, anon;
grant execute on function public.an_city_target_save(text, numeric) to authenticated;

-- Города партнёров: кто из людей портала с правом «свои города» какие города
-- видит. Список — люди портала с этим правом и их города.
create or replace function public.an_partners_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not public.an_can_manage() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', r.user_id, 'name', p.full_name, 'email', u.email,
             'cities', coalesce((select jsonb_agg(c.city order by c.city) from public.an_user_cities c
                                  where c.user_id = r.user_id), '[]'::jsonb))
           order by p.full_name nulls last)
      from public.access_user_rights r
      join auth.users u on u.id = r.user_id
      left join public.profiles p on p.id = r.user_id
     where r.portal and 'analytics.cities' = any (r.rights)), '[]'::jsonb) end
$$;
revoke all on function public.an_partners_list() from public, anon;
grant execute on function public.an_partners_list() to authenticated;

create or replace function public.an_partner_cities_save(p_user_id uuid, p_cities text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.an_can_manage() then
    raise exception 'Нет права назначать города' using errcode = '42501';
  end if;
  delete from public.an_user_cities
   where user_id = p_user_id and not (city = any (coalesce(p_cities, '{}')));
  insert into public.an_user_cities (user_id, city, created_by)
  select p_user_id, btrim(c), auth.uid() from unnest(coalesce(p_cities, '{}')) c
   where btrim(c) <> ''
  on conflict do nothing;
end;
$$;
revoke all on function public.an_partner_cities_save(uuid, text[]) from public, anon;
grant execute on function public.an_partner_cities_save(uuid, text[]) to authenticated;

-- Стартовые роли: аналитик сети и партнёр (свои города).
select public.access_seed_role('network_analyst', 'Аналитика сети',
  'Отчёты по всем клубам сети на 1С, FitBase и других системах.', '#7c3aed', 95, false,
  array['analytics.view']);
select public.access_seed_role('analytics_partner', 'Партнёр — аналитика',
  'Отчёты «Мой город» по городам, назначенным в «Аналитике» → «Доступ партнёров».', '#a21caf', 96, false,
  array['analytics.cities']);
