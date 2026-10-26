-- ============================================================================
-- Расписание: отмена посещения; продажи пакетов персональных — без бонуса
-- администратору (решения владельца 2026-10-11).
--
-- Имя с «zzzzz»: файл идёт после 2026-10-11_zzzz_sales_seller.sql, чью
-- payroll_lines он переопределяет, — мигратор выполняет файлы по порядку имён.
--
-- 1. unmark_booking_attended — администратор снимает отметку «Посетил»
--    (поставил по ошибке) в любой момент, в т.ч. у прошедших занятий: запись
--    снова «Записан» (booked), строка журнала — тоже. Тренировку на баланс
--    возвращает триггер списания (schedule_bookings_charge_balance,
--    2026-10-11_zzz_packages_renewal_queue.sql: attended → другой статус).
--    Отметить посещение можно и у пропущенной записи (no_show) —
--    mark_booking_attended это и раньше позволял, панель записей теперь их
--    показывает.
-- 2. payroll_lines — как в 2026-10-11_zzzz_sales_seller.sql, кроме одного:
--    продажа пакета персональных тренировок (memberships.kind = 'personal')
--    не идёт в продажи администратора, который её оформил (seller_id). Тренер
--    при продаже (trainer_id) по-прежнему получает её в свои продажи.
--
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- 1. Отмена посещения ---------------------------------------------------------

create or replace function public.unmark_booking_attended(p_booking_id uuid)
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

  if v_booking.status <> 'attended' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_status');
  end if;

  -- Возврат тренировки на абонемент — в BEFORE-триггере списания.
  update public.schedule_bookings
     set status = 'booked'
   where id = p_booking_id;

  update public.bookings_log
     set status = 'booked',
         completed_at = null,
         updated_at = now()
   where booking_id = p_booking_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.unmark_booking_attended(uuid) from public, anon;
grant execute on function public.unmark_booking_attended(uuid) to authenticated;

-- 2. Зарплата: пакет персональных — без бонуса администратору ----------------

create or replace function public.payroll_lines(_from date, _to date)
returns table (
  trainer_id uuid,
  work_date date,
  studio_id uuid,
  studio_name text,
  kind text,
  title text,
  units integer,
  amount numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  _today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  if not public.has_admin_section(auth.uid(), 'staff') then
    raise exception 'Нет доступа к разделу «Сотрудники»' using errcode = '42501';
  end if;
  if _from is null or _to is null or _to < _from or _to - _from > 62 then
    raise exception 'Неверный период: %–%', _from, _to;
  end if;

  return query
  with pk as (
    select s.id, s.name from public.studios s where s.format = 'packages'
  ),
  visible as (
    select distinct ts.trainer_id
      from public.trainer_studios ts
      join pk on pk.id = ts.studio_id
     where public.is_trainer(auth.uid(), ts.studio_id)
  ),
  lessons as (
    select st.trainer_id,
           (e.starts_at at time zone 'Asia/Tbilisi')::date as d,
           e.studio_id,
           e.kind,
           case when e.kind = 'other' then e.title end as title,
           case e.kind
             when 'group' then
               case when r.group_training_enabled then coalesce(r.group_training_rate, 0) else 0 end
             when 'personal' then
               case when r.personal_training_enabled then coalesce(r.personal_training_rate, 0) else 0 end
             else coalesce(e.pay_rate, 0)
           end as rate
      from public.schedule_entries e
      join pk on pk.id = e.studio_id
      join public.schedule_entry_trainers st on st.entry_id = e.id
      join visible v on v.trainer_id = st.trainer_id
      left join public.trainer_pay_rates r on r.trainer_id = st.trainer_id
     where e.starts_at <= now()
       and (e.starts_at at time zone 'Asia/Tbilisi')::date between _from and _to
  ),
  shifts as (
    select a.trainer_id, a.shift_date as d, a.studio_id,
           case when r.admin_shift_enabled then coalesce(r.admin_shift_rate, 0) else 0 end as rate
      from public.admin_shifts a
      join pk on pk.id = a.studio_id
      join visible v on v.trainer_id = a.trainer_id
      left join public.trainer_pay_rates r on r.trainer_id = a.trainer_id
     where a.shift_date between _from and least(_to, _today)
  ),
  -- Чьи продажи: администратор, который продал (seller_id), и тренер при
  -- продаже (trainer_id). union, а не union all: один человек в обеих ролях —
  -- одна продажа.
  -- Пакет персональных тренировок бонуса администратору не даёт (решение
  -- владельца 2026-10-11): у таких продаж в зарплату идёт только тренер.
  sale_people as (
    select s.seller_id as trainer_id, s.id as sale_id
      from public.sales s
      join pk on pk.id = s.studio_id
      left join public.memberships m on m.id = s.membership_id
     where s.seller_id is not null
       and m.kind is distinct from 'personal'
    union
    select s.trainer_id, s.id
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.trainer_id is not null
  ),
  -- Поступившие деньги: продажа без графика — вся сумма в день продажи;
  -- с графиком (рассрочка) — каждый внесённый платёж в день внесения
  -- (первый платёж графика внесён в день продажи). Так доплата по
  -- абонементу, проданному в прошлом месяце, идёт в период, когда внесена.
  payments as (
    select s.id as sale_id, s.studio_id, s.sold_at as d, s.total_amount as amount
      from public.sales s
      join pk on pk.id = s.studio_id
     where s.sold_at between _from and _to
       and not exists (select 1 from public.sale_installments i where i.sale_id = s.id)
    union all
    select s.id, s.studio_id, coalesce(i.paid_at, i.due_date), i.amount
      from public.sale_installments i
      join public.sales s on s.id = i.sale_id
      join pk on pk.id = s.studio_id
     where i.paid
       and coalesce(i.paid_at, i.due_date) between _from and _to
  ),
  sold as (
    select p.trainer_id, pay.d, pay.studio_id, pay.amount as total_amount
      from sale_people p
      join visible v on v.trainer_id = p.trainer_id
      join payments pay on pay.sale_id = p.sale_id
  ),
  all_lines as (
    select x.trainer_id, x.d, x.studio_id, x.kind, x.title, 1 as n, x.rate as amount from lessons x
    union all
    select x.trainer_id, x.d, x.studio_id, 'shift', null, 1, x.rate from shifts x
    union all
    select x.trainer_id, x.d, x.studio_id, 'sale', null, 1, x.total_amount from sold x
  )
  select l.trainer_id, l.d, l.studio_id, pk.name, l.kind, l.title,
         count(*)::integer, sum(l.amount)
    from all_lines l
    join pk on pk.id = l.studio_id
   group by l.trainer_id, l.d, l.studio_id, pk.name, l.kind, l.title
   order by l.d, pk.name;
end;
$$;

revoke all on function public.payroll_lines(date, date) from public, anon;
grant execute on function public.payroll_lines(date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
