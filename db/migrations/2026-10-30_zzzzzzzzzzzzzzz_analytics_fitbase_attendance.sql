-- ============================================================================
-- «Аналитика» → FitBase, часть 3 (ANALYTICS.md, «FitBase»): данные отчёта
-- «Занятия и посещаемость» — их attendance_report (fitbase_runtime.py).
-- Записей много (у них ~250 тыс.), поэтому база сама считает их множества:
-- проведённые занятия, записи и посещения (по ID записи, без людей) по
-- группам «итог / город / студия / направление» для текущего периода и тех же
-- дней месяц и год назад, и признак неизвестного кода записи в группе.
-- Покрытие, средние, доходимость и вид страницы — lib/analytics/fitbase/attendance.ts.
--
-- Право — отчёт «Занятия и посещаемость» из an_me (fb.attendance), вся сеть,
-- как у них (fitbase_staff_reports.py). Таблицы по-прежнему закрыты браузеру.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- Их attendance_effective_rules: коды FitBase + сохранённые соответствия
-- (только известные статусы).
create or replace function public.an_fb_effective_rules(p_saved jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select '{"0": "registered", "1": "confirmed", "2": "refused", "3": "visited", "4": "no_show",
           "5": "late_cancel", "7": "waiting", "8": "pending_payment"}'::jsonb
         || coalesce((select jsonb_object_agg(e.key, e.value)
                        from jsonb_each(case when jsonb_typeof(p_saved) = 'object' then p_saved else '{}' end) e
                       where e.value #>> '{}' in ('registered', 'confirmed', 'visited', 'no_show', 'late_cancel',
                                                  'refused', 'waiting', 'pending_payment')
                         and jsonb_typeof(e.value) = 'string'), '{}');
$$;
revoke all on function public.an_fb_effective_rules(jsonb) from public, anon, authenticated;

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
  v_now bigint := extract(epoch from now())::bigint;
  v_valid text[] := array['registered', 'confirmed', 'visited', 'no_show', 'late_cancel',
                          'refused', 'waiting', 'pending_payment'];
  v_booked text[] := array['registered', 'confirmed', 'visited', 'no_show', 'late_cancel'];
  v_city text := coalesce(p_city, '');
  v_studio text := coalesce(p_studio, '');
  v_training text := coalesce(p_training, '');
  v_status text := coalesce(p_status, '');
  v_selected bigint[];
  v_result jsonb;
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

  -- Их owners: одна студия на пару «домен + клуб» — с самой свежей загрузкой занятий.
  select array_agg(s.id) into v_selected
    from (select distinct on (c.domain, c.club_id) c.id
            from public.an_fb_connections c
           where c.club_id <> '' and (v_city = '' or c.city = v_city)
             and (v_studio = '' or c.id::text = v_studio)
             and (v_status = '' or c.studio_status = v_status)
           order by c.domain, c.club_id, coalesce(c.attendance_synced_at, 0) desc, c.id desc) s;
  v_selected := coalesce(v_selected, '{}');

  with views(v, lo, hi) as (
    values ('current', v_from, v_to),
           ('month', (v_from - interval '1 month')::date, (v_to - interval '1 month')::date),
           ('year', (v_from - interval '1 year')::date, (v_to - interval '1 year')::date)
  ), sel as (
    select c.id, c.city, public.an_fb_effective_rules(c.attendance_rules) as rules
      from public.an_fb_connections c where c.id = any (v_selected)
  ), facts as (
    select w.v, c.city, c.id as uid, e.training_name, e.event_id, r.registration_id, r.status as raw,
           case when r.registration_id is null then null else c.rules ->> r.status end as st
      from public.an_fb_events e
      join sel c on c.id = e.connection_id
      join views w on e.day >= w.lo::text and e.day <= w.hi::text
      left join public.an_fb_records r on r.connection_id = e.connection_id and r.event_id = e.event_id
     where not e.cancelled and e.end_at <= v_now
       and (v_training = '' or e.training_name = v_training)
  ), grouped as (
    select v, city, uid, training_name,
           grouping(city) as g_city, grouping(uid) as g_uid, grouping(training_name) as g_training,
           count(distinct uid::text || ':' || event_id) as lessons,
           count(distinct uid::text || ':' || registration_id) filter (where st = any (v_booked)) as registered,
           count(distinct uid::text || ':' || registration_id) filter (where st = 'visited') as visited,
           coalesce(bool_or(registration_id is not null and not coalesce(st = any (v_valid), false)), false) as problems
      from facts
     group by grouping sets ((v), (v, city), (v, city, uid), (v, city, uid, training_name))
  )
  select jsonb_build_object(
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
    'selected', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
               'brand', c.brand, 'studio_status', c.studio_status,
               'attendance_synced_at', c.attendance_synced_at, 'attendance_from', c.attendance_from,
               'attendance_to', c.attendance_to, 'attendance_state', c.attendance_state,
               'sync_state', c.sync_state, 'busy', public.an_fb_busy(c.sync_state, c.job_started_at))
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c where c.id = any (v_selected)),
    'trainings', (
      select coalesce(jsonb_agg(distinct e.training_name), '[]')
        from public.an_fb_events e where e.connection_id = any (v_selected)),
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
       where f.v = 'current' and f.registration_id is not null and not coalesce(f.st = any (v_valid), false))
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.an_fb_attendance_data(text, text, text, text, text, text) from public, anon;
grant execute on function public.an_fb_attendance_data(text, text, text, text, text, text) to authenticated;
