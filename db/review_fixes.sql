-- ============================================================================
-- Исправления по код-ревью (2026-08-07). Идемпотентно.
-- Запускать последним, после всех предыдущих файлов.
--
-- 1. Убрана двусмысленная перегрузка cancel_membership_autorenew.
-- 2. Заморозка перестала быть «зомби»: истёкшая заморозка сама возвращается
--    в active, а cancel_membership теперь умеет отменять и замороженный.
-- 3. refunds больше не блокируют удаление продажи.
-- 4. Ёмкость занятия считается корректно, если тренировка удалена.
-- 5. Вью clients_with_status знает про статус frozen.
-- 6. mark_no_show_bookings ограничивается студией (раньше писала по всем).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Двусмысленная перегрузка RPC отмены автопродления.
--    Существовали и 2-аргументная, и 3-аргументная версии, обе с дефолтами.
--    Вызов приложения (3 именованных аргумента) разрешался корректно, но любой
--    вызов с двумя аргументами падал с «function is not unique». Оставляем
--    только 3-аргументную — она и содержит проверку владельца.
-- ---------------------------------------------------------------------------
drop function if exists public.cancel_membership_autorenew(uuid, text);

-- ---------------------------------------------------------------------------
-- 2) Заморозка: автоматический выход по сроку + отмена замороженного.
-- ---------------------------------------------------------------------------

-- 2a. Разморозка по истечении срока. Раньше вернуть абонемент в строй мог
--     только человек кнопкой: expire_memberships трогает лишь 'active', а
--     запись на занятие требует 'active' — клиент оставался заблокирован.
create or replace function public.unfreeze_expired_memberships()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_staff(auth.uid()) then
    raise exception 'forbidden: staff only';
  end if;

  update public.client_memberships
     set status = 'active', frozen_at = null, frozen_until = null
   where status = 'frozen'
     and frozen_until is not null
     and frozen_until <= current_date;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.unfreeze_expired_memberships() from public;
grant execute on function public.unfreeze_expired_memberships() to authenticated, service_role;

-- 2b. Истечение срока действия теперь охватывает и замороженные абонементы,
--     и сперва снимает отработавшую заморозку.
create or replace function public.expire_memberships()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_staff(auth.uid()) then
    raise exception 'forbidden: staff only';
  end if;

  perform public.unfreeze_expired_memberships();

  update public.client_memberships
     set status = 'expired'
   where status in ('active', 'frozen')
     and ends_at is not null
     and ends_at < current_date;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_memberships() from public;
grant execute on function public.expire_memberships() to authenticated, service_role;

-- 2c. Отмена абонемента: раньше UPDATE фильтровался по status='active', из-за
--     чего замороженный абонемент отменить было нельзя, а функция молча
--     возвращала NULL вместо ошибки — клиент видел «успех» без результата.
create or replace function public.cancel_membership(
  _client_membership_id uuid,
  _reason text default null,
  _source text default 'mobile'
) returns public.client_memberships
language plpgsql security definer set search_path = public as $$
declare row public.client_memberships;
begin
  select * into row from public.client_memberships where id = _client_membership_id;
  if not found then raise exception 'not found'; end if;
  if not (
    public.is_trainer(auth.uid(), row.studio_id)
    or exists (select 1 from public.clients c
               where c.id = row.client_id and c.user_id = auth.uid())
  ) then raise exception 'forbidden'; end if;

  if row.status not in ('active', 'frozen') then
    raise exception 'membership is not active (status: %)', row.status;
  end if;

  update public.client_memberships
     set status = 'cancelled',
         auto_renew = false,
         frozen_at = null,
         frozen_until = null,
         cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(_reason, cancel_reason),
         cancel_source = coalesce(_source, 'mobile')
   where id = _client_membership_id
   returning * into row;
  return row;
end $$;
grant execute on function public.cancel_membership(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) refunds: ON DELETE SET NULL конфликтовал с CHECK «ровно одна ссылка» —
--    удаление продажи с возвратом падало с нарушением ограничения. Возврат
--    без продажи смысла не имеет, поэтому каскадим.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.refunds') is not null then
    alter table public.refunds drop constraint if exists refunds_sale_id_fkey;
    alter table public.refunds
      add constraint refunds_sale_id_fkey
      foreign key (sale_id) references public.sales(id) on delete cascade;

    alter table public.refunds drop constraint if exists refunds_other_sale_id_fkey;
    alter table public.refunds
      add constraint refunds_other_sale_id_fkey
      foreign key (other_sale_id) references public.other_sales(id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Ёмкость занятия: `select ... into` по пустой выборке кладёт в переменную
--    NULL, а не значение coalesce. Если тренировка удалена или workout_id
--    пуст, проверка заполненности превращалась в NULL → занятие принимало
--    записи сверх лимита. Считаем ёмкость выражением, а не через SELECT INTO.
-- ---------------------------------------------------------------------------
create or replace function public.book_schedule_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_entry public.schedule_entries%rowtype;
  v_capacity int;
  v_booking_id uuid;
  v_existing public.schedule_bookings%rowtype;
  v_has_membership boolean;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_entry.starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'past');
  end if;

  v_capacity := coalesce(
    v_entry.capacity,
    (select w.capacity from public.workouts w where w.id = v_entry.workout_id),
    0
  );

  select exists (
    select 1
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
     where c.user_id = v_user
       and cm.studio_id = v_entry.studio_id
       and cm.status = 'active'
       and (cm.ends_at is null or cm.ends_at >= current_date)
       and (cm.visits_left is null or cm.visits_left > 0)
  ) into v_has_membership;

  if not v_has_membership then
    return jsonb_build_object('ok', false, 'reason', 'no_membership');
  end if;

  select * into v_existing
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  if found and v_existing.status = 'booked' then
    return jsonb_build_object('ok', false, 'reason', 'already_booked',
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;
  if found and v_existing.status = 'waitlist' then
    return jsonb_build_object('ok', false, 'reason', 'already_waitlisted', 'waitlisted', true,
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

  if v_entry.booked_count >= v_capacity then
    if found then
      update public.schedule_bookings
         set status = 'waitlist', cancelled_at = null, created_at = now()
       where id = v_existing.id
       returning id into v_booking_id;
    else
      insert into public.schedule_bookings (studio_id, entry_id, user_id, status)
      values (v_entry.studio_id, p_entry_id, v_user, 'waitlist')
      returning id into v_booking_id;
    end if;
    update public.schedule_entries
       set waitlist_count = waitlist_count + 1
     where id = p_entry_id;
    return jsonb_build_object('ok', true, 'waitlisted', true,
      'booking_id', v_booking_id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

  if found then
    update public.schedule_bookings
       set status = 'booked', cancelled_at = null, created_at = now()
     where id = v_existing.id
     returning id into v_booking_id;
  else
    insert into public.schedule_bookings (studio_id, entry_id, user_id, status)
    values (v_entry.studio_id, p_entry_id, v_user, 'booked')
    returning id into v_booking_id;
  end if;
  update public.schedule_entries
     set booked_count = booked_count + 1
   where id = p_entry_id;
  return jsonb_build_object('ok', true, 'waitlisted', false,
    'booking_id', v_booking_id, 'booked_count', v_entry.booked_count + 1, 'capacity', v_capacity);
end;
$$;
revoke all on function public.book_schedule_entry(uuid) from public;
grant execute on function public.book_schedule_entry(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Вью clients_with_status не знала про 'frozen': список клиентов показывал
--    БЧК, а карточка того же человека — ЧК, и фильтр «Член клуба» терял всех
--    замороженных. Приводим к логике client-status.ts.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6) mark_no_show_bookings: писала по всем студиям сразу (админ одной студии
--    переписывал строки другой). Добавлен необязательный фильтр по студии;
--    вызов без аргумента сохраняет прежнее поведение для крона.
-- ---------------------------------------------------------------------------
-- Сначала убираем версию без аргументов: иначе вызов mark_no_show_bookings()
-- стал бы неоднозначным — ровно та же ловушка, что в пункте 1.
drop function if exists public.mark_no_show_bookings();

create or replace function public.mark_no_show_bookings(p_studio_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is not null and not public.is_staff(auth.uid()) then
    raise exception 'forbidden: staff only';
  end if;

  update public.schedule_bookings sb
     set status = 'no_show'
    from public.schedule_entries se
   where se.id = sb.entry_id
     and sb.status = 'booked'
     and se.ends_at < now()
     and (p_studio_id is null or sb.studio_id = p_studio_id);

  update public.bookings_log
     set status = 'no_show', completed_at = now(), updated_at = now()
   where status = 'booked'
     and ends_at < now()
     and (p_studio_id is null or studio_id = p_studio_id);

  get diagnostics v_count = row_count;

  -- Очередь на уже прошедшие занятия закрываем: иначе строки висят вечно,
  -- а счётчик waitlist_count навсегда остаётся ненулевым и бейдж «+N» в
  -- расписании показывает спрос, которого давно нет.
  update public.schedule_bookings sb
     set status = 'cancelled',
         cancelled_at = coalesce(sb.cancelled_at, now()),
         cancel_reason = coalesce(sb.cancel_reason, 'Занятие прошло')
    from public.schedule_entries se
   where se.id = sb.entry_id
     and sb.status = 'waitlist'
     and se.ends_at < now()
     and (p_studio_id is null or sb.studio_id = p_studio_id);

  update public.schedule_entries se
     set waitlist_count = 0
   where se.ends_at < now()
     and se.waitlist_count <> 0
     and (p_studio_id is null or se.studio_id = p_studio_id);

  return v_count;
end;
$$;
revoke all on function public.mark_no_show_bookings(uuid) from public;
grant execute on function public.mark_no_show_bookings(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
