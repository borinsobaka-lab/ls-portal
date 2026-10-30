-- ============================================================================
-- «Аналитика» → Авито (ANALYTICS.md, «Авито»; ANALYTICS_PLAN.md, §8.5):
-- кабинеты Авито Рекламы, структура «кампания → группа → креатив», дневная
-- статистика кампаний, планы и «Реестр Авито» — их avito_ads.py,
-- avito_ads_collector.py и страницы /admin/avito-ads/* (app.py), заявки — их
-- amocrm.avito_utm_leads / avito_source_leads.
--
-- Их accounts + credentials → an_avito_accounts (client_id и client_secret —
-- an_secrets kind 'avito', ref = id кабинета, шифрует сервер портала; итог
-- проверки — в кабинете), entities → an_avito_entities (без сырых ответов
-- API: id, родители, название, ссылка с UTM и дата старта кампании — то, что
-- читали их страницы и загрузка истории), daily_campaign_statistics →
-- an_avito_daily_stats, monthly_plans → an_avito_plans.
--
-- Пишет сервер портала (service_role): проверка, структура, статистика —
-- кнопками администратора и задачей «avito» раз в час (их
-- lady-avito-ads.timer: вчера по Москве, все кабинеты); только чтение API
-- Авито. Таблицы закрыты браузеру: администратору аналитики — RPC
-- an_avito_* (кабинеты, ключи, планы), реестр — право «Реестр Авито»
-- (an.avito.register; не администратору — «открыл дашборд» в журнале).
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы -------------------------------------------------------------------------

create table if not exists public.an_avito_accounts (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 200),
  avito_account_id text not null unique check (avito_account_id ~ '^[0-9]{1,200}$'),
  city text not null check (char_length(city) between 1 and 200),
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_check_status integer,
  -- Их last_check_summary: {"campaigns": {"total": N}, …} последней проверки.
  last_check_summary jsonb
);

create table if not exists public.an_avito_entities (
  account_id bigint not null references public.an_avito_accounts(id) on delete cascade,
  entity_type text not null check (entity_type in ('campaigns', 'groups', 'creatives')),
  entity_id text not null,
  parent_campaign_id text not null default '',
  parent_group_id text not null default '',
  name text not null default '',
  landing_url text not null default '',
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  utm_content text not null default '',
  -- Их _campaign_start: дата старта кампании из ответа API (для истории).
  start_date date,
  synced_at timestamptz not null,
  primary key (account_id, entity_type, entity_id)
);

create table if not exists public.an_avito_daily_stats (
  account_id bigint not null references public.an_avito_accounts(id) on delete cascade,
  campaign_id text not null,
  stat_date date not null,
  shows bigint not null default 0,
  clicks bigint not null default 0,
  spent float8 not null default 0,
  primary key (account_id, campaign_id, stat_date)
);

create table if not exists public.an_avito_plans (
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  city text not null check (char_length(city) between 1 and 200),
  applications_plan integer not null check (applications_plan >= 0),
  target_cpl float8 not null check (target_cpl > 0 and target_cpl < 'Infinity'::float8),
  updated_at timestamptz not null default now(),
  primary key (month, brand, city)
);

alter table public.an_avito_accounts enable row level security;
alter table public.an_avito_entities enable row level security;
alter table public.an_avito_daily_stats enable row level security;
alter table public.an_avito_plans enable row level security;
revoke all on public.an_avito_accounts, public.an_avito_entities, public.an_avito_daily_stats,
  public.an_avito_plans from anon, authenticated;
grant all on public.an_avito_accounts, public.an_avito_entities, public.an_avito_daily_stats,
  public.an_avito_plans to service_role;

-- 2) Правила их кода ----------------------------------------------------------------

-- Их _clean: пробелы по краям, обязательность и длина, их тексты
-- (label.capitalize(): «Id аккаунта», «Client_id»).
create or replace function public.an_avito_clean(p text, p_label text, p_max integer default 200)
returns text
language plpgsql
immutable
as $$
declare
  v text := public.an_vk_strip(p);
begin
  if v = '' then
    raise exception 'Укажите %.', p_label using errcode = '22023';
  end if;
  if char_length(v) > p_max then
    raise exception '% слишком длинный.', upper(left(p_label, 1)) || lower(substr(p_label, 2))
      using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Ключ от сервера портала: '' — не введён, 'long' — длиннее 200 знаков (их
-- _clean проверяет открытый текст), иначе шифртекст base64(iv ‖ данные ‖ тег).
create or replace function public.an_avito_check_cipher(p_cipher text, p_label text)
returns text
language plpgsql
immutable
as $$
begin
  if coalesce(p_cipher, '') = '' then
    raise exception 'Укажите %.', p_label using errcode = '22023';
  end if;
  if p_cipher = 'long' then
    raise exception '% слишком длинный.', upper(left(p_label, 1)) || lower(substr(p_label, 2))
      using errcode = '22023';
  end if;
  -- Шифртекст пустого ключа — 28 байт (38 знаков base64 и «==»).
  if p_cipher !~ '^[A-Za-z0-9+/]{38,}={0,2}$' then
    raise exception 'Ключ не зашифрован — сохраните его через портал.' using errcode = '22023';
  end if;
  return p_cipher;
end;
$$;

create or replace function public.an_avito_store_keys(p_account bigint, p_client_id text, p_client_secret text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.an_secrets (kind, ref, name, ciphertext, updated_at, updated_by)
  values ('avito', p_account::text, 'client_id', p_client_id, now(), auth.uid()),
         ('avito', p_account::text, 'client_secret', p_client_secret, now(), auth.uid())
  on conflict (kind, ref, name) do update
    set ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by
$$;
revoke all on function public.an_avito_store_keys(bigint, text, text) from public, anon, authenticated;

-- 3) Кабинеты (администратору аналитики) ----------------------------------------------

-- Их avito_ads_page: кабинеты (бренд, город без регистра латиницы) и итог
-- последней проверки.
create or replace function public.an_avito_accounts()
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
             'id', a.id, 'name', a.name, 'avito_account_id', a.avito_account_id, 'city', a.city,
             'brand', a.brand, 'last_checked_at', a.last_checked_at,
             'last_check_status', a.last_check_status, 'last_check_summary', a.last_check_summary,
             'campaigns', (select count(*) from public.an_avito_entities e
                            where e.account_id = a.id and e.entity_type = 'campaigns'),
             'stats_to', (select max(s.stat_date) from public.an_avito_daily_stats s where s.account_id = a.id))
           order by a.brand, public.an_amo_nocase(a.city) collate "C", a.id)
      from public.an_avito_accounts a), '[]');
end;
$$;
revoke all on function public.an_avito_accounts() from public, anon;
grant execute on function public.an_avito_accounts() to authenticated;

-- Их save_account: тот же ID аккаунта — обновляются название, город,
-- направление и ключи (кабинет и история остаются).
create or replace function public.an_avito_account_save(
  p_name text, p_avito_account_id text, p_city text, p_brand text,
  p_client_id_cipher text, p_client_secret_cipher text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_city text := public.an_amo_canonical_city(p_brand, p_city);
  v_name text;
  v_avito text;
  v_id bigint;
begin
  perform public.an_require_admin();
  v_name := public.an_avito_clean(p_name, 'название кабинета');
  v_avito := public.an_avito_clean(p_avito_account_id, 'ID аккаунта');
  if v_avito !~ '^[0-9]+$' then
    raise exception 'ID аккаунта Авито должен состоять только из цифр.' using errcode = '22023';
  end if;
  v_city := public.an_avito_clean(v_city, 'город');
  if coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Направление указано некорректно.' using errcode = '22023';
  end if;
  perform public.an_avito_check_cipher(p_client_id_cipher, 'client_id');
  perform public.an_avito_check_cipher(p_client_secret_cipher, 'client_secret');
  select id into v_id from public.an_avito_accounts where avito_account_id = v_avito for update;
  if v_id is not null then
    update public.an_avito_accounts
       set name = v_name, city = v_city, brand = p_brand, updated_at = now()
     where id = v_id;
  else
    insert into public.an_avito_accounts (name, avito_account_id, city, brand)
    values (v_name, v_avito, v_city, p_brand)
    returning id into v_id;
  end if;
  perform public.an_avito_store_keys(v_id, p_client_id_cipher, p_client_secret_cipher);
  perform public.an_audit_add(auth.uid(), 'avito_ads_account_saved', v_id::text);
  return v_id;
end;
$$;
revoke all on function public.an_avito_account_save(text, text, text, text, text, text) from public, anon;
grant execute on function public.an_avito_account_save(text, text, text, text, text, text) to authenticated;

-- Их update_credentials: новые ключи, проверка сбрасывается, история остаётся.
create or replace function public.an_avito_set_credentials(
  p_id bigint, p_client_id_cipher text, p_client_secret_cipher text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  perform public.an_avito_check_cipher(p_client_id_cipher, 'client_id');
  perform public.an_avito_check_cipher(p_client_secret_cipher, 'client_secret');
  update public.an_avito_accounts
     set updated_at = now(), last_checked_at = null, last_check_status = null, last_check_summary = null
   where id = p_id;
  if not found then
    raise exception 'Кабинет Авито не найден.' using errcode = 'P0002';
  end if;
  perform public.an_avito_store_keys(p_id, p_client_id_cipher, p_client_secret_cipher);
  perform public.an_audit_add(auth.uid(), 'avito_ads_credentials_updated', p_id::text);
end;
$$;
revoke all on function public.an_avito_set_credentials(bigint, text, text) from public, anon;
grant execute on function public.an_avito_set_credentials(bigint, text, text) to authenticated;

-- Их delete_account: подключение, ключи и собранное — только в портале.
create or replace function public.an_avito_account_delete(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  delete from public.an_avito_accounts where id = p_id;
  if not found then
    raise exception 'Подключение уже удалено или не найдено.' using errcode = 'P0002';
  end if;
  delete from public.an_secrets where kind = 'avito' and ref = p_id::text;
  perform public.an_audit_add(auth.uid(), 'avito_ads_account_deleted', p_id::text);
end;
$$;
revoke all on function public.an_avito_account_delete(bigint) from public, anon;
grant execute on function public.an_avito_account_delete(bigint) to authenticated;

-- 4) Сбор (сервер портала) --------------------------------------------------------------

-- Их finally в check_account: итог проверки пишется всегда.
create or replace function public.an_avito_check_store(p_id bigint, p_status integer, p_summary jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.an_avito_accounts
     set last_checked_at = now(), last_check_status = p_status, last_check_summary = p_summary
   where id = p_id
$$;
revoke all on function public.an_avito_check_store(bigint, integer, jsonb) from public, anon, authenticated;
grant execute on function public.an_avito_check_store(bigint, integer, jsonb) to service_role;

-- Их sync_structure: кампании, группы, креативы одной транзакцией (у них —
-- одним соединением SQLite: ошибка любого вида — ничего не записано).
-- Удалённые в Авито сущности не стираются (как у них).
create or replace function public.an_avito_structure_store(p_id bigint, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.an_avito_entities (account_id, entity_type, entity_id, parent_campaign_id, parent_group_id,
                                        name, landing_url, utm_source, utm_medium, utm_campaign, utm_content,
                                        start_date, synced_at)
  select p_id, x->>'entity_type', x->>'entity_id', coalesce(x->>'parent_campaign_id', ''),
         coalesce(x->>'parent_group_id', ''), coalesce(x->>'name', ''), coalesce(x->>'landing_url', ''),
         coalesce(x->>'utm_source', ''), coalesce(x->>'utm_medium', ''), coalesce(x->>'utm_campaign', ''),
         coalesce(x->>'utm_content', ''), nullif(x->>'start_date', '')::date, now()
    from jsonb_array_elements(coalesce(p_items, '[]')) x
  on conflict (account_id, entity_type, entity_id) do update
    set parent_campaign_id = excluded.parent_campaign_id, parent_group_id = excluded.parent_group_id,
        name = excluded.name, landing_url = excluded.landing_url, utm_source = excluded.utm_source,
        utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign,
        utm_content = excluded.utm_content, start_date = excluded.start_date, synced_at = excluded.synced_at;
end;
$$;
revoke all on function public.an_avito_structure_store(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.an_avito_structure_store(bigint, jsonb) to service_role;

-- Их sync_campaign_statistics: строки дня кампании (повтор дня — замена).
create or replace function public.an_avito_stats_store(p_id bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
set extra_float_digits = 1
as $$
declare
  v_n integer;
begin
  insert into public.an_avito_daily_stats (account_id, campaign_id, stat_date, shows, clicks, spent)
  select p_id, x->>'campaign_id', (x->>'stat_date')::date, (x->>'shows')::bigint, (x->>'clicks')::bigint,
         (x->>'spent')::float8
    from jsonb_array_elements(coalesce(p_rows, '[]')) x
  on conflict (account_id, campaign_id, stat_date) do update
    set shows = excluded.shows, clicks = excluded.clicks, spent = excluded.spent;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.an_avito_stats_store(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.an_avito_stats_store(bigint, jsonb) to service_role;

-- 5) Планы (администратору аналитики) ----------------------------------------------------

-- Их avito_plans_page: города подключённых кабинетов (без регистра латиницы,
-- затем направление) и планы месяца.
create or replace function public.an_avito_plans(p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set extra_float_digits = 1
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('brand', c.brand, 'city', c.city)
                       order by public.an_amo_nocase(c.city) collate "C", c.brand collate "C")
        from (select distinct brand, city from public.an_avito_accounts) c), '[]'),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object('brand', p.brand, 'city', p.city,
                                          'applications_plan', p.applications_plan,
                                          'target_cpl', p.target_cpl, 'updated_at', p.updated_at))
        from public.an_avito_plans p where p.month = p_month), '[]'));
end;
$$;
revoke all on function public.an_avito_plans(text) from public, anon;
grant execute on function public.an_avito_plans(text) to authenticated;

-- Их save_monthly_plan: проверки и тексты; план одного месяца не меняет
-- другие. Целые заявки и CPL разбирает браузер (их int() / float()).
create or replace function public.an_avito_plan_save(p_month text, p_brand text, p_city text,
                                                     p_applications integer, p_target_cpl float8)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_city text := public.an_amo_canonical_city(p_brand, p_city);
begin
  perform public.an_require_admin();
  if coalesce(p_month, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Укажите месяц в формате ГГГГ-ММ.' using errcode = '22023';
  end if;
  if coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Направление указано некорректно.' using errcode = '22023';
  end if;
  v_city := public.an_avito_clean(v_city, 'город');
  if p_applications is null or p_applications < 0 then
    raise exception 'План заявок должен быть целым числом от нуля.' using errcode = '22023';
  end if;
  if p_target_cpl is null or not (p_target_cpl > 0) or p_target_cpl = 'NaN'::float8
     or p_target_cpl = 'Infinity'::float8 then
    raise exception 'Целевой CPL должен быть больше нуля.' using errcode = '22023';
  end if;
  insert into public.an_avito_plans (month, brand, city, applications_plan, target_cpl, updated_at)
  values (p_month, p_brand, v_city, p_applications, p_target_cpl, now())
  on conflict (month, brand, city) do update
    set applications_plan = excluded.applications_plan, target_cpl = excluded.target_cpl,
        updated_at = excluded.updated_at;
  perform public.an_audit_add(auth.uid(), 'avito_ads_plan_saved', p_month || ':' || p_brand || ':' || p_city);
end;
$$;
revoke all on function public.an_avito_plan_save(text, text, text, integer, float8) from public, anon;
grant execute on function public.an_avito_plan_save(text, text, text, integer, float8) to authenticated;

-- 6) «Реестр Авито» --------------------------------------------------------------------

-- Их avito_register_page: период (неверный — с 1-го числа по сегодня, МСК),
-- register_rows (кампании кабинетов и их расход, клики, показы за период),
-- avito_utm_leads (сделки amoCRM с utm_source = avito_ads или источником
-- «Авито Реклама» по дате создания, границы — UTC), avito_source_leads
-- (UTM сделок города), планы месяцев периода и структура кабинетов (группы
-- и креативы с UTM). Расчёты страницы — в браузере (lib/analytics/avito/).
create or replace function public.an_avito_register(p_from text, p_to text)
returns jsonb
language plpgsql
security definer
set search_path = public
set extra_float_digits = 1
as $$
declare
  v_me jsonb := public.an_me_for(auth.uid());
  v_admin boolean;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_from date;
  v_to date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_me is null or not (coalesce((v_me->>'admin')::boolean, false)
                          or coalesce(v_me->'reports', '[]') ? 'avito.register') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  v_admin := coalesce((v_me->>'admin')::boolean, false);
  begin
    if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad';
    end if;
    v_from := p_from::date;
    v_to := p_to::date;
    if v_to < v_from then
      raise exception 'bad';
    end if;
  exception when others then
    v_to := v_today;
    v_from := date_trunc('month', v_today)::date;
  end;
  v_start := v_from::timestamp at time zone 'UTC';
  v_end := (v_to::timestamp + interval '23 hours 59 minutes 59 seconds') at time zone 'UTC';

  if not v_admin then
    perform public.an_audit_add(auth.uid(), 'dashboard_view', 'Реестр Авито');
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'brand', a.brand, 'city', a.city)
                       order by a.brand, public.an_amo_nocase(a.city) collate "C", a.id)
        from public.an_avito_accounts a), '[]'),
    -- Их register_rows: кампании кабинетов (без кампаний — кабинета нет).
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', r.account_id, 'brand', r.brand, 'city', r.city, 'campaign_id', r.campaign_id,
               'campaign_name', r.campaign_name, 'shows', r.shows, 'clicks', r.clicks, 'spent', r.spent)
             order by r.brand collate "C", r.city collate "C", r.campaign_name collate "C", r.account_id,
                      r.campaign_id collate "C")
        from (select a.id as account_id, a.brand, a.city, e.entity_id as campaign_id, e.name as campaign_name,
                     coalesce(sum(s.shows), 0) as shows, coalesce(sum(s.clicks), 0) as clicks,
                     coalesce(sum(s.spent order by s.stat_date), 0) as spent
                from public.an_avito_accounts a
                join public.an_avito_entities e on e.account_id = a.id and e.entity_type = 'campaigns'
                left join public.an_avito_daily_stats s
                  on s.account_id = a.id and s.campaign_id = e.entity_id and s.stat_date between v_from and v_to
               group by a.id, e.entity_id, e.name) r), '[]'),
    -- Их hierarchy: группы и креативы кабинетов (порядок — вид, затем название).
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', e.account_id, 'entity_type', e.entity_type, 'entity_id', e.entity_id,
               'parent_campaign_id', e.parent_campaign_id, 'parent_group_id', e.parent_group_id,
               'name', e.name, 'utm_medium', e.utm_medium, 'utm_campaign', e.utm_campaign,
               'utm_content', e.utm_content)
             order by e.account_id, case e.entity_type when 'campaigns' then 1 when 'groups' then 2 else 3 end,
                      e.name collate "C", e.entity_id collate "C")
        from public.an_avito_entities e where e.entity_type <> 'campaigns'), '[]'),
    -- Их avito_utm_leads.
    'leads', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.brand collate "C", public.an_amo_nocase(g.city) collate "C",
                       g.utm_medium collate "C", g.utm_campaign collate "C", g.utm_content collate "C",
                       g.attribution)
        from (select l.brand, l.city, l.utm_medium, l.utm_campaign, l.utm_content,
                     case when public.an_amo_nocase(l.utm_source) = 'avito_ads' then 'utm' else 'source' end
                       as attribution,
                     count(*) as leads, sum(l.is_qualified) as qualified, sum(l.is_booked) as booked,
                     sum(l.is_attended) as attended, sum(l.is_paid) as paid
                from public.an_amo_leads l
               where (public.an_amo_nocase(l.utm_source) = 'avito_ads' or l.effective_source = 'Авито Реклама')
                 and l.created_at >= v_start and l.created_at <= v_end
               group by 1, 2, 3, 4, 5, 6) g), '[]'),
    -- Их avito_source_leads: UTM сделок городов кабинетов.
    'source_leads', coalesce((
      select jsonb_agg(jsonb_build_object('brand', l.brand, 'city', l.city, 'amo_lead_id', l.amo_lead_id,
                                          'utm_source', l.utm_source, 'utm_medium', l.utm_medium,
                                          'utm_campaign', l.utm_campaign, 'utm_content', l.utm_content)
                       order by l.created_at, l.amo_lead_id collate "C")
        from public.an_amo_leads l
       where (public.an_amo_nocase(l.utm_source) = 'avito_ads' or l.effective_source = 'Авито Реклама')
         and l.created_at >= v_start and l.created_at <= v_end
         and exists (select 1 from public.an_avito_accounts a where a.brand = l.brand and a.city = l.city)), '[]'),
    -- Их monthly_plans_for_months: планы месяцев периода.
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object('month', p.month, 'brand', p.brand, 'city', p.city,
                                          'applications_plan', p.applications_plan, 'target_cpl', p.target_cpl)
                       order by p.month, public.an_amo_nocase(p.city) collate "C", p.brand collate "C")
        from public.an_avito_plans p
       where p.month >= to_char(v_from, 'YYYY-MM') and p.month <= to_char(v_to, 'YYYY-MM')), '[]'));
end;
$$;
revoke all on function public.an_avito_register(text, text) from public, anon;
grant execute on function public.an_avito_register(text, text) to authenticated;

notify pgrst, 'reload schema';
