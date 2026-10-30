-- ============================================================================
-- «Аналитика» → amoCRM, часть 2 (ANALYTICS.md, «amoCRM»; ANALYTICS_PLAN.md,
-- §8.3): отчёты «Маркетинг Lady Stretch» и «Маркетинг Lady Jump» — их
-- marketing_report_page (app.py) с report_filters, marketing_report,
-- marketing_snapshot и qualification_rule_labels (amocrm.py).
--
-- Когорта — месяц создания сделки (МСК); блоки «город × партнёр», строки —
-- рекламные каналы (источник сделки). «Результат на сегодня» — сделки
-- месяца как есть сейчас, «Результат на 1-е число» — их срез
-- (an_amo_snapshots, замораживает an_amo_freeze_snapshots — как у них, при
-- открытии отчёта). Бюджеты — расход VK бренда за месяц с НДС по городам
-- (an_amo_month_budgets); есть срез — бюджеты из среза (в обоих режимах,
-- как у них). Подписи, бюджеты каналов, конверсии и итоги считает браузер
-- (lib/analytics/amo/marketing.ts).
--
-- Доступ — права «Маркетинг Lady Stretch» / «Маркетинг Lady Jump» (an.mkt.ls
-- / an.mkt.lj; таргетологу — всегда): администратору аналитики и
-- сотруднику — все города; таргетологу — его города бренда
-- (an_vk_targetologists, ключ — ФИО); партнёру — только свои города
-- (an_partner_cities), без выбора партнёра. Бюджеты наружу — только городов
-- отчёта. Не администратору — «открыл дашборд» в журнале.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- Их COLLATE NOCASE: без регистра только латиница, остальное — по кодам.
create or replace function public.an_amo_nocase(p text)
returns text
language sql
immutable
as $$
  select translate(p, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
$$;
revoke all on function public.an_amo_nocase(text) from public, anon, authenticated;

create or replace function public.an_amo_marketing(p_brand text, p_month text, p_city text,
                                                   p_partner text, p_result text)
returns jsonb
language plpgsql
security definer
set search_path = public
set extra_float_digits = 1
as $$
declare
  v_me jsonb := public.an_me_for(auth.uid());
  v_need text := case p_brand when 'Lady Stretch' then 'mkt.ls' when 'Lady Jump' then 'mkt.lj' end;
  v_admin boolean;
  v_target text;
  v_is_target boolean;
  v_is_partner boolean;
  v_allowed text[];
  v_months text[] := '{}';
  v_cities text[] := '{}';
  v_partners text[] := '{}';
  v_month text;
  v_city text;
  v_city_c text;
  v_partner text;
  v_result text;
  v_snap public.an_amo_snapshots;
  v_start timestamp;
  v_rows jsonb;
  v_budgets jsonb;
  v_quals jsonb;
begin
  if v_need is null then
    raise exception 'an_bad_brand' using errcode = '22023';
  end if;
  if v_me is null or not (coalesce((v_me->>'admin')::boolean, false)
                          or coalesce(v_me->'reports', '[]') ? v_need) then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  v_admin := coalesce((v_me->>'admin')::boolean, false);
  v_target := v_me->>'targetologist';
  v_is_target := not v_admin and v_target is not null;
  v_is_partner := not v_admin and not v_is_target and jsonb_typeof(v_me->'partner_cities') = 'array';
  -- Их allowed_cities: null — все города.
  if v_is_target then
    v_allowed := array(select distinct t.city from public.an_vk_targetologists t
                        where t.brand = p_brand and t.targetologist_name = v_target);
  elsif v_is_partner then
    v_allowed := array(select jsonb_array_elements_text(v_me->'partner_cities'));
  end if;

  -- Их report_filters: месяцы когорт, города и партнёры сделок + из срезов
  -- (замороженное остаётся в выборе после смены ответственных).
  if v_allowed is null or cardinality(v_allowed) > 0 then
    with dims as (
      select to_char((l.created_at at time zone 'UTC') + interval '3 hours', 'YYYY-MM') as month,
             l.city, l.partner_name, l.city <> '' as city_ok, l.partner_name <> '' as partner_ok
        from public.an_amo_leads l
       where l.brand = p_brand and (v_allowed is null or l.city = any (v_allowed))
      union all
      select s.month, r->>'city', r->>'partner_name',
             r->>'city' <> 'Город не сопоставлен', r->>'partner_name' <> '—'
        from public.an_amo_snapshots s
       cross join jsonb_array_elements(s.rows) r
       where s.brand = p_brand and (v_allowed is null or r->>'city' = any (v_allowed))
    )
    select array(select x.v from (select distinct d.month as v from dims d) x order by x.v collate "C" desc),
           array(select x.v from (select distinct d.city as v from dims d where d.city_ok) x
                  order by x.v collate "C"),
           array(select x.v from (select distinct d.partner_name as v from dims d where d.partner_ok) x
                  order by x.v collate "C")
      into v_months, v_cities, v_partners;
  end if;

  v_month := p_month;
  if v_month is null or (cardinality(v_months) > 0 and not v_month = any (v_months)) then
    v_month := coalesce(v_months[1], to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM'));
  end if;
  if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Укажите месяц отчёта в формате ГГГГ-ММ.' using errcode = '22023';
  end if;
  v_city := case when p_city = any (v_cities) then p_city else '' end;
  v_partner := case when v_is_partner then ''
                    when p_partner = any (v_partners) then p_partner else '' end;
  v_result := case when p_result = 'first' then 'first' else 'today' end;
  v_city_c := public.an_amo_canonical_city(p_brand, v_city);
  v_start := (v_month || '-01')::timestamp;

  -- Их marketing_snapshot: сначала заморозить закончившиеся месяцы.
  perform public.an_amo_freeze_snapshots();
  select * into v_snap from public.an_amo_snapshots s where s.brand = p_brand and s.month = v_month;

  -- Их marketing_report.
  if v_result = 'first' then
    select coalesce(jsonb_agg(e.r order by e.i), '[]') into v_rows
      from jsonb_array_elements(coalesce(v_snap.rows, '[]')) with ordinality e(r, i)
     where (v_city_c = '' or e.r->>'city' = v_city_c)
       and (v_partner = '' or e.r->>'partner_name' = v_partner)
       and (v_allowed is null or e.r->>'city' = any (v_allowed));
  else
    with g as (
      select coalesce(nullif(l.city, ''), 'Город не сопоставлен') as city,
             coalesce(nullif(l.partner_name, ''), '—') as partner_name,
             coalesce(nullif(l.effective_source, ''), 'Не присвоен источник') as source,
             count(*) as leads, sum(l.is_qualified) as qualified,
             sum(case when l.is_qualified = 1 and l.is_booked = 1 then 1 else 0 end) as booked,
             sum(case when l.is_qualified = 1 and l.is_attended = 1 then 1 else 0 end) as attended,
             sum(case when l.is_qualified = 1 and l.is_paid = 1 then 1 else 0 end) as paid
        from public.an_amo_leads l
       where l.brand = p_brand
         and l.created_at >= v_start at time zone 'Europe/Moscow'
         and l.created_at < (v_start + interval '1 month') at time zone 'Europe/Moscow'
         and (v_city_c = '' or l.city = v_city_c)
         and (v_partner = '' or l.partner_name = v_partner)
         and (v_allowed is null or l.city = any (v_allowed))
       group by 1, 2, 3
    )
    select coalesce(jsonb_agg(to_jsonb(g) order by public.an_amo_nocase(g.city) collate "C",
                              public.an_amo_nocase(g.partner_name) collate "C", g.leads desc,
                              public.an_amo_nocase(g.source) collate "C", g.source collate "C"), '[]')
      into v_rows from g;
  end if;

  -- Бюджеты VK месяца по городам (есть срез — из среза); наружу — только
  -- города отчёта.
  v_budgets := coalesce(v_snap.budgets,
                        public.an_amo_month_budgets(p_brand, v_start::date,
                                                    (v_start + interval '1 month' - interval '1 day')::date));
  select coalesce(jsonb_object_agg(b.key, b.value), '{}') into v_budgets
    from jsonb_each(v_budgets) b
   where exists (select 1 from jsonb_array_elements(v_rows) r where r->>'city' = b.key);

  -- Их qualification_rule_labels: отмеченные «неквалифицированными»
  -- основания закрытия подключений, где ответственные — в этом городе.
  select coalesce(jsonb_object_agg(c.city, l.labels), '{}') into v_quals
    from (select distinct r->>'city' as city from jsonb_array_elements(v_rows) r) c
   cross join lateral (
     select coalesce(jsonb_agg(x.name order by public.an_amo_nocase(x.name) collate "C", x.name collate "C"), '[]') as labels
       from (select distinct q.field_value_name as name
               from public.an_amo_basis q
               join public.an_amo_connections cn on cn.id = q.connection_id
               join public.an_amo_pipeline_brands p on p.connection_id = q.connection_id
               join public.an_amo_responsibles rs on rs.connection_id = q.connection_id
              where p.brand = p_brand and rs.brand = p.brand and q.is_unqualified
                and rs.city = public.an_amo_canonical_city(p_brand, c.city)) x
   ) l;

  if not v_admin then
    perform public.an_audit_add(auth.uid(), 'dashboard_view', 'Маркетинг ' || p_brand);
  end if;

  return jsonb_build_object(
    'brand', p_brand,
    'months', to_jsonb(v_months),
    'cities', to_jsonb(v_cities),
    'partners', to_jsonb(v_partners),
    'month', v_month,
    'city', v_city,
    'partner', v_partner,
    'result', v_result,
    'is_partner', v_is_partner,
    'limited', v_is_partner or v_is_target,
    'snapshot', v_snap.brand is not null,
    'rows', v_rows,
    'budgets', v_budgets,
    'qualification', v_quals
  );
end;
$$;
revoke all on function public.an_amo_marketing(text, text, text, text, text) from public, anon;
grant execute on function public.an_amo_marketing(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
