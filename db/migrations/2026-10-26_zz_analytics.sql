-- ============================================================================
-- «Аналитика» — отчёты сети по клубам (решение владельца 2026-10-26: вместо
-- отдельного портала аналитики Lady Stretch analytics.lady-stretching.ru;
-- что было у них, что вошло и что дальше — ANALYTICS.md).
--
-- Отчёты: выручка (города → клубы, недели месяца, прогноз, история, точка
-- 0), продажи абонементов (новые / продления / возвраты, средний чек,
-- динамика, номенклатуры), занятия и доходимость, воронка пробных (день
-- пробного / 14 дней), нулевая номенклатура, рейтинг клубов, «Мой город».
--
-- Источник — наша база (продажи, платежи, возвраты, расписание, записи).
-- База отдаёт только агрегаты (без клиентов, телефонов, имён) — RPC
-- analytics_* (security definer) по клубам, где у вызывающего открыт раздел
-- клуба «Аналитика»; сложение по городам, неделям, сравнения и проценты
-- считает админка (apps/admin/src/lib/analytics/, + тест).
--
-- Права:
--   * club.analytics — раздел клуба «Аналитика» (каталог прав «Пользователей
--     и ролей»): в каких клубах человек видит отчёты. Партнёр («Владелец
--     клуба», все разделы) — свои клубы, куратор — закреплённые, УК — все.
--   * analytics.manage — сетевое право «Аналитика: точка 0 и статус клубов».
--
-- Даты — по Тбилиси (как во всей базе). Идемпотентно.
-- ============================================================================

-- 1) Права ----------------------------------------------------------------------
insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('club.analytics', 'club', 'Аналитика',
   'Отчёты сети по клубу: выручка и прогноз, продажи, занятия, пробные, рейтинг (раздел «Аналитика»).',
   'studio', '{on}', null, 29),
  ('analytics.manage', 'sections', 'Аналитика: точка 0 и статус клубов',
   'Задаёт точку 0 (месячную цель выручки) и дату закрытия клуба для отчётов.',
   'network', '{on}', null, 130)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

-- Куратор клубов смотрит показатели закреплённых клубов — ему и отчёты.
insert into public.access_role_permissions (role_id, perm_key, level)
select r.id, 'club.analytics', 'on'
  from public.access_roles r
 where r.system_key = 'curator'
   and not exists (select 1 from public.access_role_permissions p
                    where p.role_id = r.id and p.perm_key = 'club.analytics');

-- Клубы, где вызывающий видит аналитику: роль сотрудника в клубе и открытый
-- раздел analytics (владельцу клуба — всегда; нет строки разделов — все).
-- Массивом, как auth_staff_studio_ids (2026-10-16_zz_rls_initplan_perf.sql).
create or replace function public.auth_analytics_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (select coalesce(array_agg(distinct ur.studio_id), '{}'::uuid[])
            from public.user_roles ur
           where ur.user_id = auth.uid()
             and ur.role in ('owner', 'admin', 'trainer')
             and (ur.role = 'owner'
                  or not exists (select 1 from public.admin_studio_permissions p
                                  where p.user_id = ur.user_id and p.studio_id = ur.studio_id)
                  or exists (select 1 from public.admin_studio_permissions p
                              where p.user_id = ur.user_id and p.studio_id = ur.studio_id
                                and 'analytics' = any (p.sections))));
end;
$$;
revoke all on function public.auth_analytics_studio_ids() from public;
grant execute on function public.auth_analytics_studio_ids() to authenticated, service_role;

-- Запрошенные клубы ∩ доступные (null — все доступные). Внутренняя.
create or replace function public.analytics_ids(p_studio_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(x), '{}'::uuid[])
    from unnest(public.auth_analytics_studio_ids()) x
   where p_studio_ids is null or x = any (p_studio_ids)
$$;
revoke all on function public.analytics_ids(uuid[]) from public, anon, authenticated;

-- Может ли вызывающий менять настройки аналитики клуба: сетевое право
-- analytics.manage; у человека вне модели прав (тесты, старые учётные
-- записи) — владелец этого клуба.
create or replace function public.analytics_can_manage(_user_id uuid, _studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.access_user_rights where user_id = _user_id)
      then public.access_has_right(_user_id, 'analytics.manage')
    else _studio_id is null
         and exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
      or exists (select 1 from public.user_roles
                  where user_id = _user_id and studio_id = _studio_id and role = 'owner')
  end
$$;
revoke all on function public.analytics_can_manage(uuid, uuid) from public, anon;
grant execute on function public.analytics_can_manage(uuid, uuid) to authenticated, service_role;

-- 2) Настройки клуба для отчётов ------------------------------------------------
-- Точка 0 — месячная выручка, при которой клуб выходит в ноль (у Lady
-- Stretch — цель города в «Мой город»; город — сумма своих клубов).
-- closed_on — клуб закрыт с этого дня (фильтр «Открытые / Закрытые»).
create table if not exists public.analytics_studio_settings (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  point_zero numeric(14, 2) check (point_zero is null or point_zero >= 0),
  closed_on date,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.analytics_studio_settings enable row level security;
revoke all on public.analytics_studio_settings from anon, authenticated;
grant select on public.analytics_studio_settings to authenticated;
grant all on public.analytics_studio_settings to service_role;
drop policy if exists "analytics settings read" on public.analytics_studio_settings;
create policy "analytics settings read" on public.analytics_studio_settings
  for select to authenticated
  using (studio_id = any ((select public.auth_analytics_studio_ids())::uuid[]));

create or replace function public.analytics_settings_save(
  p_studio_id uuid, p_point_zero numeric, p_closed_on date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.analytics_can_manage(auth.uid(), p_studio_id) then
    raise exception 'Нет права менять настройки аналитики этого клуба' using errcode = '42501';
  end if;
  if not exists (select 1 from public.studios where id = p_studio_id) then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  if p_point_zero is not null and p_point_zero < 0 then
    raise exception 'Точка 0 не может быть отрицательной' using errcode = '22023';
  end if;
  insert into public.analytics_studio_settings (studio_id, point_zero, closed_on, updated_at, updated_by)
  values (p_studio_id, p_point_zero, p_closed_on, now(), auth.uid())
  on conflict (studio_id) do update
    set point_zero = excluded.point_zero, closed_on = excluded.closed_on,
        updated_at = now(), updated_by = auth.uid();
end;
$$;
revoke all on function public.analytics_settings_save(uuid, numeric, date) from public, anon;
grant execute on function public.analytics_settings_save(uuid, numeric, date) to authenticated;

-- 3) Клубы отчётов --------------------------------------------------------------
-- Клубы, где вызывающий видит аналитику, с городом, брендом, форматом и
-- настройками; can_manage — может ли он менять настройки (хоть где-то).
create or replace function public.analytics_scope()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'today', (now() at time zone 'Asia/Tbilisi')::date,
    'can_manage', public.analytics_can_manage(auth.uid(), null)
                  or exists (select 1 from unnest(public.auth_analytics_studio_ids()) x
                              where public.analytics_can_manage(auth.uid(), x)),
    'studios', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'city', s.city, 'format', s.format,
               'ownership', s.ownership, 'brand_id', s.brand_id, 'brand_name', b.name,
               'brand_color', b.color,
               'point_zero', st.point_zero, 'closed_on', st.closed_on,
               'can_manage', public.analytics_can_manage(auth.uid(), s.id))
             order by s.city nulls last, s.name)
        from public.studios s
        left join public.org_brands b on b.id = s.brand_id
        left join public.analytics_studio_settings st on st.studio_id = s.id
       where s.id = any (public.auth_analytics_studio_ids())), '[]'::jsonb)
  )
$$;
revoke all on function public.analytics_scope() from public, anon;
grant execute on function public.analytics_scope() to authenticated;

-- Корзина даты: день или первое число месяца.
create or replace function public.analytics_bucket(d date, p_bucket text)
returns date
language sql
immutable
as $$
  select case when p_bucket = 'month' then date_trunc('month', d)::date else d end
$$;

-- 4) Выручка --------------------------------------------------------------------
-- Поступившие деньги — как «Фактическая выручка» дашборда и зарплаты:
-- продажа абонемента без графика — вся сумма в день продажи, с графиком —
-- каждый внесённый платёж в день внесения; прочие продажи — в день продажи;
-- возвраты вычитаются в день возврата. Строка: [клуб, дата, абонементы,
-- прочие, возвраты].
create or replace function public.analytics_revenue(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.analytics_ids(p_studio_ids) as a),
  pay as (
    select s.studio_id, s.sold_at as d, s.total_amount as m, 0::numeric as o, 0::numeric as r
      from public.sales s, ids
     where s.studio_id = any (ids.a) and s.sold_at between p_from and p_to
       and not exists (select 1 from public.sale_installments i where i.sale_id = s.id)
    union all
    select s.studio_id, coalesce(i.paid_at, i.due_date), i.amount, 0, 0
      from public.sale_installments i
      join public.sales s on s.id = i.sale_id, ids
     where s.studio_id = any (ids.a) and i.paid
       and coalesce(i.paid_at, i.due_date) between p_from and p_to
    union all
    select o.studio_id, o.sold_at, 0, o.total_amount, 0
      from public.other_sales o, ids
     where o.studio_id = any (ids.a) and o.sold_at between p_from and p_to
    union all
    select r.studio_id, (r.refunded_at at time zone 'Asia/Tbilisi')::date, 0, 0, r.amount
      from public.refunds r, ids
     where r.studio_id = any (ids.a)
       and (r.refunded_at at time zone 'Asia/Tbilisi')::date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, d, m, o, r) order by d, studio_id), '[]'::jsonb)
    from (select studio_id, public.analytics_bucket(d, p_bucket) as d,
                 sum(m) as m, sum(o) as o, sum(r) as r
            from pay group by 1, 2) t
$$;
revoke all on function public.analytics_revenue(uuid[], date, date, text) from public, anon;
grant execute on function public.analytics_revenue(uuid[], date, date, text) to authenticated;

-- 5) Продажи абонементов --------------------------------------------------------
-- Вид продажи по истории клиента — как classifySales дашборда
-- (lib/dashboard-analytics.ts): до продажи абонементов не было — new;
-- прежний ещё действовал или закончился не раньше чем за 14 дней — renewal;
-- перерыв дольше — return. Пробные (trial) и разовые (single) — свои виды
-- и историей не считаются; пакет персональных — своя история. Внутренняя.
create or replace function public.analytics_sale_origins(p_ids uuid[])
returns table (sale_id uuid, studio_id uuid, sold_at date, membership_id uuid,
               total_amount numeric, origin text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.studio_id, s.sold_at, s.membership_id, s.total_amount,
         case
           when m.kind = 'single' then 'single'
           when m.kind = 'trial' then 'trial'
           when h.n = 0 then 'new'
           when h.open_end or h.last_end >= s.sold_at - 14 then 'renewal'
           else 'return'
         end
    from public.sales s
    left join public.memberships m on m.id = s.membership_id
    cross join lateral (
      select count(*) as n,
             coalesce(bool_or(cm.ends_at is null and cm.status not in ('cancelled', 'refunded')), false)
               as open_end,
             max(cm.ends_at) as last_end
        from public.sales p
        left join public.memberships pm on pm.id = p.membership_id
        join public.client_memberships cm on cm.sale_id = p.id
       where p.client_id = s.client_id and p.id <> s.id
         and coalesce(pm.kind, 'package') not in ('trial', 'single')
         and (coalesce(pm.kind, '') = 'personal') = (coalesce(m.kind, '') = 'personal')
         and (p.sold_at < s.sold_at or (p.sold_at = s.sold_at and p.created_at < s.created_at))
    ) h
   where s.studio_id = any (p_ids)
$$;
revoke all on function public.analytics_sale_origins(uuid[]) from public, anon, authenticated;

-- Продажи за период:
--   sold     — [клуб, дата, номенклатура, вид, продано, сумма продаж (номинал)]
--              по дате продажи;
--   paid     — [клуб, дата, вид, поступило, возвращено] по дате денег
--              (платежи и возвраты продаж абонементов, вид — их продажи);
--   paid_total — [клуб, вид, поступило, возвращено, оплаченных продаж] за
--              весь период: средний чек = (поступило − возвращено) /
--              оплаченных продаж (продаж с поступлением в периоде), как у
--              Lady Stretch;
--   names    — {номенклатура: [название, kind]}.
create or replace function public.analytics_sales(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.analytics_ids(p_studio_ids) as a),
  o as (select * from public.analytics_sale_origins((select a from ids))),
  money as (
    select o.studio_id, o.sale_id, o.origin, o.sold_at as d, o.total_amount as inc, 0::numeric as ref
      from o
     where o.sold_at between p_from and p_to
       and not exists (select 1 from public.sale_installments i where i.sale_id = o.sale_id)
    union all
    select o.studio_id, o.sale_id, o.origin, coalesce(i.paid_at, i.due_date), i.amount, 0
      from public.sale_installments i join o on o.sale_id = i.sale_id
     where i.paid and coalesce(i.paid_at, i.due_date) between p_from and p_to
    union all
    select o.studio_id, o.sale_id, o.origin, (r.refunded_at at time zone 'Asia/Tbilisi')::date, 0, r.amount
      from public.refunds r join o on o.sale_id = r.sale_id
     where (r.refunded_at at time zone 'Asia/Tbilisi')::date between p_from and p_to
  )
  select jsonb_build_object(
    'sold', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, d, membership_id, origin, n, amount) order by d)
        from (select studio_id, public.analytics_bucket(sold_at, p_bucket) as d, membership_id, origin,
                     count(*) as n, sum(total_amount) as amount
                from o where sold_at between p_from and p_to
               group by 1, 2, 3, 4) t), '[]'::jsonb),
    'paid', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, d, origin, inc, ref) order by d)
        from (select studio_id, public.analytics_bucket(d, p_bucket) as d, origin,
                     sum(inc) as inc, sum(ref) as ref
                from money group by 1, 2, 3) t), '[]'::jsonb),
    'paid_total', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, origin, inc, ref, n))
        from (select studio_id, origin, sum(inc) as inc, sum(ref) as ref,
                     count(distinct sale_id) filter (where inc > 0) as n
                from money group by 1, 2) t), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(m.id, jsonb_build_array(m.name, m.kind))
        from public.memberships m
       where m.id in (select membership_id from o where sold_at between p_from and p_to)), '{}'::jsonb)
  )
$$;
revoke all on function public.analytics_sales(uuid[], date, date, text) from public, anon;
grant execute on function public.analytics_sales(uuid[], date, date, text) to authenticated;

-- 6) Занятия и посещаемость -----------------------------------------------------
-- Занятия, которые уже начались и не отменены клубом (как «Занятия»
-- дашборда): групповые — по тренировкам, персональные — одной строкой.
-- Записались — «Записан» + «Посетил» + «Не пришёл»; пришли — «Посетил».
-- Строка: [клуб, дата, тренировка|null, вид, занятий, записались, пришли,
-- не пришли, мест (у занятий с лимитом), пришли на занятия с лимитом].
create or replace function public.analytics_classes(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.analytics_ids(p_studio_ids) as a),
  e as (
    select e.id, e.studio_id, e.workout_id, e.kind, e.capacity,
           (e.starts_at at time zone 'Asia/Tbilisi')::date as d,
           count(b.id) filter (where b.status in ('booked', 'attended', 'no_show')) as booked,
           count(b.id) filter (where b.status = 'attended') as attended,
           count(b.id) filter (where b.status = 'no_show') as no_show
      from public.schedule_entries e
      left join public.schedule_bookings b on b.entry_id = e.id, ids
     where e.studio_id = any (ids.a)
       and e.kind in ('group', 'personal')
       and e.cancelled_at is null
       and e.starts_at <= now()
       and e.starts_at >= (p_from::timestamp at time zone 'Asia/Tbilisi')
       and e.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Tbilisi')
     group by e.id
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, d, workout_id, kind, n, booked, attended, no_show,
                                         cap, cap_attended) order by d)
        from (select studio_id, public.analytics_bucket(d, p_bucket) as d,
                     case when kind = 'group' then workout_id end as workout_id, kind,
                     count(*) as n, sum(booked) as booked, sum(attended) as attended,
                     sum(no_show) as no_show,
                     sum(capacity) filter (where capacity > 0) as cap,
                     sum(attended) filter (where capacity > 0) as cap_attended
                from e group by 1, 2, 3, 4) t), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(w.id, w.name)
        from public.workouts w where w.id in (select workout_id from e)), '{}'::jsonb)
  )
$$;
revoke all on function public.analytics_classes(uuid[], date, date, text) from public, anon;
grant execute on function public.analytics_classes(uuid[], date, date, text) to authenticated;

-- 7) Воронка пробных ------------------------------------------------------------
-- Пробное — продажа номенклатуры kind = trial. Дата пробного — первое
-- посещение, списанное с этого пробного абонемента («Посетил»), без
-- посещения — дата продажи. Купил — абонемент или пакет персональных (не
-- пробное, не разовое, сумма > 0) того же клиента, проданный в день пробного
-- или в следующие 13 дней (14 календарных дней включительно); одна покупка на
-- пробное. Окно ещё не закрыто — open (конверсию за 14 дней по ним рано
-- считать окончательной). Строка: [клуб, дата, номенклатура пробного,
-- пробных, пришли, купили в день, купили за 14 дней, окно открыто].
create or replace function public.analytics_trials(
  p_studio_ids uuid[], p_from date, p_to date, p_bucket text default 'day')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.analytics_ids(p_studio_ids) as a),
  t as (
    select s.id, s.studio_id, s.client_id, s.sold_at, s.membership_id,
           (select min((e.starts_at at time zone 'Asia/Tbilisi')::date)
              from public.client_memberships cm
              join public.schedule_bookings b on b.charged_membership_id = cm.id and b.status = 'attended'
              join public.schedule_entries e on e.id = b.entry_id
             where cm.sale_id = s.id) as visit_on
      from public.sales s
      join public.memberships m on m.id = s.membership_id and m.kind = 'trial', ids
     where s.studio_id = any (ids.a)
       and s.sold_at <= p_to
  ),
  c as (
    select t.*, coalesce(t.visit_on, t.sold_at) as d,
           exists (select 1 from public.sales p join public.memberships pm on pm.id = p.membership_id
                    where p.client_id = t.client_id and p.id <> t.id
                      and pm.kind in ('package', 'personal') and p.total_amount > 0
                      and p.sold_at = t.visit_on) as day0,
           exists (select 1 from public.sales p join public.memberships pm on pm.id = p.membership_id
                    where p.client_id = t.client_id and p.id <> t.id
                      and pm.kind in ('package', 'personal') and p.total_amount > 0
                      and p.sold_at between t.visit_on and t.visit_on + 13) as d14
      from t
     where coalesce(t.visit_on, t.sold_at) between p_from and p_to
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_array(studio_id, d, membership_id, n, attended, day0, d14, open) order by d)
        from (select studio_id, public.analytics_bucket(d, p_bucket) as d, membership_id,
                     count(*) as n,
                     count(*) filter (where visit_on is not null) as attended,
                     count(*) filter (where day0) as day0,
                     count(*) filter (where d14) as d14,
                     count(*) filter (where visit_on is not null and not d14
                                        and visit_on + 13 >= (now() at time zone 'Asia/Tbilisi')::date) as open
                from c group by 1, 2, 3) x), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(m.id, m.name)
        from public.memberships m where m.id in (select membership_id from c)), '{}'::jsonb)
  )
$$;
revoke all on function public.analytics_trials(uuid[], date, date, text) from public, anon;
grant execute on function public.analytics_trials(uuid[], date, date, text) to authenticated;

-- 8) Нулевая номенклатура -------------------------------------------------------
-- Продажи с нулевой суммой (кроме пробных: у них ноль бывает штатно) —
-- контроль ошибок оформления. Строка: [клуб, вид (membership|other),
-- название, продаж, последняя дата].
create or replace function public.analytics_zero(p_studio_ids uuid[], p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select public.analytics_ids(p_studio_ids) as a),
  z as (
    select s.studio_id, 'membership' as kind, coalesce(m.name, 'Без названия') as name, s.sold_at
      from public.sales s
      left join public.memberships m on m.id = s.membership_id, ids
     where s.studio_id = any (ids.a) and s.sold_at between p_from and p_to
       and coalesce(s.total_amount, 0) = 0 and coalesce(m.kind, 'package') <> 'trial'
    union all
    select o.studio_id, 'other', coalesce(o.item_name, 'Без названия'), o.sold_at
      from public.other_sales o, ids
     where o.studio_id = any (ids.a) and o.sold_at between p_from and p_to
       and coalesce(o.total_amount, 0) = 0
  )
  select coalesce(jsonb_agg(jsonb_build_array(studio_id, kind, name, n, last_on) order by n desc), '[]'::jsonb)
    from (select studio_id, kind, name, count(*) as n, max(sold_at) as last_on
            from z group by 1, 2, 3) t
$$;
revoke all on function public.analytics_zero(uuid[], date, date) from public, anon;
grant execute on function public.analytics_zero(uuid[], date, date) to authenticated;

-- Индексы под выборки: продажи клиента по порядку (вид продажи), записи
-- со списанием с абонемента (дата пробного).
create index if not exists sales_client_sold_idx on public.sales (client_id, sold_at, created_at);
create index if not exists sales_studio_sold_idx on public.sales (studio_id, sold_at);
create index if not exists schedule_bookings_charged_idx
  on public.schedule_bookings (charged_membership_id) where charged_membership_id is not null;
