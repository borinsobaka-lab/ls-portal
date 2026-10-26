-- ============================================================
-- Stage 2 для блока «Моя статистика»: MET, снапшоты калорий
-- на посещении, materialized view для бенчмарка.
-- Запускать ПОСЛЕ db/workouts.sql, db/bookings.sql,
-- db/bookings_log.sql, db/bookings_statuses_v2.sql,
-- db/member_profiles.sql. Идемпотентно.
-- ============================================================

-- ------------------------------------------------------------
-- 1. MET-коэффициент в шаблонах тренировок
-- ------------------------------------------------------------
alter table public.workouts
  add column if not exists met_value numeric(4,2);

alter table public.workouts
  drop constraint if exists workouts_met_value_positive;
alter table public.workouts
  add constraint workouts_met_value_positive
  check (met_value is null or met_value > 0);

-- Дефолты по типу (Compendium of Physical Activities, ТЗ Этап 2)
update public.workouts set met_value = case type
  when 'cardio'   then 8.5
  when 'strength' then 7.0
  when 'hybrid'   then 8.0
  when 'recovery' then 2.8
  else 6.0
end
where met_value is null;

comment on column public.workouts.met_value is
  'MET-коэффициент интенсивности. Используется для оценки калорий: ккал = MET * 3.5 * вес_кг / 200 * мин.';

-- ------------------------------------------------------------
-- 2. Снапшот калорий в истории записей (bookings_log)
-- ------------------------------------------------------------
alter table public.bookings_log
  add column if not exists met_value       numeric(4,2),
  add column if not exists weight_at_time  numeric(5,1),
  add column if not exists duration_min    int,
  add column if not exists calories        int;

comment on column public.bookings_log.met_value      is 'MET тренировки на момент посещения (snapshot).';
comment on column public.bookings_log.weight_at_time is 'Вес клиента (кг) на момент посещения (snapshot).';
comment on column public.bookings_log.duration_min   is 'Фактическая длительность занятия в минутах (snapshot).';
comment on column public.bookings_log.calories       is 'Оценка калорий по формуле MET (snapshot, не пересчитывается).';

-- ------------------------------------------------------------
-- 3. Функция расчёта калорий и проставления snapshot
--    Вызывается из mark_booking_attended при переходе в 'attended'.
-- ------------------------------------------------------------
create or replace function public.bookings_log_fill_calories(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log         public.bookings_log%rowtype;
  v_met         numeric;
  v_weight      numeric;
  v_duration    int;
  v_calories    int;
begin
  select * into v_log from public.bookings_log where booking_id = p_booking_id;
  if not found then return; end if;

  -- MET с тренировки (или дефолт по типу)
  select coalesce(w.met_value,
    case w.type
      when 'cardio'   then 8.5
      when 'strength' then 7.0
      when 'hybrid'   then 8.0
      when 'recovery' then 2.8
      else 6.0
    end)
    into v_met
  from public.workouts w
  where w.id = v_log.workout_id;

  -- Вес из профиля клиента
  select weight_kg into v_weight
  from public.member_profiles
  where user_id = v_log.user_id;

  -- Длительность из снимка занятия
  v_duration := greatest(1,
    coalesce(extract(epoch from (v_log.ends_at - v_log.starts_at))::int / 60, 60));

  if v_weight is not null and v_met is not null then
    v_calories := round((v_met * 3.5 * v_weight / 200.0) * v_duration);
  end if;

  update public.bookings_log
     set met_value      = v_met,
         weight_at_time = v_weight,
         duration_min   = v_duration,
         calories       = v_calories,
         updated_at     = now()
   where booking_id = p_booking_id;
end;
$$;

revoke all on function public.bookings_log_fill_calories(uuid) from public;
grant execute on function public.bookings_log_fill_calories(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Обновляем mark_booking_attended — после смены статуса
--    дозаполняем snapshot калорий.
-- ------------------------------------------------------------
create or replace function public.mark_booking_attended(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.schedule_bookings%rowtype;
begin
  select * into v_booking
  from public.schedule_bookings
  where id = p_booking_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not public.is_trainer(auth.uid(), v_booking.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if v_booking.status not in ('booked','no_show','attended') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_status');
  end if;

  update public.schedule_bookings
     set status = 'attended'
   where id = p_booking_id;

  update public.bookings_log
     set status = 'attended',
         completed_at = coalesce(completed_at, now()),
         updated_at = now()
   where booking_id = p_booking_id;

  -- Снапшот калорий
  perform public.bookings_log_fill_calories(p_booking_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.mark_booking_attended(uuid) from public;
grant execute on function public.mark_booking_attended(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Бэкап: проставить snapshot для уже зафиксированных
--    посещений (status = attended, calories пусто).
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select booking_id from public.bookings_log
     where status = 'attended' and calories is null and booking_id is not null
  loop
    perform public.bookings_log_fill_calories(r.booking_id);
  end loop;
end$$;

-- ------------------------------------------------------------
-- 6. Materialized view с агрегатами по клиентам за 30 дней —
--    для перцентильных бенчмарков (CUME_DIST).
--    Обновлять по cron раз в сутки:
--      select public.refresh_client_stats_30d();
-- ------------------------------------------------------------
drop materialized view if exists public.client_stats_30d_mv;
create materialized view public.client_stats_30d_mv as
with base as (
  select
    bl.studio_id,
    bl.user_id,
    count(*)::int                            as visits_30d,
    coalesce(sum(bl.calories), 0)::int       as calories_30d
  from public.bookings_log bl
  where bl.status = 'attended'
    and bl.starts_at >= now() - interval '30 days'
  group by bl.studio_id, bl.user_id
)
select
  studio_id,
  user_id,
  visits_30d,
  calories_30d,
  cume_dist() over (partition by studio_id order by visits_30d)   as visits_percentile,
  cume_dist() over (partition by studio_id order by calories_30d) as calories_percentile,
  count(*)   over (partition by studio_id)                        as cohort_size
from base;

create unique index if not exists client_stats_30d_mv_pk
  on public.client_stats_30d_mv(studio_id, user_id);

grant select on public.client_stats_30d_mv to authenticated;

create or replace function public.refresh_client_stats_30d()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently public.client_stats_30d_mv;
exception when others then
  refresh materialized view public.client_stats_30d_mv;
end;
$$;

revoke all on function public.refresh_client_stats_30d() from public;
grant execute on function public.refresh_client_stats_30d() to authenticated, service_role;

-- Первичное наполнение
select public.refresh_client_stats_30d();

notify pgrst, 'reload schema';
