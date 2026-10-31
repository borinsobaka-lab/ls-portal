-- ============================================================================
-- «Аналитика» → FitBase, часть 6 (ANALYTICS.md, «FitBase»): «Мой город ·
-- FitBase» и студии партнёров — их fitbase_partner.py / fitbase_partner_view.py
-- (снимок сервера 26.10.2026): доска партнёра 1С на фактах FitBase только
-- назначенных студий.
--
-- Доступ — их user_fitbase_connections: человеку назначаются конкретные
-- студии (an_fb_user_studios: пользователь × подключение × домен + клуб;
-- смена домена или клуба подключения закрывает назначение). Администратору
-- аналитики — все студии. Назначенные студии открывают отчёт «Мой город ·
-- FitBase» (an_me_for: fb.mycity) — как у них, без отдельного права.
-- Точка 0 города — их CITY_TARGETS: числа вводит администратор
-- (an_fb_city_targets), в репозитории их нет.
--
-- Расчёты посещаемости и пробных вынесены во внутренние функции (студии —
-- списком): прежние RPC отчётов сети отдают то же, что раньше.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Назначения студий и точка 0 -------------------------------------------------
create table if not exists public.an_fb_user_studios (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  domain text not null,
  club_id text not null,
  primary key (user_id, connection_id)
);
create table if not exists public.an_fb_city_targets (
  city text primary key check (char_length(btrim(city)) between 1 and 200),
  amount_cents bigint not null check (amount_cents >= 0 and amount_cents <= 100000000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.an_fb_user_studios enable row level security;
alter table public.an_fb_city_targets enable row level security;
revoke all on public.an_fb_user_studios, public.an_fb_city_targets from public, anon, authenticated;
grant select, insert, update, delete on public.an_fb_user_studios, public.an_fb_city_targets
  to service_role;

-- Студии человека: администратору — все с клубом; иначе — назначенные, пока
-- у подключения те же домен и клуб (их connections_for).
create or replace function public.an_fb_mycity_ids(_user_id uuid)
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.id order by c.id), '{}')
    from public.an_fb_connections c
   where c.club_id <> ''
     and (public.an_is_admin(_user_id)
          or exists (select 1 from public.an_fb_user_studios g
                      where g.user_id = _user_id and g.connection_id = c.id
                        and g.domain = c.domain and g.club_id = c.club_id));
$$;
revoke all on function public.an_fb_mycity_ids(uuid) from public, anon, authenticated;

-- 2) Что открыто человеку — их allowed_dashboards + назначенные студии FitBase.
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
    -- ФИО — ключ назначений таргетологов (как у них).
    select nullif(btrim(full_name), '') into v_target from public.profiles where id = _user_id;
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
  -- Их «Мой город · FitBase»: открыт тем, кому назначены студии (их
  -- user_fitbase_connections), независимо от прав 1С.
  if not v_admin and not ('fb.mycity' = any (v_reports))
     and cardinality(public.an_fb_mycity_ids(_user_id)) > 0 then
    v_reports := v_reports || 'fb.mycity'::text;
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

-- 3) Общие расчёты отчётов (внутренние) -------------------------------------------

-- Их owners: одна студия на пару «домен + клуб» — с самой свежей загрузкой занятий.
create or replace function public.an_fb_owner_ids(p_ids bigint[])
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.id), '{}')
    from (select distinct on (c.domain, c.club_id) c.id
            from public.an_fb_connections c
           where c.club_id <> '' and c.id = any (p_ids)
           order by c.domain, c.club_id, coalesce(c.attendance_synced_at, 0) desc, c.id desc) s;
$$;
revoke all on function public.an_fb_owner_ids(bigint[]) from public, anon, authenticated;

-- Их attendance_report по отобранным студиям: группы «итог / город / студия /
-- направление» за период и те же дни месяц и год назад, неизвестные коды.
create or replace function public.an_fb_attendance_groups(p_from date, p_to date, p_sel bigint[],
  p_training text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with views(v, lo, hi) as (
    values ('current', p_from, p_to),
           ('month', (p_from - interval '1 month')::date, (p_to - interval '1 month')::date),
           ('year', (p_from - interval '1 year')::date, (p_to - interval '1 year')::date)
  ), sel as (
    select c.id, c.city, public.an_fb_effective_rules(c.attendance_rules) as rules
      from public.an_fb_connections c where c.id = any (p_sel)
  ), facts as (
    select w.v, c.city, c.id as uid, e.training_name, e.event_id, r.registration_id, r.status as raw,
           case when r.registration_id is null then null else c.rules ->> r.status end as st
      from public.an_fb_events e
      join sel c on c.id = e.connection_id
      join views w on e.day >= w.lo::text and e.day <= w.hi::text
      left join public.an_fb_records r on r.connection_id = e.connection_id and r.event_id = e.event_id
     where not e.cancelled and e.end_at <= extract(epoch from now())::bigint
       and (coalesce(p_training, '') = '' or e.training_name = p_training)
  ), grouped as (
    select v, city, uid, training_name,
           grouping(city) as g_city, grouping(uid) as g_uid, grouping(training_name) as g_training,
           count(distinct uid::text || ':' || event_id) as lessons,
           count(distinct uid::text || ':' || registration_id)
             filter (where st = any (array['registered', 'confirmed', 'visited', 'no_show',
                                           'late_cancel'])) as registered,
           count(distinct uid::text || ':' || registration_id) filter (where st = 'visited') as visited,
           coalesce(bool_or(registration_id is not null
                            and not coalesce(st = any (array['registered', 'confirmed', 'visited',
                              'no_show', 'late_cancel', 'refused', 'waiting', 'pending_payment']),
                              false)), false) as problems
      from facts
     group by grouping sets ((v), (v, city), (v, city, uid), (v, city, uid, training_name))
  )
  select jsonb_build_object(
    'trainings', (
      select coalesce(jsonb_agg(distinct e.training_name), '[]')
        from public.an_fb_events e where e.connection_id = any (p_sel)),
    'groups', (
      select coalesce(jsonb_agg(jsonb_build_array(
               g.v,
               case when g.g_city = 0 then g.city end,
               case when g.g_uid = 0 then g.uid end,
               case when g.g_training = 0 then g.training_name end,
               g.lessons, g.registered, g.visited, g.problems)), '[]')
        from grouped g),
    'unknown', (
      select coalesce(jsonb_agg(distinct jsonb_build_array(f.uid, f.raw)), '[]')
        from facts f
       where f.v = 'current' and f.registration_id is not null
         and not coalesce(f.st = any (array['registered', 'confirmed', 'visited', 'no_show',
                                            'late_cancel', 'refused', 'waiting', 'pending_payment']),
                          false)));
$$;
revoke all on function public.an_fb_attendance_groups(date, date, bigint[], text)
  from public, anon, authenticated;

-- Отобранные студии посещаемости (поля их страницы).
create or replace function public.an_fb_attendance_selected(p_sel bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
           'brand', c.brand, 'studio_status', c.studio_status,
           'attendance_synced_at', c.attendance_synced_at, 'attendance_from', c.attendance_from,
           'attendance_to', c.attendance_to, 'attendance_state', c.attendance_state,
           'sync_state', c.sync_state, 'busy', public.an_fb_busy(c.sync_state, c.job_started_at))
         order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
    from public.an_fb_connections c where c.id = any (p_sel);
$$;
revoke all on function public.an_fb_attendance_selected(bigint[]) from public, anon, authenticated;

create or replace function public.an_fb_attendance_data(p_from text, p_to text, p_city text, p_studio text,
  p_training text, p_status text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from date;
  v_to date;
  v_city text := coalesce(p_city, '');
  v_studio text := coalesce(p_studio, '');
  v_status text := coalesce(p_status, '');
  v_selected bigint[];
  v_calc jsonb;
begin
  if not public.an_fb_report_allowed('fb.attendance') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  begin
    if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad';
    end if;
    v_from := p_from::date;
    v_to := p_to::date;
    if v_to < v_from or v_to - v_from >= 366 then
      raise exception 'bad';
    end if;
  exception when others then
    raise exception 'Выберите корректный период не больше 366 дней.' using errcode = '22023';
  end;
  if v_status not in ('', 'active', 'archived') then
    raise exception 'Проверьте фильтры.' using errcode = '22023';
  end if;

  v_selected := public.an_fb_owner_ids(array(
    select c.id from public.an_fb_connections c
     where (v_city = '' or c.city = v_city)
       and (v_studio = '' or c.id::text = v_studio)
       and (v_status = '' or c.studio_status = v_status)));
  v_calc := public.an_fb_attendance_groups(v_from, v_to, v_selected, coalesce(p_training, ''));

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'pm_from', (v_from - interval '1 month')::date,
    'pm_to', (v_to - interval '1 month')::date,
    'py_from', (v_from - interval '1 year')::date,
    'py_to', (v_to - interval '1 year')::date,
    'admin', public.an_is_admin(auth.uid()),
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
               'brand', c.brand, 'club_id', c.club_id, 'studio_status', c.studio_status)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c),
    'selected', public.an_fb_attendance_selected(v_selected),
    'trainings', v_calc -> 'trainings',
    'groups', v_calc -> 'groups',
    'unknown', v_calc -> 'unknown');
end;
$$;
revoke all on function public.an_fb_attendance_data(text, text, text, text, text, text) from public, anon;
grant execute on function public.an_fb_attendance_data(text, text, text, text, text, text) to authenticated;

-- Их fitbase_trials.report по отобранным студиям: пробные записи за всё время,
-- непробные платные абонементы клиентов с посещённым пробным и их оплаты,
-- число записей периода с неопределённым типом.
create or replace function public.an_fb_trials_core(p_range daterange, p_sel bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with sel as (
    select c.id, public.an_fb_owner(c.domain, c.club_id) as owner,
           public.an_fb_effective_rules(c.attendance_rules) as rules
      from public.an_fb_connections c where c.id = any (p_sel)
  ), regs as (
    select r.connection_id, r.registration_id, r.client_key, r.status, e.day, e.end_at,
           coalesce((s.rules ->> r.status) = 'visited', false) as visited,
           coalesce(o.kind::int, p.is_trial, -1) as kind
      from public.an_fb_records r
      join sel s on s.id = r.connection_id
      join public.an_fb_events e on e.connection_id = r.connection_id and e.event_id = r.event_id
      left join public.an_fb_trial_overrides o
        on o.connection_id = r.connection_id and o.registration_id = r.registration_id and o.owner = s.owner
      left join public.an_fb_trial_products p
        on p.connection_id = r.connection_id and p.kind = 'registration' and p.item_id = r.registration_id
     where not e.cancelled
  ), trials as (
    select * from regs where kind = 1
  ), buyers as (
    select distinct connection_id, client_key from trials where visited and client_key <> ''
  ), sales as (
    select s.connection_id, s.contract_id, s.client_id, s.purchased_at, s.price_cents
      from public.an_fb_sales s
      join buyers b on b.connection_id = s.connection_id and b.client_key = s.client_id
      join public.an_fb_trial_products p
        on p.connection_id = s.connection_id and p.kind = 'contract' and p.item_id = s.contract_id
     where s.price_cents > 0 and p.is_trial = 0
  )
  select jsonb_build_object(
    'records', (
      select coalesce(jsonb_agg(jsonb_build_array(t.connection_id, t.registration_id, t.client_key,
               t.visited, t.day, t.end_at)), '[]')
        from trials t),
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_array(s.connection_id, s.contract_id, s.client_id,
               s.purchased_at, s.price_cents)), '[]')
        from sales s),
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_array(p.connection_id, p.contract_id, p.operation,
               p.amount_cents, p.pay_at)), '[]')
        from public.an_fb_payments p
       where exists (select 1 from sales s where s.connection_id = p.connection_id and s.contract_id = p.contract_id)),
    'review_count', (
      select count(*) from regs r
       where r.kind < 0 and r.day >= lower(p_range)::text and r.day <= (upper(p_range) - 1)::text));
$$;
revoke all on function public.an_fb_trials_core(daterange, bigint[]) from public, anon, authenticated;

-- Отобранные студии воронки (поля их страницы).
create or replace function public.an_fb_trials_connections(p_sel bigint[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
           'brand', c.brand, 'attendance_synced_at', c.attendance_synced_at,
           'attendance_from', c.attendance_from, 'attendance_to', c.attendance_to,
           'sales_payments_at', c.sales_payments_at, 'sales_synced_at', c.sales_synced_at)
         order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
    from public.an_fb_connections c where c.id = any (p_sel);
$$;
revoke all on function public.an_fb_trials_connections(bigint[]) from public, anon, authenticated;

create or replace function public.an_fb_trials_data(p_from text, p_to text, p_city text, p_studio text,
  p_brand text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_range daterange;
  v_sel bigint[];
  v_core jsonb;
begin
  if not public.an_fb_report_allowed('fb.trials') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  v_range := public.an_fb_trials_window(p_from, p_to);
  if coalesce(p_brand, '') not in ('', 'Lady Jump', 'Lady Stretch') then
    raise exception 'Проверьте направление.' using errcode = '22023';
  end if;
  v_sel := public.an_fb_trials_selected(p_city, p_studio, p_brand);
  v_core := public.an_fb_trials_core(v_range, v_sel);
  return jsonb_build_object(
    'from', lower(v_range),
    'to', upper(v_range) - 1,
    'now', extract(epoch from now())::bigint,
    'admin', public.an_is_admin(auth.uid()),
    'batch', (select jsonb_build_object(
                'active', b.active and b.updated_at >= now() - interval '30 minutes',
                'message', coalesce(b.payload ->> 'message', ''))
                from public.an_fb_batch b where b.id = 1),
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'brand', c.brand)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c),
    'selected', public.an_fb_trials_connections(v_sel),
    'records', v_core -> 'records',
    'sales', v_core -> 'sales',
    'payments', v_core -> 'payments',
    'review_count', v_core -> 'review_count');
end;
$$;
revoke all on function public.an_fb_trials_data(text, text, text, text, text) from public, anon;
grant execute on function public.an_fb_trials_data(text, text, text, text, text) to authenticated;

-- Псевдоним ID клиента на один запрос: их доска партнёра не передаёт ID
-- клиентов, а расчёт здесь — в браузере; равенство ID сохраняется, пустой
-- ID (клиент не передан) остаётся пустым.
create or replace function public.an_fb_pseudo(p_salt text, p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when coalesce(p_value, '') = '' then coalesce(p_value, '')
              else md5(p_salt || ':' || p_value) end;
$$;
revoke all on function public.an_fb_pseudo(text, text) from public, anon, authenticated;

-- 4) «Мой город · FitBase» (их fitbase_partner.route / filters / build) ----------
-- Факты только выбранных студий человека; считает страница
-- (lib/analytics/fitbase/mycity.ts). ID клиентов — псевдонимами запроса. Город — один из городов его студий
-- (по умолчанию первый), студия — одна из студий города или все.
create or replace function public.an_fb_mycity_data(p_from text, p_to text, p_city text, p_studio text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_rows bigint[];
  v_from date;
  v_to date;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_cities text[];
  v_city text;
  v_studio text := coalesce(p_studio, '');
  v_city_rows bigint[];
  v_sel bigint[];
  v_owners bigint[];
  v_range daterange;
  v_lo date;
  v_full boolean;
  v_core jsonb;
  v_att jsonb;
  v_salt text := md5(random()::text || clock_timestamp()::text);
begin
  v_rows := public.an_fb_mycity_ids(v_uid);
  if v_uid is null or cardinality(v_rows) = 0 then
    raise exception 'Студии FitBase вам не назначены.' using errcode = '42501';
  end if;
  begin
    v_from := p_from::date;
    v_to := p_to::date;
    if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad';
    end if;
  exception when others then
    raise exception 'Выберите корректные даты.' using errcode = '22023';
  end;
  if v_to < v_from or v_to - v_from >= 366
     or extract(year from v_from) < extract(year from v_today) - 6 then
    raise exception 'Выберите период до 366 дней, не старше шести лет.' using errcode = '22023';
  end if;

  select array_agg(x.city order by x.city collate "C") into v_cities
    from (select distinct c.city from public.an_fb_connections c where c.id = any (v_rows)) x;
  v_city := coalesce(nullif(p_city, ''), v_cities[1]);
  if not (v_city = any (v_cities)) then
    raise exception 'Этот город вам недоступен.' using errcode = '42501';
  end if;
  v_city_rows := array(select c.id from public.an_fb_connections c
                        where c.id = any (v_rows) and c.city = v_city);
  if v_studio <> '' and not (v_studio = any (array(select x::text from unnest(v_city_rows) x))) then
    raise exception 'Эта студия вам недоступна в выбранном городе.' using errcode = '42501';
  end if;
  v_sel := array(select x from unnest(v_city_rows) x where v_studio = '' or x::text = v_studio);
  v_owners := public.an_fb_owner_ids(v_sel);
  v_range := daterange(v_from, v_to, '[]');
  -- Выручка: выбранный период, пять прошлых месяцев доски и тот же период месяц назад.
  v_lo := least((date_trunc('month', v_to) - interval '5 months')::date,
                (v_from - interval '1 month')::date);
  -- Точка 0 — только когда выбраны все студии города (у них — весь город сети).
  v_full := v_studio = '' and (
    select coalesce(array_agg(c.id order by c.id), '{}') from public.an_fb_connections c
     where c.club_id <> '' and c.city = v_city)
    = (select coalesce(array_agg(x order by x), '{}') from unnest(v_sel) x);
  v_core := public.an_fb_trials_core(v_range, v_owners);
  v_att := public.an_fb_attendance_groups(v_from, v_to, v_owners, '');

  return jsonb_build_object(
    'now', extract(epoch from now())::bigint,
    'admin', public.an_is_admin(v_uid),
    'start', v_from,
    'end', v_to,
    'city', v_city,
    'studio', v_studio,
    'cities', to_jsonb(v_cities),
    'options', (
      select coalesce(jsonb_agg(jsonb_build_array(c.id::text, c.name || ' · ' || c.brand)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c where c.id = any (v_city_rows)),
    'target', case when v_full then (select t.amount_cents from public.an_fb_city_targets t
                                      where t.city = v_city) end,
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'brand', c.brand, 'city', c.city,
               'domain', c.domain, 'club_id', c.club_id, 'studio_status', c.studio_status,
               'marketing_disabled', c.marketing_disabled, 'partner_name', '',
               'synced_at', c.synced_at, 'sales_payments_at', c.sales_payments_at,
               'sales_synced_at', c.sales_synced_at, 'sales_state', c.sales_state,
               'revenue_synced_at', c.revenue_synced_at, 'revenue_from', c.revenue_from,
               'revenue_to', c.revenue_to, 'revenue_state', c.revenue_state,
               'attendance_synced_at', c.attendance_synced_at)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c where c.id = any (v_sel)),
    'daily', (select coalesce(jsonb_agg(jsonb_build_array(d.connection_id, d.day, d.amount_cents)), '[]')
                from public.an_fb_revenue_daily d
               where d.connection_id = any (v_sel) and d.day >= v_lo::text and d.day <= v_to::text),
    'sales', (select coalesce(jsonb_agg(jsonb_build_array(s.connection_id, s.contract_id,
                                                          public.an_fb_pseudo(v_salt, s.client_id),
                                                          s.purchased_at, s.price_cents, s.paid_cents)), '[]')
                from public.an_fb_sales s where s.connection_id = any (v_sel)),
    'history', (select coalesce(jsonb_agg(jsonb_build_array(h.connection_id, h.contract_id,
                                                            public.an_fb_pseudo(v_salt, h.client_id),
                                                            h.purchased_at, h.price_cents)), '[]')
                  from public.an_fb_history h where h.connection_id = any (v_sel)),
    'payments', (select coalesce(jsonb_agg(jsonb_build_array(p.connection_id, p.operation, p.step_id,
                                                             p.contract_id,
                                                             public.an_fb_pseudo(v_salt, p.client_id),
                                                             p.pay_at, p.day, p.amount_cents)), '[]')
                   from public.an_fb_payments p where p.connection_id = any (v_sel)),
    -- Названия абонементов (их trial_products, kind contract).
    'contract_labels', (
      select coalesce(jsonb_agg(jsonb_build_array(p.connection_id, p.item_id, p.label)), '[]')
        from public.an_fb_trial_products p
       where p.connection_id = any (v_sel) and p.kind = 'contract'),
    'attendance', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'pm_from', (v_from - interval '1 month')::date,
      'pm_to', (v_to - interval '1 month')::date,
      'py_from', (v_from - interval '1 year')::date,
      'py_to', (v_to - interval '1 year')::date,
      'admin', false,
      'connections', '[]'::jsonb,
      'selected', public.an_fb_attendance_selected(v_owners),
      'trainings', v_att -> 'trainings',
      'groups', v_att -> 'groups',
      'unknown', v_att -> 'unknown'),
    'trials', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'now', extract(epoch from now())::bigint,
      'admin', false,
      'batch', '{}'::jsonb,
      'connections', '[]'::jsonb,
      'selected', public.an_fb_trials_connections(v_owners),
      'records', (select coalesce(jsonb_agg(jsonb_set(x.value, '{2}',
                    to_jsonb(public.an_fb_pseudo(v_salt, x.value ->> 2))) order by x.n), '[]')
                    from jsonb_array_elements(v_core -> 'records') with ordinality x(value, n)),
      'sales', (select coalesce(jsonb_agg(jsonb_set(x.value, '{2}',
                  to_jsonb(public.an_fb_pseudo(v_salt, x.value ->> 2))) order by x.n), '[]')
                  from jsonb_array_elements(v_core -> 'sales') with ordinality x(value, n)),
      'payments', v_core -> 'payments',
      'review_count', v_core -> 'review_count'),
    -- Их trial_dimensions: название пробной записи — основание со страницы
    -- FitBase (та же запись того же занятия, владелец подключения), иначе
    -- услуга записи из загрузки.
    'trial_labels', (
      select coalesce(jsonb_agg(jsonb_build_array(t.connection_id, t.registration_id, t.label)), '[]')
        from (select r.connection_id, r.registration_id,
                     coalesce(nullif(b.label, ''), nullif(p.label, '')) as label
                from jsonb_array_elements(v_core -> 'records') x
                join public.an_fb_records r
                  on r.connection_id = (x.value ->> 0)::bigint and r.registration_id = x.value ->> 1
                join public.an_fb_connections c on c.id = r.connection_id
                left join public.an_fb_trial_basis b
                  on b.connection_id = r.connection_id and b.registration_id = r.registration_id
                 and b.event_id = r.event_id and b.owner = public.an_fb_owner(c.domain, c.club_id)
                left join public.an_fb_trial_products p
                  on p.connection_id = r.connection_id and p.kind = 'registration'
                 and p.item_id = r.registration_id) t
       where t.label is not null),
    -- Их ключи групп: пары «студия + название» по всем записям студий на
    -- неотменённые занятия (у них — все записи отчёта, любой тип).
    'label_keys', (
      select coalesce(jsonb_agg(distinct jsonb_build_array(r.connection_id,
               coalesce(nullif(b.label, ''), nullif(p.label, ''),
                        'Пробная услуга — название не загружено'))), '[]')
        from public.an_fb_records r
        join public.an_fb_events e
          on e.connection_id = r.connection_id and e.event_id = r.event_id and not e.cancelled
        join public.an_fb_connections c on c.id = r.connection_id
        left join public.an_fb_trial_basis b
          on b.connection_id = r.connection_id and b.registration_id = r.registration_id
         and b.event_id = r.event_id and b.owner = public.an_fb_owner(c.domain, c.club_id)
        left join public.an_fb_trial_products p
          on p.connection_id = r.connection_id and p.kind = 'registration'
         and p.item_id = r.registration_id
       where r.connection_id = any (v_owners)),
    -- Их review.data: записи периода с неопределённым типом (любой статус).
    'unknown', (
      select count(*)
        from public.an_fb_connections c
        cross join lateral (select public.an_fb_owner(c.domain, c.club_id) as owner) k
        join public.an_fb_records r on r.connection_id = c.id
        join public.an_fb_events e on e.connection_id = r.connection_id and e.event_id = r.event_id
        left join public.an_fb_trial_overrides o
          on o.connection_id = r.connection_id and o.registration_id = r.registration_id and o.owner = k.owner
        left join public.an_fb_trial_products p
          on p.connection_id = r.connection_id and p.kind = 'registration' and p.item_id = r.registration_id
       where c.id = any (v_owners)
         and e.day >= v_from::text and e.day <= v_to::text
         and not e.cancelled
         and coalesce(o.kind::int, p.is_trial, -1) < 0));
end;
$$;
revoke all on function public.an_fb_mycity_data(text, text, text, text) from public, anon;
grant execute on function public.an_fb_mycity_data(text, text, text, text) to authenticated;

-- 5) Назначение студий и точка 0 (их admin_render / save_grants) — администратору.
create or replace function public.an_fb_partner_access()
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
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
               'brand', c.brand)
             order by c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c where c.club_id <> ''),
    'people', (
      select coalesce(jsonb_agg(public.an_person_json(x.id) || jsonb_build_object(
               'studios', (select coalesce(jsonb_agg(g.connection_id order by g.connection_id), '[]')
                             from public.an_fb_user_studios g
                             join public.an_fb_connections c on c.id = g.connection_id
                              and c.domain = g.domain and c.club_id = g.club_id
                            where g.user_id = x.id),
               'admin', public.an_is_admin(x.id))
             order by coalesce(nullif(btrim(p.full_name), ''), '') collate "C", x.id), '[]')
        from (select user_id as id from public.portal_users
              union
              select id from public.portal_people_ids() id
              union
              select user_id from public.an_fb_user_studios) x
        left join public.profiles p on p.id = x.id
       where exists (select 1 from auth.users u where u.id = x.id)),
    'targets', (
      select coalesce(jsonb_agg(jsonb_build_object('city', t.city, 'amount_cents', t.amount_cents)
             order by t.city collate "C"), '[]')
        from public.an_fb_city_targets t),
    'cities', (
      select coalesce(jsonb_agg(distinct c.city), '[]')
        from public.an_fb_connections c where c.club_id <> ''));
end;
$$;
revoke all on function public.an_fb_partner_access() from public, anon;
grant execute on function public.an_fb_partner_access() to authenticated;

create or replace function public.an_fb_partner_access_save(p_user uuid, p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := array(select distinct x from unnest(coalesce(p_ids, '{}')) x order by x);
begin
  perform public.an_require_admin();
  if p_user is null or exists (select 1 from unnest(v_ids) x where x is null) then
    raise exception 'Некорректный пользователь или студия.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_ids) x
              where not exists (select 1 from public.an_fb_connections c where c.id = x and c.club_id <> '')) then
    raise exception 'Подключение изменилось. Обновите страницу.' using errcode = '22023';
  end if;
  -- Их «действующая учётная запись»: человек портала; снять доступ можно всегда.
  if cardinality(v_ids) > 0 and not public.is_portal_user(p_user) then
    raise exception 'Выберите действующую учётную запись партнёра.' using errcode = '22023';
  end if;
  delete from public.an_fb_user_studios where user_id = p_user;
  insert into public.an_fb_user_studios (user_id, connection_id, domain, club_id)
  select p_user, c.id, c.domain, c.club_id from public.an_fb_connections c where c.id = any (v_ids);
  perform public.an_audit_add(auth.uid(), 'fitbase_partner_access',
    jsonb_build_object('user_id', p_user, 'connections', to_jsonb(v_ids))::text);
end;
$$;
revoke all on function public.an_fb_partner_access_save(uuid, bigint[]) from public, anon;
grant execute on function public.an_fb_partner_access_save(uuid, bigint[]) to authenticated;

-- Точка 0 города в копейках; null — убрать.
create or replace function public.an_fb_city_target_save(p_city text, p_amount_cents bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if coalesce(btrim(p_city), '') = ''
     or not exists (select 1 from public.an_fb_connections c where c.club_id <> '' and c.city = p_city) then
    raise exception 'Выберите город студий FitBase.' using errcode = '22023';
  end if;
  if p_amount_cents is null then
    delete from public.an_fb_city_targets where city = p_city;
  elsif p_amount_cents < 0 or p_amount_cents > 100000000000 then
    raise exception 'Проверьте сумму точки 0.' using errcode = '22023';
  else
    insert into public.an_fb_city_targets (city, amount_cents, updated_at, updated_by)
    values (p_city, p_amount_cents, now(), auth.uid())
    on conflict (city) do update
      set amount_cents = excluded.amount_cents, updated_at = now(), updated_by = auth.uid();
  end if;
  perform public.an_audit_add(auth.uid(), 'fitbase_city_target',
    p_city || ': ' || coalesce((p_amount_cents / 100)::text, '—'));
end;
$$;
revoke all on function public.an_fb_city_target_save(text, bigint) from public, anon;
grant execute on function public.an_fb_city_target_save(text, bigint) to authenticated;
