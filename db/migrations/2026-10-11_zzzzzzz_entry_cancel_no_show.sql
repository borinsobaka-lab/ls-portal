-- ============================================================================
-- Расписание и клиенты: отмена тренировки, «Не посетил», второй телефон
-- (правки владельца после встречи со старшим администратором, 2026-10-11).
--
-- Имя с «zzzzzzz»: файл идёт после 2026-10-11_zzzzzz_*.sql — он
-- переопределяет payroll_lines (последняя версия —
-- 2026-10-11_zzzzzz_personal_no_trainer_bonus.sql) и функции списания из
-- 2026-10-11_zzz_packages_renewal_queue.sql; мигратор выполняет файлы по
-- порядку имён.
--
-- 1. Отмена занятия (не удаление: удаляют занятие, добавленное по ошибке) —
--    schedule_entries.cancelled_at / cancel_reason / cancelled_by, RPC
--    cancel_schedule_entry: записи клиентов (и лист ожидания, и уже
--    отмеченные посещения) переходят в «Отменено» с причиной «Тренировка
--    отменена: …», списанные тренировки возвращает триггер списания.
--    restore_schedule_entry — вернуть занятие в расписание (записи остаются
--    отменёнными). На отменённое занятие записаться нельзя (триггер);
--    клиенты в приложениях его не видят (RLS); в зарплату тренерам оно не
--    идёт (payroll_lines).
-- 2. «Не посетил» (пакетный формат) — RPC mark_booking_no_show: статус
--    no_show с причиной — уважительной (no_show_excused = true, тренировка
--    не списывается / возвращается на абонемент) или неуважительной (false,
--    тренировка списывается, как за посещение) — и коротким комментарием
--    (no_show_comment). Пропуски без отметки причины (null — «Отметить
--    пропущенные» в «Истории записей» подписочных студий) не списываются,
--    как и раньше.
-- 3. clients.phone2 — второй номер телефона клиента; вью clients_with_status
--    пересоздана, чтобы он искался (определение — как в db/review_fixes.sql,
--    со статусом frozen).
--
-- Совместимо с подписочным форматом: новые колонки с умолчаниями, списание —
-- по-прежнему только в студиях format = 'packages'. Идемпотентно.
-- ============================================================================

-- 1. Отмена занятия ----------------------------------------------------------

alter table public.schedule_entries
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by uuid;

comment on column public.schedule_entries.cancelled_at is
  'Занятие отменено (cancel_schedule_entry): остаётся в расписании админки, клиенты его не видят и записаться не могут.';
comment on column public.schedule_entries.cancel_reason is
  'Причина отмены занятия («Мало записавшихся», «Заболел тренер», …).';

-- Клиент видит только групповые и не отменённые; сотрудник студии — все.
drop policy if exists "schedule studio select" on public.schedule_entries;
create policy "schedule studio select" on public.schedule_entries
  for select to authenticated
  using (
    studio_id = public.current_studio_id(auth.uid())
    and ((kind = 'group' and cancelled_at is null) or public.is_trainer(auth.uid(), studio_id))
  );

drop policy if exists "set studio select" on public.schedule_entry_trainers;
create policy "set studio select" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
    where e.id = entry_id
      and e.studio_id = public.current_studio_id(auth.uid())
      and ((e.kind = 'group' and e.cancelled_at is null)
           or public.is_trainer(auth.uid(), e.studio_id))
  ));

-- На отменённое занятие не записывают: ни новой записью (приложение,
-- admin_book_client), ни возвратом отменённой записи в «записан» (UPDATE в
-- admin_book_client / book_schedule_entry). security definer — RLS прячет
-- отменённое занятие от клиента, и без него проверка прошла бы.
create or replace function public.schedule_bookings_entry_not_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'cancelled' and exists (
    select 1 from public.schedule_entries
     where id = new.entry_id and cancelled_at is not null
  ) then
    raise exception 'Занятие отменено — записаться на него нельзя';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_entry_not_cancelled_biu on public.schedule_bookings;
create trigger schedule_bookings_entry_not_cancelled_biu
  before insert or update of status on public.schedule_bookings
  for each row execute function public.schedule_bookings_entry_not_cancelled();

create or replace function public.cancel_schedule_entry(p_entry_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.schedule_entries%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_booking_reason text;
  v_lead int;
  v_count int;
begin
  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.is_trainer(auth.uid(), v_entry.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_entry.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_cancelled');
  end if;
  if v_reason is null then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  v_booking_reason := 'Тренировка отменена: ' || v_reason;
  v_lead := round(extract(epoch from (v_entry.starts_at - now())) / 60)::int;

  -- Записанные клиенты снимаются с занятия. Отмеченное посещение и
  -- неуважительный пропуск тоже: тренировку на абонемент вернёт триггер
  -- списания (schedule_bookings_charge_balance).
  update public.schedule_bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = v_booking_reason,
         cancelled_lead_minutes = v_lead
   where entry_id = p_entry_id
     and status in ('booked', 'waitlist', 'attended', 'no_show');
  get diagnostics v_count = row_count;

  update public.bookings_log
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = v_booking_reason,
         cancelled_lead_minutes = v_lead,
         completed_at = null,
         updated_at = now()
   where entry_id = p_entry_id
     and status in ('booked', 'waitlist', 'attended', 'no_show');

  update public.schedule_entries
     set cancelled_at = now(),
         cancel_reason = v_reason,
         cancelled_by = auth.uid(),
         booked_count = 0
   where id = p_entry_id;

  -- Счётчик очереди есть не во всех версиях схемы (db/booking_waitlist.sql).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'schedule_entries'
       and column_name = 'waitlist_count'
  ) then
    execute 'update public.schedule_entries set waitlist_count = 0 where id = $1'
      using p_entry_id;
  end if;

  return jsonb_build_object('ok', true, 'cancelled_bookings', v_count);
end;
$$;

revoke all on function public.cancel_schedule_entry(uuid, text) from public, anon;
grant execute on function public.cancel_schedule_entry(uuid, text) to authenticated;

-- Отменили по ошибке — занятие снова в расписании. Снятые записи не
-- возвращаются: клиенты записываются заново.
create or replace function public.restore_schedule_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.schedule_entries%rowtype;
begin
  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.is_trainer(auth.uid(), v_entry.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_entry.cancelled_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_cancelled');
  end if;
  update public.schedule_entries
     set cancelled_at = null, cancel_reason = null, cancelled_by = null
   where id = p_entry_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.restore_schedule_entry(uuid) from public, anon;
grant execute on function public.restore_schedule_entry(uuid) to authenticated;

-- 2. «Не посетил» -------------------------------------------------------------

alter table public.schedule_bookings
  add column if not exists no_show_excused boolean,
  add column if not exists no_show_comment text;
alter table public.bookings_log
  add column if not exists no_show_excused boolean,
  add column if not exists no_show_comment text;

comment on column public.schedule_bookings.no_show_excused is
  '«Не посетил»: true — уважительная причина (тренировка не списывается), false — неуважительная (списывается), null — причина не указана (не списывается).';
comment on column public.schedule_bookings.no_show_comment is
  '«Не посетил»: комментарий администратора.';

create or replace function public.mark_booking_no_show(
  p_booking_id uuid,
  p_excused boolean,
  p_comment text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.schedule_bookings%rowtype;
  v_comment text := nullif(btrim(p_comment), '');
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
  if v_booking.status not in ('booked', 'no_show', 'attended') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_status');
  end if;
  if p_excused is null then
    return jsonb_build_object('ok', false, 'reason', 'excuse_required');
  end if;
  if v_comment is null then
    return jsonb_build_object('ok', false, 'reason', 'comment_required');
  end if;

  -- status — в SET всегда (и при no_show → no_show): триггер списания
  -- висит на update of status и решает по причине, списать или вернуть.
  update public.schedule_bookings
     set status = 'no_show',
         no_show_excused = p_excused,
         no_show_comment = v_comment
   where id = p_booking_id;

  update public.bookings_log
     set status = 'no_show',
         no_show_excused = p_excused,
         no_show_comment = v_comment,
         completed_at = coalesce(completed_at, now()),
         updated_at = now()
   where booking_id = p_booking_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.mark_booking_no_show(uuid, boolean, text) from public, anon;
grant execute on function public.mark_booking_no_show(uuid, boolean, text) to authenticated;

-- Срок продления от первого списания: начало — самое раннее занятие, за
-- которое списано с абонемента (посещение или неуважительный пропуск), кроме
-- p_skip_booking. Раньше — только посещения (attended); списанная запись
-- всегда несёт charged_membership_id, возврат его обнуляет.
create or replace function public.packages_restart_term(p_cm_id uuid, p_skip_booking uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first date;
begin
  if not exists (
    select 1 from public.client_memberships where id = p_cm_id and starts_on_first_visit
  ) then
    return;
  end if;
  select min((se.starts_at at time zone 'Asia/Tbilisi')::date) into v_first
    from public.schedule_bookings b
    join public.schedule_entries se on se.id = b.entry_id
   where b.charged_membership_id = p_cm_id
     and b.id is distinct from p_skip_booking;
  update public.client_memberships cm
     set started_at = v_first,
         ends_at = case when v_first is null or m.duration_days is null then null
                        else v_first + m.duration_days end
    from public.memberships m
   where cm.id = p_cm_id and m.id = cm.membership_id;
end;
$$;

revoke all on function public.packages_restart_term(uuid, uuid) from public, anon, authenticated;

-- Списание: тело — как в 2026-10-11_zzz_packages_renewal_queue.sql, но
-- «списывается» теперь не только посещение (attended), но и неуважительный
-- пропуск (no_show с no_show_excused = false). Переход между ними (пропуск →
-- посещение) ничего не меняет; уход в любое другое состояние (booked,
-- cancelled, уважительный пропуск) возвращает тренировку.
create or replace function public.schedule_bookings_charge_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_starts timestamptz;
  v_date date;
  v_cm uuid;
  v_first_visit boolean;
  v_started date;
  v_was boolean := false;
  v_is boolean;
begin
  -- Причина пропуска живёт только вместе со статусом no_show: иначе запись,
  -- вернувшаяся в «записан», при массовой отметке пропусков (без причины)
  -- списалась бы по старой неуважительной причине.
  if new.status is distinct from 'no_show' then
    new.no_show_excused := null;
    new.no_show_comment := null;
  end if;

  v_is := new.status = 'attended' or (new.status = 'no_show' and new.no_show_excused is false);
  if tg_op = 'UPDATE' then
    v_was := old.status = 'attended' or (old.status = 'no_show' and old.no_show_excused is false);
  end if;

  -- Списание сняли — тренировка возвращается на тот же абонемент.
  if v_was and not v_is then
    if old.charged_membership_id is not null then
      if old.charged_balance = 'personal' then
        update public.client_memberships set personal_left = personal_left + 1
         where id = old.charged_membership_id;
      else
        update public.client_memberships set visits_left = visits_left + 1
         where id = old.charged_membership_id and visits_left is not null;
      end if;
      perform public.packages_restart_term(old.charged_membership_id, old.id);
      perform public.packages_settle(old.client_id);
    end if;
    new.charged_membership_id := null;
    new.charged_balance := null;
    return new;
  end if;

  if not v_is
     or v_was
     or new.charged_membership_id is not null
     or new.client_id is null
     or not exists (
       select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
     ) then
    return new;
  end if;

  select se.kind, se.starts_at into v_kind, v_starts
    from public.schedule_entries se where se.id = new.entry_id;
  v_date := coalesce((v_starts at time zone 'Asia/Tbilisi')::date,
                     (now() at time zone 'Asia/Tbilisi')::date);

  -- Срок продления, по которому ещё не ходили, не кончается (ends_at null);
  -- у начатого — обычная проверка конца срока.
  if v_kind = 'group' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status in ('active', 'pending')
       and cm.visits_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set visits_left = visits_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'visits';
    end if;
  elsif v_kind = 'personal' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and cm.status in ('active', 'pending')
       and cm.personal_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set personal_left = personal_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'personal';
    end if;
  end if;

  if v_cm is not null then
    -- Первое списание по продлению (или более раннее, чем уже учтённое) —
    -- срок от даты этого занятия.
    if v_first_visit and (v_started is null or v_date < v_started) then
      update public.client_memberships cm
         set started_at = v_date,
             ends_at = case when m.duration_days is null then null
                            else v_date + m.duration_days end
        from public.memberships m
       where cm.id = v_cm and m.id = cm.membership_id;
    end if;
    perform public.packages_settle(new.client_id);
  end if;

  return new;
end;
$$;

-- 3. Второй телефон клиента ---------------------------------------------------

alter table public.clients add column if not exists phone2 text;

comment on column public.clients.phone2 is
  'Второй номер телефона клиента (E.164, как phone), по желанию.';

-- c.* раскрывается при создании вью: без пересоздания phone2 в неё не попадёт.
drop view if exists public.clients_with_status;
create view public.clients_with_status
with (security_invoker = true) as
select
  c.*,
  coalesce(c.last_name, '') || ' ' ||
  coalesce(c.first_name, '') || ' ' ||
  coalesce(c.full_name, '') as search_name,
  case
    when st.has_active then 'chk'
    when st.has_any then 'bchk'
    else 'pchk'
  end as club_status
from public.clients c
left join lateral (
  select
    count(*) > 0 as has_any,
    coalesce(
      bool_or(
        cm.status = 'frozen'
        or (cm.status = 'active' and (cm.ends_at is null or cm.ends_at >= current_date))
      ),
      false
    ) as has_active
  from public.client_memberships cm
  where cm.client_id = c.id
) st on true;

grant select on public.clients_with_status to authenticated;

-- 4. Зарплата: отменённые занятия не оплачиваются ------------------------------
-- Тело — как в 2026-10-11_zzzzzz_personal_no_trainer_bonus.sql, изменено
-- только lessons (e.cancelled_at is null).

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
       and e.cancelled_at is null
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
  -- Пакет персональных тренировок бонуса не даёт ни администратору, ни
  -- тренеру при продаже (решения владельца 2026-10-11).
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
      left join public.memberships m on m.id = s.membership_id
     where s.trainer_id is not null
       and m.kind is distinct from 'personal'
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
