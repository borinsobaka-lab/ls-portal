-- ============================================================================
-- «Аналитика» → «Администрирование» (ANALYTICS_PLAN.md §8.8, этап 1): ядро
-- старого портала аналитики Lady Stretch (app.py) — журнал действий,
-- посещаемость, партнёры, API для GPT:
--
--   * an_audit — их audit_log: кто, что, детали, когда. Пишут функции этого
--     файла (вход в «Аналитику», партнёры, ключи API) и триггер загрузки
--     снимка 1С в отчёты (их onec_snapshot_imported); читает журнал
--     администратор аналитики (an_audit_list);
--   * посещаемость — их user_sessions + activity_samples и /presence:
--     открытая страница «Аналитики» раз в 15 секунд шлёт пульс, если вкладка
--     видна и человек что-то делал последние 3 минуты; засчитывается
--     промежуток с прошлого пульса, только если он не длиннее 45 секунд
--     (an_presence). Визит — их сессия: у нас — сессия входа в портал (claim
--     session_id токена GoTrue), первый пульс сессии пишет в журнал «вход».
--     Отчёт — an_activity_report: визиты (сессии или входы — что больше),
--     активное время, просмотры и дашборды (их dashboard_view), последняя
--     активность; период — по Москве, как у них;
--   * партнёры — их user_partner_cities / partner_profiles /
--     partner_city_settings (таблицы — 2026-10-29_z_analytics_core.sql):
--     список, города, карточка с реквизитами и условиями городов. Учётную
--     запись и роли партнёра заводят в «Пользователях и ролях», здесь —
--     только города и карточка;
--   * API для GPT — их analytics_api_keys / analytics_api_requests: ключи
--     (хранится только SHA-256, сам ключ показывается один раз), журнал
--     запросов; проверку ключа и запись запроса делает сервер портала
--     (service_role).
--
-- an_onec_scope — актуальное определение здесь: сервер (service_role, API для
-- GPT) читает отчёты 1С по всей сети.
--
-- Идемпотентно.
-- ============================================================================

-- 1) Журнал действий ------------------------------------------------------------
create table if not exists public.an_audit (
  id bigint generated always as identity primary key,
  -- null — «Система» (как их LEFT JOIN users).
  user_id uuid references auth.users (id) on delete set null,
  event text not null check (char_length(event) between 1 and 100),
  details text check (details is null or char_length(details) <= 4000),
  created_at timestamptz not null default now()
);
create index if not exists an_audit_created_idx on public.an_audit (created_at desc, id desc);
create index if not exists an_audit_user_event_idx on public.an_audit (user_id, event, created_at);

create or replace function public.an_audit_add(_user_id uuid, _event text, _details text default '')
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_audit (user_id, event, details)
  values (_user_id, _event, left(coalesce(_details, ''), 4000))
$$;
revoke all on function public.an_audit_add(uuid, text, text) from public, anon, authenticated;
grant execute on function public.an_audit_add(uuid, text, text) to service_role;

-- 2) Посещаемость ---------------------------------------------------------------
-- Их user_sessions: сессия входа (у нас — session_id токена GoTrue).
create table if not exists public.an_activity_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  active_seconds integer not null default 0
);
create index if not exists an_activity_sessions_user_idx on public.an_activity_sessions (user_id, last_seen_at);

-- Их activity_samples: засчитанный промежуток активного времени.
create table if not exists public.an_activity (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.an_activity_sessions (session_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  dashboard text not null,
  recorded_at timestamptz not null default now(),
  active_seconds integer not null check (active_seconds > 0)
);
create index if not exists an_activity_user_time_idx on public.an_activity (user_id, recorded_at);

-- Сессия входа вызывающего: claim session_id токена GoTrue. Без него (старый
-- токен) — одна сессия на человека.
create or replace function public.an_session_id()
returns uuid
language plpgsql
stable
as $$
declare
  v text := coalesce(auth.jwt(), '{}'::jsonb)->>'session_id';
begin
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return md5('an-session:' || auth.uid()::text)::uuid;
end;
$$;
revoke all on function public.an_session_id() from public, anon, authenticated;

-- Их /presence + record_activity. false — человеку «Аналитика» не открыта
-- (у них — 401).
create or replace function public.an_presence(p_dashboard text default 'Главная')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_me jsonb;
  v_session uuid;
  v_row public.an_activity_sessions;
  v_now bigint := floor(extract(epoch from now()))::bigint;
  v_elapsed bigint;
  v_counted integer;
  -- Их «Главная» и названия дашбордов (DASHBOARDS), иначе «Портал».
  v_dashboard text := case
    when p_dashboard = any (array['Главная', 'Выручка', 'Продажи абонементов', 'Занятия',
      'Воронка пробных', 'Нулевая номенклатура', 'Реестр таргета', 'Реестр Авито',
      'Отзывы и оценки', 'Маркетинг Lady Stretch', 'Маркетинг Lady Jump', 'Мой город'])
      then p_dashboard
    else 'Портал'
  end;
begin
  if v_user is null then
    return false;
  end if;
  v_me := public.an_me_for(v_user);
  if v_me is null or not (v_me->>'visible')::boolean then
    return false;
  end if;
  v_session := public.an_session_id();
  insert into public.an_activity_sessions (session_id, user_id)
  values (v_session, v_user)
  on conflict (session_id) do nothing;
  if found then
    -- Первый пульс сессии — их «вход» (у них — вход по паролю).
    perform public.an_audit_add(v_user, 'login', '');
    return true;
  end if;
  select * into v_row from public.an_activity_sessions where session_id = v_session for update;
  if v_row.user_id <> v_user then
    return false;
  end if;
  -- «Браузер шлёт пульс раз в 15–30 секунд; больший промежуток — простой,
  -- вкладка скрыта или нет связи: не считается». Секунды — целые, как их
  -- int(time.time()).
  v_elapsed := v_now - floor(extract(epoch from v_row.last_active_at))::bigint;
  v_counted := case when v_elapsed > 0 and v_elapsed <= 45 then v_elapsed::integer else 0 end;
  update public.an_activity_sessions
     set last_seen_at = now(), last_active_at = now(), active_seconds = active_seconds + v_counted
   where session_id = v_session;
  if v_counted > 0 then
    insert into public.an_activity (session_id, user_id, dashboard, active_seconds)
    values (v_session, v_user, v_dashboard, v_counted);
  end if;
  return true;
end;
$$;
revoke all on function public.an_presence(text) from public, anon;
grant execute on function public.an_presence(text) to authenticated;

-- Люди «Аналитики»: кому она открыта, партнёры и все, кто был активен в
-- периоде (у них — все учётные записи портала аналитики).
create or replace function public.an_people(_from timestamptz, _to timestamptz)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select x.id
    from (
      select r.user_id as id from public.access_user_rights r where r.portal
      union
      select pc.user_id from public.an_partner_cities pc
    ) x
   where coalesce((public.an_me_for(x.id)->>'visible')::boolean, false)
  union
  select a.user_id from public.an_activity a where a.recorded_at >= _from and a.recorded_at < _to
  union
  select au.user_id from public.an_audit au
   where au.user_id is not null and au.event in ('login', 'dashboard_view')
     and au.created_at >= _from and au.created_at < _to
$$;
revoke all on function public.an_people(timestamptz, timestamptz) from public, anon, authenticated;

-- Имя, должность и почта человека (их full_name, position, login).
create or replace function public.an_person_json(_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', u.id,
    'full_name', coalesce(nullif(btrim(p.full_name), ''), u.email::text, ''),
    'position', pos.name,
    'email', coalesce(nullif(btrim(p.email), ''), u.email::text),
    'active', public.is_portal_user(u.id))
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
   where u.id = _user_id
$$;
revoke all on function public.an_person_json(uuid) from public, anon, authenticated;

-- Их activity_page: по каждому человеку за период (дни по Москве).
create or replace function public.an_activity_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_rows jsonb;
begin
  perform public.an_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Неверный период' using errcode = '22023';
  end if;
  v_from := p_from::timestamp at time zone 'Europe/Moscow';
  v_to := (p_to + 1)::timestamp at time zone 'Europe/Moscow';
  with people as (
    select id from public.an_people(v_from, v_to) id
  ), s as (
    select a.user_id, sum(a.active_seconds)::bigint as seconds,
           count(distinct a.session_id) as sessions, max(a.recorded_at) as last_active
      from public.an_activity a
     where a.recorded_at >= v_from and a.recorded_at < v_to
     group by a.user_id
  ), l as (
    select au.user_id,
           count(*) filter (where au.event = 'login') as logins,
           count(*) filter (where au.event = 'dashboard_view') as views,
           array_agg(distinct au.details collate "C" order by au.details collate "C")
             filter (where au.event = 'dashboard_view') as dashboards
      from public.an_audit au
     where au.created_at >= v_from and au.created_at < v_to
       and au.event in ('login', 'dashboard_view')
     group by au.user_id
  )
  select coalesce(jsonb_agg(
           public.an_person_json(pe.id) || jsonb_build_object(
             'visits', greatest(coalesce(s.sessions, 0), coalesce(l.logins, 0)),
             'seconds', coalesce(s.seconds, 0),
             'views', coalesce(l.views, 0),
             'dashboards', to_jsonb(coalesce(l.dashboards, '{}')),
             'last_active', s.last_active)
           order by coalesce(nullif(btrim(p.full_name), ''), '') collate "C", pe.id), '[]')
    into v_rows
    from people pe
    left join public.profiles p on p.id = pe.id
    left join s on s.user_id = pe.id
    left join l on l.user_id = pe.id
   where exists (select 1 from auth.users u where u.id = pe.id);
  return v_rows;
end;
$$;
revoke all on function public.an_activity_report(date, date) from public, anon;
grant execute on function public.an_activity_report(date, date) to authenticated, service_role;

-- Журнал: последние действия (их «Последняя активность»), постранично.
create or replace function public.an_audit_list(p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.an_require_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'created_at', a.created_at, 'user_id', a.user_id,
           'full_name', case when a.user_id is null then null
                             else coalesce(nullif(btrim(p.full_name), ''), u.email::text) end,
           'event', a.event, 'details', a.details) order by a.created_at desc, a.id desc), '[]')
    into v_rows
    from (select * from public.an_audit
           order by created_at desc, id desc
           limit least(greatest(coalesce(p_limit, 20), 1), 200)
          offset greatest(coalesce(p_offset, 0), 0)) a
    left join public.profiles p on p.id = a.user_id
    left join auth.users u on u.id = a.user_id;
  return jsonb_build_object('total', (select count(*) from public.an_audit), 'rows', v_rows);
end;
$$;
revoke all on function public.an_audit_list(integer, integer) from public, anon;
grant execute on function public.an_audit_list(integer, integer) to authenticated, service_role;

-- Загрузка снимка 1С в отчёты — их onec_snapshot_imported.
create or replace function public.an_onec_snapshots_audit_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state = 'ready' and new.state = 'current' then
    perform public.an_audit_add(auth.uid(), 'onec_snapshot_imported', 'Снимок ' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists an_onec_snapshots_audit_au on public.an_onec_snapshots;
create trigger an_onec_snapshots_audit_au
  after update of state on public.an_onec_snapshots
  for each row execute function public.an_onec_snapshots_audit_au();

-- 3) Партнёры -------------------------------------------------------------------
-- Их onec_city_names: города выгрузок 1С (текущий снимок) и справочника
-- студий; порядок — по кодам символов, как sorted() в Python.
create or replace function public.an_partner_city_options()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_slot smallint := public.an_onec_slot('current');
begin
  perform public.an_require_admin();
  return array(
    select c from (
      select city as c from public.an_onec_items where slot = v_slot
      union
      select btrim(city) from public.an_onec_studios
    ) x
     where coalesce(c, '') <> ''
     order by c collate "C");
end;
$$;
revoke all on function public.an_partner_city_options() from public, anon;
grant execute on function public.an_partner_city_options() to authenticated, service_role;

-- Города партнёра: хотя бы один и только известные (их «для города нет
-- опубликованного партнёрского борда»).
create or replace function public.an_partner_check_cities(_cities text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cities text[] := array(select c from (select distinct c from unnest(coalesce(_cities, '{}')) c
                                           where coalesce(c, '') <> '') x
                            order by c collate "C");
  v_known text[] := public.an_partner_city_options();
begin
  if cardinality(v_cities) = 0 then
    raise exception 'Выберите хотя бы один разрешённый город.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_cities) c where not (c = any (v_known))) then
    raise exception 'Для одного из выбранных городов нет данных 1С — отчёта «Мой город» по нему нет.'
      using errcode = '22023';
  end if;
  return v_cities;
end;
$$;
revoke all on function public.an_partner_check_cities(text[]) from public, anon, authenticated;

-- Их partners_page_v2: партнёры (есть города) с городами и отчётами,
-- открытыми им из маркетинга и отзывов.
create or replace function public.an_partners()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.an_require_admin();
  select coalesce(jsonb_agg(
           public.an_person_json(x.user_id) || jsonb_build_object(
             'cities', to_jsonb(x.cities),
             'reports', (select coalesce(jsonb_agg(r order by r collate "C"), '[]')
                           from jsonb_array_elements_text(
                                  coalesce(public.an_me_for(x.user_id)->'reports', '[]')) r
                          where r in ('mkt.ls', 'mkt.lj', 'reviews')))
           order by coalesce(nullif(btrim(p.full_name), ''), '') collate "C", x.user_id), '[]')
    into v_rows
    from (select user_id, array_agg(city order by city collate "C") as cities
            from public.an_partner_cities group by user_id) x
    left join public.profiles p on p.id = x.user_id;
  return v_rows;
end;
$$;
revoke all on function public.an_partners() from public, anon;
grant execute on function public.an_partners() to authenticated, service_role;

-- Кого можно сделать партнёром: люди портала, ещё не партнёры.
create or replace function public.an_partner_candidates()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.an_require_admin();
  select coalesce(jsonb_agg(public.an_person_json(x.id)
           order by coalesce(nullif(btrim(p.full_name), ''), '') collate "C", x.id), '[]')
    into v_rows
    from (select user_id as id from public.portal_users
          union
          select id from public.portal_people_ids() id) x
    left join public.profiles p on p.id = x.id
   where not exists (select 1 from public.an_partner_cities pc where pc.user_id = x.id)
     and exists (select 1 from auth.users u where u.id = x.id);
  return v_rows;
end;
$$;
revoke all on function public.an_partner_candidates() from public, anon;
grant execute on function public.an_partner_candidates() to authenticated, service_role;

-- Их «Создать партнёра»: человеку портала — города.
create or replace function public.an_partner_add(p_user uuid, p_cities text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cities text[];
begin
  perform public.an_require_admin();
  if not exists (select 1 from public.portal_users where user_id = p_user)
     and not public.is_portal_user(p_user) then
    raise exception 'Пользователь не найден в «Пользователях и ролях».' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.an_partner_cities where user_id = p_user) then
    raise exception 'Этот пользователь уже партнёр — города меняются в его строке.' using errcode = '23505';
  end if;
  v_cities := public.an_partner_check_cities(p_cities);
  insert into public.an_partner_cities (user_id, city) select p_user, c from unnest(v_cities) c;
  perform public.an_audit_add(auth.uid(), 'partner_created', array_to_string(v_cities, ', '));
end;
$$;
revoke all on function public.an_partner_add(uuid, text[]) from public, anon;
grant execute on function public.an_partner_add(uuid, text[]) to authenticated, service_role;

-- Их «Изменить города».
create or replace function public.an_partner_set_cities(p_user uuid, p_cities text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cities text[];
begin
  perform public.an_require_admin();
  if not exists (select 1 from public.an_partner_cities where user_id = p_user) then
    raise exception 'Партнёр не найден.' using errcode = 'P0002';
  end if;
  v_cities := public.an_partner_check_cities(p_cities);
  delete from public.an_partner_cities where user_id = p_user and not (city = any (v_cities));
  insert into public.an_partner_cities (user_id, city)
  select p_user, c from unnest(v_cities) c
  on conflict do nothing;
  perform public.an_audit_add(auth.uid(), 'partner_cities_changed',
    coalesce(public.an_person_json(p_user)->>'email', '') || ': ' || array_to_string(v_cities, ', '));
end;
$$;
revoke all on function public.an_partner_set_cities(uuid, text[]) from public, anon;
grant execute on function public.an_partner_set_cities(uuid, text[]) to authenticated, service_role;

-- Убрать из партнёров (у них — только удалением учётной записи): города
-- снимаются, карточка и условия городов остаются, как у них при смене
-- городов.
create or replace function public.an_partner_remove(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  delete from public.an_partner_cities where user_id = p_user;
  if not found then
    raise exception 'Партнёр не найден.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'partner_removed',
    coalesce(public.an_person_json(p_user)->>'email', ''));
end;
$$;
revoke all on function public.an_partner_remove(uuid) from public, anon;
grant execute on function public.an_partner_remove(uuid) to authenticated, service_role;

-- Их partner_profile_page: реквизиты, города с их студиями (справочник
-- студий «Обработки 1С»), стоимость пробного и направления города.
create or replace function public.an_partner_card(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile public.an_partner_profiles;
begin
  perform public.an_require_admin();
  if not exists (select 1 from public.an_partner_cities where user_id = p_user) then
    raise exception 'Партнёр не найден.' using errcode = 'P0002';
  end if;
  select * into v_profile from public.an_partner_profiles where user_id = p_user;
  return public.an_person_json(p_user) || jsonb_build_object(
    'profile', jsonb_build_object(
      'phone', coalesce(v_profile.phone, ''),
      'telegram', coalesce(v_profile.telegram, ''),
      'max_messenger', coalesce(v_profile.max_messenger, ''),
      'individual_entrepreneur', coalesce(v_profile.individual_entrepreneur, ''),
      'inn', coalesce(v_profile.inn, '')),
    'cities', (select coalesce(jsonb_agg(jsonb_build_object(
                 'city', pc.city,
                 'trial_price', coalesce(cs.trial_price, ''),
                 'directions', coalesce(cs.directions, ''),
                 'studios', (select coalesce(jsonb_agg(jsonb_build_object(
                                'name', coalesce(st.studio, ''), 'status', coalesce(st.status, ''))
                                order by st.sort_order), '[]')
                               from public.an_onec_studios st
                              where btrim(st.city) = pc.city and coalesce(st.studio, '') <> ''))
                 order by pc.city collate "C"), '[]')
                 from public.an_partner_cities pc
                 left join public.an_partner_city_settings cs
                   on cs.user_id = pc.user_id and cs.city = pc.city
                where pc.user_id = p_user));
end;
$$;
revoke all on function public.an_partner_card(uuid) from public, anon;
grant execute on function public.an_partner_card(uuid) to authenticated, service_role;

-- Их «Сохранить карточку». p: {phone, telegram, max_messenger,
-- individual_entrepreneur, inn, cities: [{city, trial_price, directions}]}.
create or replace function public.an_partner_card_save(p_user uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inn text := btrim(coalesce(p->>'inn', ''));
  v_cities text[];
  v_given text[];
begin
  perform public.an_require_admin();
  v_cities := array(select city from public.an_partner_cities where user_id = p_user order by city collate "C");
  if cardinality(v_cities) = 0 then
    raise exception 'Партнёр не найден.' using errcode = 'P0002';
  end if;
  v_given := array(select e->>'city' from jsonb_array_elements(coalesce(p->'cities', '[]')) e
                    order by e->>'city' collate "C");
  if v_given is distinct from v_cities then
    raise exception 'Не удалось сопоставить данные с городами партнёра.' using errcode = '22023';
  end if;
  if v_inn <> '' and v_inn !~ '^([0-9]{10}|[0-9]{12})$' then
    raise exception 'ИНН должен состоять из 10 или 12 цифр.' using errcode = '22023';
  end if;
  insert into public.an_partner_profiles
    (user_id, phone, telegram, max_messenger, individual_entrepreneur, inn, updated_at)
  values (p_user,
    nullif(btrim(coalesce(p->>'phone', '')), ''),
    nullif(btrim(coalesce(p->>'telegram', '')), ''),
    nullif(btrim(coalesce(p->>'max_messenger', '')), ''),
    nullif(btrim(coalesce(p->>'individual_entrepreneur', '')), ''),
    nullif(v_inn, ''), now())
  on conflict (user_id) do update
    set phone = excluded.phone, telegram = excluded.telegram,
        max_messenger = excluded.max_messenger,
        individual_entrepreneur = excluded.individual_entrepreneur,
        inn = excluded.inn, updated_at = now();
  insert into public.an_partner_city_settings (user_id, city, trial_price, directions)
  select p_user, e->>'city',
         nullif(btrim(coalesce(e->>'trial_price', '')), ''),
         nullif(btrim(coalesce(e->>'directions', '')), '')
    from jsonb_array_elements(p->'cities') e
  on conflict (user_id, city) do update
    set trial_price = excluded.trial_price, directions = excluded.directions;
  perform public.an_audit_add(auth.uid(), 'partner_profile_changed',
    coalesce(public.an_person_json(p_user)->>'email', ''));
end;
$$;
revoke all on function public.an_partner_card_save(uuid, jsonb) from public, anon;
grant execute on function public.an_partner_card_save(uuid, jsonb) to authenticated, service_role;

-- 4) API для GPT ----------------------------------------------------------------
-- Их analytics_api_keys: бессрочный ключ только для чтения, в базе — SHA-256.
create table if not exists public.an_api_keys (
  id bigint generated always as identity primary key,
  label text not null unique check (char_length(btrim(label)) between 1 and 200),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz
);
-- Их analytics_api_requests.
create table if not exists public.an_api_requests (
  id bigint generated always as identity primary key,
  key_id bigint references public.an_api_keys (id) on delete set null,
  method text not null,
  path text not null,
  query text not null default '',
  status_code integer not null,
  response_bytes integer not null default 0,
  requested_at timestamptz not null default now()
);
create index if not exists an_api_requests_time_idx on public.an_api_requests (requested_at desc);

-- Новый ключ: браузер администратора создаёт его сам и присылает только
-- хеш — ключ видит один раз только он (их «It is shown exactly once»).
create or replace function public.an_api_key_create(p_label text, p_hash text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform public.an_require_admin();
  if btrim(coalesce(p_label, '')) = '' then
    raise exception 'Укажите название ключа.' using errcode = '22023';
  end if;
  if exists (select 1 from public.an_api_keys where label = btrim(p_label)) then
    raise exception 'Ключ с таким названием уже есть.' using errcode = '23505';
  end if;
  if coalesce(p_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'an_bad_key' using errcode = '22023';
  end if;
  insert into public.an_api_keys (label, key_hash, created_by)
  values (btrim(p_label), p_hash, auth.uid())
  returning id into v_id;
  perform public.an_audit_add(auth.uid(), 'analytics_api_key_created', btrim(p_label));
  return v_id;
end;
$$;
revoke all on function public.an_api_key_create(text, text) from public, anon;
grant execute on function public.an_api_key_create(text, text) to authenticated, service_role;

create or replace function public.an_api_key_set_active(p_id bigint, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  perform public.an_require_admin();
  update public.an_api_keys set is_active = coalesce(p_active, false) where id = p_id
  returning label into v_label;
  if v_label is null then
    raise exception 'an_not_found' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(),
    case when p_active then 'analytics_api_key_enabled' else 'analytics_api_key_disabled' end, v_label);
end;
$$;
revoke all on function public.an_api_key_set_active(bigint, boolean) from public, anon;
grant execute on function public.an_api_key_set_active(bigint, boolean) to authenticated, service_role;

-- Ключи и последние запросы — администратору.
create or replace function public.an_api_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'keys', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', k.id, 'label', k.label, 'is_active', k.is_active,
               'created_at', k.created_at, 'last_used_at', k.last_used_at,
               'requests_30d', (select count(*) from public.an_api_requests r
                                 where r.key_id = k.id and r.requested_at >= now() - interval '30 days'))
               order by k.created_at desc), '[]')
               from public.an_api_keys k),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', r.id, 'requested_at', r.requested_at, 'label', k.label,
                   'method', r.method, 'path', r.path, 'query', r.query,
                   'status_code', r.status_code, 'response_bytes', r.response_bytes)
                   order by r.requested_at desc, r.id desc), '[]')
                   from (select * from public.an_api_requests
                          order by requested_at desc, id desc limit 50) r
                   left join public.an_api_keys k on k.id = r.key_id));
end;
$$;
revoke all on function public.an_api_overview() from public, anon;
grant execute on function public.an_api_overview() to authenticated, service_role;

-- Сервер: ключ по хешу (их analytics_api_key) — id действующего или null.
create or replace function public.an_api_key_check(p_hash text)
returns bigint
language sql
security definer
set search_path = public
as $$
  update public.an_api_keys set last_used_at = now()
   where key_hash = p_hash and is_active
  returning id
$$;
revoke all on function public.an_api_key_check(text) from public, anon, authenticated;
grant execute on function public.an_api_key_check(text) to service_role;

-- Сервер: запись запроса (их log_analytics_request).
create or replace function public.an_api_log(
  p_key bigint, p_method text, p_path text, p_query text, p_status integer, p_bytes integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_api_requests (key_id, method, path, query, status_code, response_bytes)
  values (p_key, left(coalesce(p_method, ''), 10), left(coalesce(p_path, ''), 500),
          left(coalesce(p_query, ''), 2000), coalesce(p_status, 0), greatest(coalesce(p_bytes, 0), 0))
$$;
revoke all on function public.an_api_log(bigint, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.an_api_log(bigint, text, text, text, integer, integer) to service_role;

-- 5) Отчёты 1С — серверу по всей сети -------------------------------------------
-- Их onec_scope: города, которыми ограничен человек (null — вся сеть), или
-- an_forbidden. Сервер (service_role, API для GPT) — вся сеть: браузеру
-- an_onec_aggregate / an_onec_report_meta выданы только authenticated, у него
-- auth.uid() есть всегда; anon их не вызывает.
create or replace function public.an_onec_scope(p_board text)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me jsonb;
  v_reports text[];
  v_key text;
begin
  if public.an_onec_board_reports(p_board) is null then
    raise exception 'an_onec_bad_board' using errcode = '22023';
  end if;
  if auth.uid() is null then
    return null;
  end if;
  v_me := public.an_me_for(auth.uid());
  if v_me is null then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  if (v_me->>'admin')::boolean then
    return null;
  end if;
  v_reports := array(select jsonb_array_elements_text(coalesce(v_me->'reports', '[]')));
  if jsonb_typeof(v_me->'partner_cities') = 'array' then
    -- «Партнёру доступен отчёт «Мой город»» — и только по его городам.
    if p_board <> 'partner' then
      raise exception 'an_forbidden' using errcode = '42501';
    end if;
    return array(select jsonb_array_elements_text(v_me->'partner_cities'));
  end if;
  if p_board = 'partner' then
    -- «Для общего отчёта нужны права на выручку, продажи, занятия и воронку».
    if not (array['onec.revenue', 'onec.sales', 'onec.classes', 'onec.trials', 'onec.mycity'] <@ v_reports) then
      raise exception 'an_forbidden' using errcode = '42501';
    end if;
    return null;
  end if;
  v_key := case p_board
    when 'revenue' then 'onec.revenue'
    when 'sales' then 'onec.sales'
    when 'activities' then 'onec.classes'
    when 'funnel' then 'onec.trials'
    else 'onec.zero'
  end;
  if not (v_key = any (v_reports)) then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  return null;
end;
$$;
revoke all on function public.an_onec_scope(text) from public, anon, authenticated;
grant execute on function public.an_onec_scope(text) to service_role;

-- 6) Доступ к таблицам: только через функции -------------------------------------
alter table public.an_audit enable row level security;
alter table public.an_activity_sessions enable row level security;
alter table public.an_activity enable row level security;
alter table public.an_api_keys enable row level security;
alter table public.an_api_requests enable row level security;
revoke all on public.an_audit, public.an_activity_sessions, public.an_activity,
  public.an_api_keys, public.an_api_requests from anon, authenticated;
grant all on public.an_audit, public.an_activity_sessions, public.an_activity,
  public.an_api_keys, public.an_api_requests to service_role;

notify pgrst, 'reload schema';
