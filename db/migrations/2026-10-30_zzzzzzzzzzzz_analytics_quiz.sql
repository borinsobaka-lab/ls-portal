-- ============================================================================
-- «Аналитика» → «Квиз» (ANALYTICS.md, «Квиз»; ANALYTICS_PLAN.md, §8):
-- квиз-лендинги Lady Stretch по городам, приём заявок и их запись в
-- Google-таблицы городов — их /opt/lady-quiz (лендинг), quiz_leads.py и
-- POST /api/quiz/leads (app.py).
--
-- Их config.js (город, адреса студий, цена пробного, «уже прошли», версия
-- лендинга, оператор ПДн) и CITY_SHEETS (таблица и лист города) →
-- an_quiz_cities: адреса, телефоны и ИНН в репозиторий не кладём — их
-- вводит администратор аналитики. Их quiz_leads → an_quiz_leads (те же
-- поля; utm — jsonb вместо текста JSON).
--
-- Заявку принимает сервер портала (/api/analytics/quiz/leads — их проверки
-- источника, размера и полей) и пишет её service-ключом (an_quiz_lead_add);
-- в таблицы городов — задача «quiz_sheets» (внешнее действие, выключена по
-- умолчанию: старый портал пишет те же таблицы): an_quiz_pending →
-- an_quiz_mark. Таблицы закрыты браузеру; лендингу (anon) — только
-- an_quiz_landing (то, что их лендинг и так показывал всем), администратору
-- аналитики — an_quiz_* (города, заявки).
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы -------------------------------------------------------------------------

create table if not exists public.an_quiz_cities (
  id bigint generated always as identity primary key,
  -- Их citySlug: первая часть адреса лендинга (/quiz/<slug>).
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  -- Их city: подпись на лендинге и ключ CITY_SHEETS (город заявки).
  city text not null unique check (char_length(city) between 1 and 300),
  trial_price integer not null default 600 check (trial_price between 0 and 1000000),
  completed_count text not null default '200+' check (char_length(completed_count) <= 40),
  landing_version text not null default '' check (char_length(landing_version) <= 80),
  -- Их locations: [{address, landmark, phone_display, phone_href}].
  locations jsonb not null default '[]' check (jsonb_typeof(locations) = 'array'),
  operator_name text not null default '' check (char_length(operator_name) <= 300),
  operator_inn text not null default '' check (operator_inn ~ '^([0-9]{10}|[0-9]{12})?$'),
  -- Их CITY_SHEETS: таблица и лист заявок города ('' — не настроена).
  spreadsheet_id text not null default '' check (spreadsheet_id ~ '^[A-Za-z0-9_-]{0,200}$'),
  sheet_name text not null default 'Заявки квиза' check (char_length(sheet_name) between 1 and 100),
  -- Их cityConfigs.vsevolozhsk: город лендинга без адреса или с чужим адресом.
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists an_quiz_cities_one_default on public.an_quiz_cities ((true))
  where is_default;

create table if not exists public.an_quiz_leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  city text not null check (char_length(city) between 1 and 300),
  name text not null check (char_length(name) between 2 and 300),
  phone text not null check (char_length(phone) between 1 and 40),
  recommendation text not null default '' check (char_length(recommendation) <= 300),
  pain text not null default '' check (char_length(pain) <= 300),
  duration text not null default '' check (char_length(duration) <= 300),
  barrier text not null default '' check (char_length(barrier) <= 300),
  utm jsonb not null default '{}' check (jsonb_typeof(utm) = 'object'),
  consent_at text not null check (char_length(consent_at) between 1 and 80),
  sheet_synced_at timestamptz,
  sheet_error text not null default '' check (char_length(sheet_error) <= 240)
);
create index if not exists an_quiz_leads_pending_idx on public.an_quiz_leads (id)
  where sheet_synced_at is null;
create index if not exists an_quiz_leads_created_idx on public.an_quiz_leads (created_at desc, id desc);

alter table public.an_quiz_cities enable row level security;
alter table public.an_quiz_leads enable row level security;
revoke all on public.an_quiz_cities, public.an_quiz_leads from anon, authenticated;
grant all on public.an_quiz_cities, public.an_quiz_leads to service_role;

-- 2) Лендинг (без входа) ---------------------------------------------------------------

-- Их config.js: город по адресу лендинга, иначе — город по умолчанию (у них
-- Всеволожск), иначе — первый заведённый. Без таблицы и листа заявок.
create or replace function public.an_quiz_landing(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'slug', c.slug, 'city', c.city, 'trial_price', c.trial_price,
           'completed_count', c.completed_count, 'landing_version', c.landing_version,
           'locations', c.locations, 'operator_name', c.operator_name,
           'operator_inn', c.operator_inn)
    from public.an_quiz_cities c
   order by (c.slug = coalesce(p_slug, '')) desc, c.is_default desc, c.id
   limit 1
$$;
revoke all on function public.an_quiz_landing(text) from public;
grant execute on function public.an_quiz_landing(text) to anon, authenticated;

-- 3) Приём и отправка (сервер портала, service_role) ----------------------------------

-- Их create(): поля уже очищены сервером (их _clean), здесь — их проверки
-- ещё раз и запись.
create or replace function public.an_quiz_lead_add(p_city text, p_name text, p_phone text,
                                                   p_recommendation text, p_pain text,
                                                   p_duration text, p_barrier text,
                                                   p_utm jsonb, p_consent_at text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if coalesce(p_city, '') = '' or char_length(coalesce(p_name, '')) < 2
     or char_length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 10 then
    raise exception 'Проверьте имя и телефон.' using errcode = '22023';
  end if;
  if coalesce(p_consent_at, '') = '' then
    raise exception 'Нужно согласие на обработку данных.' using errcode = '22023';
  end if;
  insert into public.an_quiz_leads (city, name, phone, recommendation, pain, duration, barrier,
                                    utm, consent_at)
  values (p_city, p_name, p_phone, coalesce(p_recommendation, ''), coalesce(p_pain, ''),
          coalesce(p_duration, ''), coalesce(p_barrier, ''),
          case when jsonb_typeof(p_utm) = 'object' then p_utm else '{}'::jsonb end, p_consent_at)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.an_quiz_lead_add(text, text, text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.an_quiz_lead_add(text, text, text, text, text, text, text, jsonb, text)
  to service_role;

-- Их sync_pending: неотправленные заявки по порядку (не больше 500) и
-- таблица города (их CITY_SHEETS.get(city): точное совпадение города).
create or replace function public.an_quiz_pending(p_limit integer default 100)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'created_at', l.created_at, 'city', l.city, 'name', l.name,
           'phone', l.phone, 'recommendation', l.recommendation, 'pain', l.pain,
           'duration', l.duration, 'barrier', l.barrier, 'utm', l.utm,
           'consent_at', l.consent_at, 'spreadsheet_id', nullif(c.spreadsheet_id, ''),
           'sheet_name', c.sheet_name) order by l.id), '[]')
    from (select * from public.an_quiz_leads
           where sheet_synced_at is null
           order by id
           limit greatest(1, least(coalesce(p_limit, 100), 500))) l
    left join public.an_quiz_cities c on c.city = l.city
$$;
revoke all on function public.an_quiz_pending(integer) from public, anon, authenticated;
grant execute on function public.an_quiz_pending(integer) to service_role;

-- Итог отправки заявки: null — записана в таблицу, иначе — их sheet_error.
create or replace function public.an_quiz_mark(p_id bigint, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.an_quiz_leads
     set sheet_synced_at = case when p_error is null then now() else sheet_synced_at end,
         sheet_error = coalesce(left(p_error, 240), '')
   where id = p_id
$$;
revoke all on function public.an_quiz_mark(bigint, text) from public, anon, authenticated;
grant execute on function public.an_quiz_mark(bigint, text) to service_role;

-- 4) Города (администратору аналитики) ---------------------------------------------------

create or replace function public.an_quiz_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'slug', c.slug, 'city', c.city, 'trial_price', c.trial_price,
               'completed_count', c.completed_count, 'landing_version', c.landing_version,
               'locations', c.locations, 'operator_name', c.operator_name,
               'operator_inn', c.operator_inn, 'spreadsheet_id', c.spreadsheet_id,
               'sheet_name', c.sheet_name, 'is_default', c.is_default,
               'updated_at', c.updated_at,
               'leads', (select count(*) from public.an_quiz_leads l where l.city = c.city),
               'pending', (select count(*) from public.an_quiz_leads l
                            where l.city = c.city and l.sheet_synced_at is null))
             order by c.is_default desc, c.city collate "C", c.id)
        from public.an_quiz_cities c), '[]'),
    'total', (select count(*) from public.an_quiz_leads),
    'pending', (select count(*) from public.an_quiz_leads
                 where sheet_synced_at is null and sheet_error = ''),
    'errors', (select count(*) from public.an_quiz_leads
                where sheet_synced_at is null and sheet_error <> ''),
    'last_at', (select max(created_at) from public.an_quiz_leads));
end;
$$;
revoke all on function public.an_quiz_overview() from public, anon;
grant execute on function public.an_quiz_overview() to authenticated;

-- Город лендинга: проверки и тексты. p_id null — новый.
create or replace function public.an_quiz_city_save(p_id bigint, p_data jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text := lower(public.an_vk_strip(coalesce(p_data->>'slug', '')));
  v_city text := public.an_vk_strip(coalesce(p_data->>'city', ''));
  v_price text := public.an_vk_strip(coalesce(p_data->>'trial_price', ''));
  v_completed text := public.an_vk_strip(coalesce(p_data->>'completed_count', ''));
  v_version text := public.an_vk_strip(coalesce(p_data->>'landing_version', ''));
  v_operator text := public.an_vk_strip(coalesce(p_data->>'operator_name', ''));
  v_inn text := public.an_vk_strip(coalesce(p_data->>'operator_inn', ''));
  v_sheet_id text := public.an_vk_strip(coalesce(p_data->>'spreadsheet_id', ''));
  v_sheet text := public.an_vk_strip(coalesce(p_data->>'sheet_name', ''));
  v_default boolean := coalesce((p_data->>'is_default')::boolean, false);
  v_locations jsonb := '[]';
  v_loc jsonb;
  v_address text;
  v_id bigint;
begin
  perform public.an_require_admin();
  if v_slug !~ '^[a-z0-9][a-z0-9-]{0,59}$' then
    raise exception 'Адрес страницы — латинские буквы, цифры и дефис, до 60 знаков.'
      using errcode = '22023';
  end if;
  if v_city = '' then
    raise exception 'Укажите город.' using errcode = '22023';
  end if;
  if char_length(v_city) > 300 then
    raise exception 'Название города слишком длинное.' using errcode = '22023';
  end if;
  if v_price !~ '^[0-9]{1,7}$' or v_price::integer > 1000000 then
    raise exception 'Цена пробного — целое число рублей от нуля.' using errcode = '22023';
  end if;
  if char_length(v_completed) > 40 then
    raise exception '«Уже прошли» — не длиннее 40 знаков.' using errcode = '22023';
  end if;
  if char_length(v_version) > 80 then
    raise exception 'Версия лендинга — не длиннее 80 знаков.' using errcode = '22023';
  end if;
  if char_length(v_operator) > 300 then
    raise exception 'Название оператора слишком длинное.' using errcode = '22023';
  end if;
  if v_inn !~ '^([0-9]{10}|[0-9]{12})?$' then
    raise exception 'ИНН — 10 или 12 цифр.' using errcode = '22023';
  end if;
  -- Их spreadsheet_metadata: допустимые знаки ID таблицы.
  if v_sheet_id !~ '^[A-Za-z0-9_-]{0,200}$' then
    raise exception 'Некорректный ID Google Таблицы.' using errcode = '22023';
  end if;
  if v_sheet = '' then
    v_sheet := 'Заявки квиза';
  end if;
  if char_length(v_sheet) > 100 then
    raise exception 'Название листа слишком длинное.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_data->'locations') = 'array' then
    if jsonb_array_length(p_data->'locations') > 10 then
      raise exception 'Не больше 10 студий в городе.' using errcode = '22023';
    end if;
    for v_loc in select value from jsonb_array_elements(p_data->'locations') loop
      v_address := public.an_vk_strip(coalesce(v_loc->>'address', ''));
      if v_address = '' then
        raise exception 'Укажите адрес студии.' using errcode = '22023';
      end if;
      if char_length(v_address) > 300
         or char_length(public.an_vk_strip(coalesce(v_loc->>'landmark', ''))) > 300
         or char_length(public.an_vk_strip(coalesce(v_loc->>'phone_display', ''))) > 60
         or char_length(public.an_vk_strip(coalesce(v_loc->>'phone_href', ''))) > 80 then
        raise exception 'Адрес, ориентир или телефон студии слишком длинный.' using errcode = '22023';
      end if;
      v_locations := v_locations || jsonb_build_array(jsonb_build_object(
        'address', v_address,
        'landmark', public.an_vk_strip(coalesce(v_loc->>'landmark', '')),
        'phone_display', public.an_vk_strip(coalesce(v_loc->>'phone_display', '')),
        'phone_href', public.an_vk_strip(coalesce(v_loc->>'phone_href', ''))));
    end loop;
  end if;
  if exists (select 1 from public.an_quiz_cities
              where slug = v_slug and id is distinct from p_id) then
    raise exception 'Адрес страницы «%» уже занят.', v_slug using errcode = '23505';
  end if;
  if exists (select 1 from public.an_quiz_cities
              where city = v_city and id is distinct from p_id) then
    raise exception 'Город «%» уже есть.', v_city using errcode = '23505';
  end if;
  if v_default then
    update public.an_quiz_cities set is_default = false
     where is_default and id is distinct from p_id;
  end if;
  if p_id is null then
    insert into public.an_quiz_cities (slug, city, trial_price, completed_count, landing_version,
                                       locations, operator_name, operator_inn, spreadsheet_id,
                                       sheet_name, is_default)
    values (v_slug, v_city, v_price::integer, v_completed, v_version, v_locations, v_operator,
            v_inn, v_sheet_id, v_sheet, v_default)
    returning id into v_id;
  else
    update public.an_quiz_cities
       set slug = v_slug, city = v_city, trial_price = v_price::integer,
           completed_count = v_completed, landing_version = v_version, locations = v_locations,
           operator_name = v_operator, operator_inn = v_inn, spreadsheet_id = v_sheet_id,
           sheet_name = v_sheet, is_default = v_default, updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Город не найден.' using errcode = 'P0002';
    end if;
  end if;
  perform public.an_audit_add(auth.uid(), 'quiz_city_saved', v_slug || ':' || v_city);
  return v_id;
end;
$$;
revoke all on function public.an_quiz_city_save(bigint, jsonb) from public, anon;
grant execute on function public.an_quiz_city_save(bigint, jsonb) to authenticated;

create or replace function public.an_quiz_city_delete(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.an_quiz_cities;
begin
  perform public.an_require_admin();
  delete from public.an_quiz_cities where id = p_id returning * into v_row;
  if v_row.id is not null then
    perform public.an_audit_add(auth.uid(), 'quiz_city_deleted', v_row.slug || ':' || v_row.city);
  end if;
end;
$$;
revoke all on function public.an_quiz_city_delete(bigint) from public, anon;
grant execute on function public.an_quiz_city_delete(bigint) to authenticated;

-- 5) Заявки (администратору аналитики) ---------------------------------------------------

-- Заявки новыми сверху: город, состояние отправки (pending — ждут, error — с
-- ошибкой, sent — в таблице), страница.
create or replace function public.an_quiz_leads(p_city text, p_status text,
                                                p_limit integer default 50,
                                                p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_city text := nullif(coalesce(p_city, ''), '');
  v_status text := coalesce(p_status, '');
begin
  perform public.an_require_admin();
  return (
    with f as (
      select l.* from public.an_quiz_leads l
       where (v_city is null or l.city = v_city)
         and case v_status
               when 'pending' then l.sheet_synced_at is null and l.sheet_error = ''
               when 'error' then l.sheet_synced_at is null and l.sheet_error <> ''
               when 'sent' then l.sheet_synced_at is not null
               else true
             end)
    select jsonb_build_object(
             'total', (select count(*) from f),
             'cities', coalesce((
               select jsonb_agg(x.city order by x.city collate "C")
                 from (select distinct city from public.an_quiz_leads) x), '[]'),
             'rows', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', p.id, 'created_at', p.created_at, 'city', p.city, 'name', p.name,
                        'phone', p.phone, 'recommendation', p.recommendation, 'pain', p.pain,
                        'duration', p.duration, 'barrier', p.barrier, 'utm', p.utm,
                        'consent_at', p.consent_at, 'sheet_synced_at', p.sheet_synced_at,
                        'sheet_error', p.sheet_error)
                      order by p.created_at desc, p.id desc)
                 from (select * from f
                        order by created_at desc, id desc
                        limit least(greatest(coalesce(p_limit, 50), 1), 200)
                       offset greatest(coalesce(p_offset, 0), 0)) p), '[]')));
end;
$$;
revoke all on function public.an_quiz_leads(text, text, integer, integer) from public, anon;
grant execute on function public.an_quiz_leads(text, text, integer, integer) to authenticated;

-- Удалить заявку (тестовую или с городом без таблицы: у них такая заявка
-- останавливает отправку следующих).
create or replace function public.an_quiz_lead_delete(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_city text;
begin
  perform public.an_require_admin();
  delete from public.an_quiz_leads where id = p_id returning city into v_city;
  if v_city is not null then
    perform public.an_audit_add(auth.uid(), 'quiz_lead_deleted', p_id::text || ':' || v_city);
  end if;
end;
$$;
revoke all on function public.an_quiz_lead_delete(bigint) from public, anon;
grant execute on function public.an_quiz_lead_delete(bigint) to authenticated;
