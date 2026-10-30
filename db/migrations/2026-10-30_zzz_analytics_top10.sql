-- «Аналитика» → «Инструменты» → «Топ-10 городов» (2026-10-30, ANALYTICS.md):
-- их partner-rankings (analyze.py + build.mjs) — по месяцам и городским
-- группам из данных отчётов (слот current): воронка пробных (месяц — по дате
-- пробного: записались, пришли, база и покупки в день и за 14 дней) и
-- продажи абонементов (месяц — по дате покупки: все, новые, прежние
-- продления и из них «возвращённые» — v7 свода продаж, его считает
-- обработка 1С, process.ts returnedSales). Рейтинги и Excel собирает
-- браузер (lib/analytics/top10.ts). Только администратору аналитики.
-- Сведения о снимке для страницы: дата сводов, охват продаж и воронки, есть
-- ли в снимке «возвращённые» (снимок до 2026-10-30 их не считал — нужна
-- новая обработка 1С).
create or replace function public.an_onec_top10_info(p_meta jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'generated_at', p_meta->>'generated_at',
    'sales_min', p_meta->'coverage'->'sales'->>'min',
    'sales_max', p_meta->'coverage'->'sales'->>'max',
    'funnel_min', p_meta->'coverage'->'funnel'->>'min',
    'funnel_max', p_meta->'coverage'->'funnel'->>'max',
    'returned_ready', coalesce((p_meta->'coverage'->'sales'->'totals'->>6)::double precision, 0) > 0)
$$;
revoke all on function public.an_onec_top10_info(jsonb) from public, anon, authenticated;

create or replace function public.an_onec_top10(p_months text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_slot smallint;
  v_months text[];
  v_from date;
  v_to date;
  v_meta jsonb;
  v_rows jsonb;
begin
  perform public.an_require_admin();
  v_slot := public.an_onec_slot('current');
  if v_slot is null then
    raise exception 'an_onec_empty' using errcode = 'P0002';
  end if;
  select array_agg(distinct m order by m) into v_months
    from unnest(coalesce(p_months, '{}'::text[])) m
   where m ~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
  if v_months is null or cardinality(v_months) > 12
     or cardinality(v_months) <> cardinality(p_months) then
    raise exception 'Выберите от 1 до 12 месяцев' using errcode = '22023';
  end if;
  v_from := (v_months[1] || '-01')::date;
  v_to := ((v_months[cardinality(v_months)] || '-01')::date + interval '1 month')::date;
  select s.meta into v_meta from public.an_onec_snapshots s where s.slot = v_slot;

  with it as materialized (
    select i.id, i.report, i.city
      from public.an_onec_items i
     where i.slot = v_slot and i.report in ('sales', 'funnel')
  ), f as (
    select it.report, it.city, to_char(f.day, 'YYYY-MM') as month,
           f.v1, f.v2, f.v3, f.v4, f.v5, f.v6, f.v7
      from it
      join public.an_onec_facts f on f.slot = v_slot and f.item_id = it.id
     where f.day >= v_from and f.day < v_to
  ), g as (
    select month, city,
           coalesce(sum(v1) filter (where report = 'funnel'), 0) as booked,
           coalesce(sum(v2) filter (where report = 'funnel'), 0) as attended,
           coalesce(sum(v3) filter (where report = 'funnel'), 0) as day_base,
           coalesce(sum(v4) filter (where report = 'funnel'), 0) as bought_day,
           coalesce(sum(v5) filter (where report = 'funnel'), 0) as window_base,
           coalesce(sum(v6) filter (where report = 'funnel'), 0) as bought_14,
           coalesce(sum(v1) filter (where report = 'sales'), 0) as sales,
           coalesce(sum(v2) filter (where report = 'sales'), 0) as new,
           coalesce(sum(v3) filter (where report = 'sales'), 0) as repeat_old,
           coalesce(sum(v7) filter (where report = 'sales'), 0) as returned
      from f
     where month = any (v_months)
     group by month, city
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', month, 'city', city,
           'booked', booked, 'attended', attended, 'day_base', day_base,
           'bought_day', bought_day, 'window_base', window_base, 'bought_14', bought_14,
           'sales', sales, 'new', new, 'repeat_old', repeat_old, 'returned', returned)
           order by month, city collate "C"), '[]'::jsonb)
    into v_rows
    from g;

  return public.an_onec_top10_info(v_meta) || jsonb_build_object('rows', v_rows);
end;
$$;
revoke all on function public.an_onec_top10(text[]) from public, anon;
grant execute on function public.an_onec_top10(text[]) to authenticated, service_role;

-- Какие месяцы есть в данных отчётов: охват продаж и воронки (без строк).
create or replace function public.an_onec_top10_range()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
begin
  perform public.an_require_admin();
  select s.meta into v_meta from public.an_onec_snapshots s where s.state = 'current';
  if v_meta is null then
    return null;
  end if;
  return public.an_onec_top10_info(v_meta);
end;
$$;
revoke all on function public.an_onec_top10_range() from public, anon;
grant execute on function public.an_onec_top10_range() to authenticated, service_role;
