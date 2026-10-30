-- ============================================================================
-- «Аналитика» → FitBase, часть 2 (ANALYTICS.md, «FitBase»): данные сетевых
-- отчётов «Выручка по городам», «Продажи абонементов», «Маркетинговый отчёт»
-- — их revenue_report / sales_report / report (fitbase_runtime.py) считает
-- страница портала (lib/analytics/fitbase/reports.ts), база отдаёт факты
-- студий одним ответом.
--
-- Право — их отчёт («дашборд») из an_me: администратор аналитики — всё,
-- остальным — выданное (fb.revenue / fb.sales / fb.marketing); у них такой
-- отчёт — вся сеть, только просмотр (fitbase_staff_reports.py). Таблицы
-- по-прежнему закрыты браузеру.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Право на отчёт FitBase (внутренняя).
create or replace function public.an_fb_report_allowed(p_report text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me jsonb := public.an_me_for(auth.uid());
begin
  return v_me is not null and (coalesce((v_me->>'admin')::boolean, false)
                               or coalesce(v_me->'reports', '[]') ? p_report);
end;
$$;
revoke all on function public.an_fb_report_allowed(text) from public, anon, authenticated;

-- Подключения для отчётов — их connections() (ORDER BY brand, city, name;
-- SQLite сравнивает байты — collate "C"), без ключей, правил и справочников.
create or replace function public.an_fb_report_connections()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'brand', c.brand, 'city', c.city,
           'domain', c.domain, 'club_id', c.club_id, 'studio_status', c.studio_status,
           'marketing_disabled', c.marketing_disabled, 'partner_name', c.partner_name,
           'synced_at', c.synced_at, 'sales_payments_at', c.sales_payments_at,
           'sales_state', c.sales_state, 'revenue_synced_at', c.revenue_synced_at,
           'revenue_from', c.revenue_from, 'revenue_to', c.revenue_to,
           'revenue_state', c.revenue_state)
         order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
    from public.an_fb_connections c;
$$;
revoke all on function public.an_fb_report_connections() from public, anon, authenticated;

-- 2) «Выручка по городам»: выручка студий по дням (Самара) за период.
create or replace function public.an_fb_revenue_data(p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from date;
  v_to date;
begin
  if not public.an_fb_report_allowed('fb.revenue') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  begin
    if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad';
    end if;
    v_from := p_from::date;
    v_to := p_to::date;
    if v_to < v_from or v_to - v_from > 2300 then
      raise exception 'bad';
    end if;
  exception when others then
    raise exception 'Проверьте фильтры и период выручки.' using errcode = '22023';
  end;
  return jsonb_build_object(
    'admin', public.an_is_admin(auth.uid()),
    'connections', public.an_fb_report_connections(),
    'daily', (select coalesce(jsonb_agg(jsonb_build_array(d.connection_id, d.day, d.amount_cents)), '[]')
                from public.an_fb_revenue_daily d
                join public.an_fb_connections c on c.id = d.connection_id and c.club_id <> ''
               where d.day >= p_from and d.day <= p_to));
end;
$$;
revoke all on function public.an_fb_revenue_data(text, text) from public, anon;
grant execute on function public.an_fb_revenue_data(text, text) to authenticated;

-- 3) «Продажи абонементов»: продажи, история и операции оплат студий с клубом
-- (новая продажа — первая платная покупка клиента за всю историю).
create or replace function public.an_fb_sales_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.an_fb_report_allowed('fb.sales') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'connections', public.an_fb_report_connections(),
    'sales', (select coalesce(jsonb_agg(jsonb_build_array(s.connection_id, s.contract_id, s.client_id,
                                                          s.purchased_at, s.price_cents, s.paid_cents)), '[]')
                from public.an_fb_sales s
                join public.an_fb_connections c on c.id = s.connection_id and c.club_id <> ''),
    'history', (select coalesce(jsonb_agg(jsonb_build_array(h.connection_id, h.contract_id, h.client_id,
                                                            h.purchased_at, h.price_cents)), '[]')
                  from public.an_fb_history h
                  join public.an_fb_connections c on c.id = h.connection_id and c.club_id <> ''),
    'payments', (select coalesce(jsonb_agg(jsonb_build_array(p.connection_id, p.operation, p.step_id,
                                                             p.contract_id, p.client_id, p.pay_at, p.day,
                                                             p.amount_cents)), '[]')
                   from public.an_fb_payments p
                   join public.an_fb_connections c on c.id = p.connection_id and c.club_id <> ''));
end;
$$;
revoke all on function public.an_fb_sales_data() from public, anon;
grant execute on function public.an_fb_sales_data() to authenticated;

-- 4) «Маркетинговый отчёт»: лиды студий направления за период (МСК), правила
-- и источники студий, бюджеты VK городов (их target_register_rows).
create or replace function public.an_fb_marketing_data(p_brand text, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set extra_float_digits = 1
as $$
declare
  v_brand text := p_brand;
  v_from date;
  v_to date;
  v_lo bigint;
  v_hi bigint;
begin
  if not public.an_fb_report_allowed('fb.marketing') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  -- Их направление по умолчанию — первой студии с отчётом (ORDER BY brand).
  if v_brand is null or v_brand = '' then
    select c.brand into v_brand from public.an_fb_connections c
     where not c.marketing_disabled
     order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id limit 1;
  end if;
  if v_brand is null or v_brand not in ('Lady Stretch', 'Lady Jump') then
    v_brand := 'Lady Stretch';
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
    raise exception 'Выберите корректный период: начало не позже конца, не больше 366 дней.' using errcode = '22023';
  end;
  v_lo := extract(epoch from v_from::timestamp at time zone 'Europe/Moscow')::bigint;
  v_hi := extract(epoch from (v_to + 1)::timestamp at time zone 'Europe/Moscow')::bigint;
  return jsonb_build_object(
    'brand', v_brand,
    'from', v_from,
    'to', v_to,
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'brand', c.brand, 'city', c.city,
               'domain', c.domain, 'club_id', c.club_id, 'partner_name', c.partner_name,
               'synced_at', c.synced_at, 'step_rules', c.step_rules, 'source_rules', c.source_rules,
               'sources', coalesce((select jsonb_agg(jsonb_build_object('id', s->'id', 'name', s->'name'))
                                      from jsonb_array_elements(case when jsonb_typeof(c.metadata->'sources') = 'array'
                                                                     then c.metadata->'sources' else '[]' end) s), '[]'))
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c
       where not c.marketing_disabled),
    'leads', (
      select coalesce(jsonb_agg(jsonb_build_array(l.connection_id, l.lead_id, l.client_key, l.created_at,
                                                  l.step_id, l.source_id)
                                order by l.created_at, l.lead_id collate "C"), '[]')
        from public.an_fb_leads l
        join public.an_fb_connections c on c.id = l.connection_id
       where c.brand = v_brand and not c.marketing_disabled
         and l.created_at >= v_lo and l.created_at < v_hi),
    'budgets', (
      select coalesce(jsonb_agg(jsonb_build_array(r.city, r.platform_spent, r.lead_form_spent)), '[]')
        from public.an_vk_register_base(v_from, v_to) r
       where r.brand = v_brand));
end;
$$;
revoke all on function public.an_fb_marketing_data(text, text, text) from public, anon;
grant execute on function public.an_fb_marketing_data(text, text, text) to authenticated;
