-- ============================================================================
-- «Аналитика» → отчёты 1С (ANALYTICS_PLAN.md §8.1): чтение снимка «Обработки
-- 1С» (2026-10-30_analytics_onec.sql) для шести их досок — «Выручка»,
-- «Продажи абонементов», «Занятия», «Воронка пробных», «Нулевая
-- номенклатура», «Мой город». Как их /1c (analytics_api.py, full_reports.py):
--
--   * an_onec_scope — их onec_scope: администратор — вся сеть; партнёр (есть
--     города партнёра или право «Партнёр») — только «Мой город» и только
--     свои города (без городов — ничего); остальным — доска, выданная в
--     правах, а «Мой город» — только при всех четырёх (выручка, продажи,
--     занятия, воронка) и самом «Мой город»;
--   * an_onec_aggregate — их aggregate(): суммы v1…v8 по текущему снимку за
--     период, разрезы detail / studio / monthly / daily / monthly_detail,
--     фильтр студии «Моего города» (их partner_payload: студия должна быть в
--     выбранном городе), не больше 150 000 строк;
--   * an_onec_report_meta — их base_meta и опции досок: дата обработки,
--     покрытие отчёта, точка 0, контроль нулевых продаж, студии городов.
--
-- Расчёт самих досок (их full_reports.py) — в браузере,
-- lib/analytics/onec-reports/. Идемпотентно.
-- ============================================================================

-- Отчёты снимка, которые читает доска.
create or replace function public.an_onec_board_reports(p_board text)
returns text[]
language sql
immutable
as $$
  select case p_board
    when 'revenue' then array['revenue']
    when 'sales' then array['sales']
    when 'activities' then array['activities']
    when 'funnel' then array['funnel']
    when 'zero' then array['zero']
    when 'partner' then array['revenue', 'sales', 'activities', 'funnel', 'trial_products']
  end
$$;

-- Их onec_scope: города, которыми ограничен человек (null — вся сеть), или
-- an_forbidden.
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

-- Их aggregate(): строки [ключ, город, студия, статус, направление, код, v1…v8].
-- Ключ — месяц «ГГГГ-ММ» (monthly, monthly_detail), день «ГГГГ-ММ-ДД»
-- (daily), иначе null; направления и кода нет в разрезах studio / monthly /
-- daily.
create or replace function public.an_onec_aggregate(
  p_board text, p_report text, p_start date, p_end date, p_grain text,
  p_studio text default '', p_city text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_custom_plan
set work_mem = '32MB'
-- JIT по завышенной оценке стоимости компилировал запрос дольше, чем тот
-- выполнялся (~0,4 с на вызов).
set jit = off
as $$
declare
  v_cities text[] := public.an_onec_scope(p_board);
  v_slot smallint := public.an_onec_slot('current');
  v_studio text := coalesce(p_studio, '');
  v_rows jsonb;
begin
  if v_slot is null then
    raise exception 'an_onec_empty' using errcode = 'P0002';
  end if;
  if not (p_report = any (public.an_onec_board_reports(p_board))) then
    raise exception 'an_onec_bad_report' using errcode = '22023';
  end if;
  if p_grain is null or p_grain not in ('detail', 'studio', 'monthly', 'daily', 'monthly_detail') then
    raise exception 'an_onec_bad_grain' using errcode = '22023';
  end if;
  if p_start is null or p_end is null then
    raise exception 'Неверная дата' using errcode = '22023';
  end if;
  if p_start > p_end then
    raise exception 'Начало периода позже конца' using errcode = '22023';
  end if;
  if v_studio <> '' then
    -- Фильтр студии — только «Мой город»: студия выбранного города из
    -- доступных человеку.
    if p_board <> 'partner' or not exists (
      select 1 from public.an_onec_items
       where slot = v_slot and city = coalesce(p_city, '') and studio = v_studio
         and (v_cities is null or city = any (v_cities))) then
      raise exception 'Выбранная студия недоступна в этом городе' using errcode = '22023';
    end if;
    v_cities := array[p_city];
  end if;

  -- Сначала позиции отчёта (тысячи строк), затем их факты по ключу
  -- (slot, item_id, day): так планировщик не читает все факты периода.
  with it as materialized (
    select i.id, i.city, i.studio, i.status, i.dimension, i.code
      from public.an_onec_items i
     where i.slot = v_slot and i.report = p_report
       and (v_cities is null or i.city = any (v_cities))
       and (v_studio = '' or i.studio = v_studio)
  ), f as (
    select it.city, it.studio, it.status, it.dimension, it.code, f.day,
           f.v1, f.v2, f.v3, f.v4, f.v5, f.v6, f.v7, f.v8
      from it
      join public.an_onec_facts f on f.slot = v_slot and f.item_id = it.id
     where f.day between p_start and p_end
  ), g as materialized (
    select case p_grain
             when 'monthly' then to_char(day, 'YYYY-MM')
             when 'monthly_detail' then to_char(day, 'YYYY-MM')
             when 'daily' then to_char(day, 'YYYY-MM-DD')
           end as k,
           city, studio, status,
           case when p_grain in ('detail', 'monthly_detail') then dimension end as dimension,
           case when p_grain in ('detail', 'monthly_detail') then code end as code,
           sum(v1) as v1, sum(v2) as v2, sum(v3) as v3, sum(v4) as v4,
           sum(v5) as v5, sum(v6) as v6, sum(v7) as v7, sum(v8) as v8
      from f
     group by 1, 2, 3, 4, 5, 6
  )
  -- Порядок — как GROUP BY их SQLite (по байтам строк). Группировка —
  -- отдельным шагом (materialized): иначе ORDER BY агрегата просит
  -- отсортированный вход до группировки и планировщик сортирует все факты
  -- периода (Postgres 16).
  select coalesce(jsonb_agg(jsonb_build_array(k, city, studio, status, dimension, code,
           v1, v2, v3, v4, v5, v6, v7, v8)
           order by k collate "C", city collate "C", studio collate "C", status collate "C",
                    dimension collate "C", code collate "C"), '[]')
    into v_rows
    from g;
  if jsonb_array_length(v_rows) > 150000 then
    raise exception 'Слишком большой разрез отчёта' using errcode = '54000';
  end if;
  return v_rows;
end;
$$;
revoke all on function public.an_onec_aggregate(text, text, date, date, text, text, text) from public, anon;
grant execute on function public.an_onec_aggregate(text, text, date, date, text, text, text) to authenticated, service_role;

-- Их base_meta и опции досок. null — снимка ещё нет («Загрузите пакет
-- обработчика»). Контрольные суммы не отдаются (их public_meta).
create or replace function public.an_onec_report_meta(p_board text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cities text[] := public.an_onec_scope(p_board);
  v_snap public.an_onec_snapshots;
  v_report text := case when p_board = 'partner' then 'revenue' else p_board end;
  v_be jsonb;
  v_options jsonb;
begin
  select * into v_snap from public.an_onec_snapshots where state = 'current';
  if v_snap.id is null then
    return null;
  end if;
  if p_board in ('revenue', 'partner') then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}') into v_be
      from jsonb_each(coalesce(v_snap.meta->'breakEven', '{}')) e
     where v_cities is null or e.key = any (v_cities);
  end if;
  if p_board = 'partner' then
    -- Их studioOptions: студии каждого города по всем отчётам снимка.
    select coalesce(jsonb_object_agg(city, studios), '{}') into v_options
      from (select city, jsonb_agg(studio order by studio) as studios
              from (select distinct city, studio from public.an_onec_items
                     where slot = v_snap.slot and studio <> ''
                       and (v_cities is null or city = any (v_cities))) d
             group by city) c;
  end if;
  return jsonb_build_object(
    'generated_at', v_snap.meta->'generated_at',
    'coverage', jsonb_build_object(
      'min', v_snap.meta->'coverage'->v_report->'min',
      'max', v_snap.meta->'coverage'->v_report->'max'),
    'breakEven', v_be,
    'zeroControls', case when p_board = 'zero' then coalesce(v_snap.meta->'zeroControls', '{}') end,
    'studioOptions', v_options
  );
end;
$$;
revoke all on function public.an_onec_report_meta(text) from public, anon;
grant execute on function public.an_onec_report_meta(text) to authenticated, service_role;
