-- ============================================================================
-- Исправления по код-ревью 2026-10-11 (доступ, запись, списания, покупки).
--
-- 1. Итоговые политики, которые на чистой базе зависели от порядка файлов.
--    2026-10-10_admin_permissions.sql по имени идёт раньше staff_directory и
--    app_content_shared, и на новой базе побеждали их версии «любой
--    сотрудник» (is_staff). Здесь — задуманные: раздел рейки «Сотрудники»
--    (staff) / «Мобильное приложение» (app). Реквизиты и ставки сотрудника —
--    как зарплата (2026-10-11_zzz_staff_payroll.sql): только тот, у кого
--    раздел «Сотрудники» и роль хоть в одной студии этого сотрудника
--    (can_manage_employee) — иначе админ одного клуба читал IBAN и правил
--    ставки сотрудников чужих клубов, в том числе свою.
-- 2. Триггер schedule_bookings_group_only — версия из bookings_by_client
--    (сотрудник записывает на персональное): schedule_activity_kinds идёт по
--    имени позже и на чистой базе возвращал старую «только групповые».
-- 3. Повторная запись клиента с «Не посетил» (admin_book_client и
--    book_schedule_entry) больше не превращает пропуск в «записан»: это молча
--    возвращало списанную тренировку и считало место дважды.
-- 4. book_schedule_entry: пустая/0 вместимость — без лимита (как в админке и
--    admin_book_client; раньше любая запись из приложения уходила в лист
--    ожидания); абонемент проверяется на дату по Тбилиси, а не UTC.
-- 5. Отменить свою запись после начала занятия нельзя (только сотрудник):
--    иначе клиент снимал запись до отметки «Не посетил» и уходил от списания.
-- 6. Удалённая запись (каскад при удалении занятия или клиента) возвращает
--    списанную тренировку и место в счётчике занятия.
-- 7. Запись на занятие — только клиент и занятие той же студии, что и запись.
-- 8. Покупка в приложении (политика "sales client insert own"): клиент не
--    может вписать продавца, тренера, тип продажи, дату задним числом и
--    чужую или скрытую номенклатуру — иначе фальшивая продажа попадала в
--    зарплату (payroll_lines) продавцу и тренеру.
-- 9. Индекс bookings_log(entry_id) — по нему ищут отмена и удаление занятия.
-- 10. Списание пакетных студий: ждущее продление не списывается при живом
--     абонементе того же вида; сдвиг срока не теряет заморозку; очередь
--     продлений под блокировкой клиента. 11. Индекс charged_membership_id.
--
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- Колонки, на которые опираются функции ниже: в живой базе они из db/*.sql,
-- выполненных вручную; на случай, если какой-то из них не прогнан.
alter table public.schedule_entries
  add column if not exists waitlist_count int not null default 0;

-- 1. Политики разделов ---------------------------------------------------------

drop policy if exists "trainers staff write" on public.trainers;
create policy "trainers staff write" on public.trainers
  for all to authenticated
  using (public.has_admin_section(auth.uid(), 'staff'))
  with check (public.has_admin_section(auth.uid(), 'staff'));

drop policy if exists "trainer_studios staff write" on public.trainer_studios;
create policy "trainer_studios staff write" on public.trainer_studios
  for all to authenticated
  using (
    public.is_trainer(auth.uid(), studio_id)
    and public.has_admin_section(auth.uid(), 'staff')
  )
  with check (
    public.is_trainer(auth.uid(), studio_id)
    and public.has_admin_section(auth.uid(), 'staff')
  );

drop policy if exists "trainer_bank_details staff" on public.trainer_bank_details;
create policy "trainer_bank_details staff" on public.trainer_bank_details
  for all to authenticated
  using (public.can_manage_employee(auth.uid(), trainer_id))
  with check (public.can_manage_employee(auth.uid(), trainer_id));

drop policy if exists "trainer_pay_rates staff" on public.trainer_pay_rates;
create policy "trainer_pay_rates staff" on public.trainer_pay_rates
  for all to authenticated
  using (public.can_manage_employee(auth.uid(), trainer_id))
  with check (public.can_manage_employee(auth.uid(), trainer_id));

do $$
declare
  t text;
begin
  foreach t in array array['news', 'services', 'push_notifications'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || ' staff write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.has_admin_section(auth.uid(), ''app'')) '
      || 'with check (public.has_admin_section(auth.uid(), ''app''))',
      t || ' staff write', t);
  end loop;
end;
$$;

-- 2. Кто куда может записать (как в 2026-10-11_bookings_by_client.sql) ------------

create or replace function public.schedule_bookings_group_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.schedule_entries where id = new.entry_id;
  if v_kind = 'other' then
    raise exception 'На прочую активность записать нельзя';
  end if;
  if v_kind = 'personal' and not public.is_trainer(auth.uid(), new.studio_id) then
    raise exception 'На это занятие нельзя записаться: оно не групповое';
  end if;
  return new;
end;
$$;

-- 3. Запись администратором: «Не посетил» — уже записан ------------------------
-- Тело — как в 2026-10-11_bookings_by_client.sql, кроме проверки already_booked.

create or replace function public.admin_book_client(p_entry_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.schedule_entries%rowtype;
  v_client public.clients%rowtype;
  v_existing public.schedule_bookings%rowtype;
  v_capacity int;
  v_id uuid;
  v_has_row boolean;
begin
  select * into v_entry from public.schedule_entries where id = p_entry_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not public.is_trainer(auth.uid(), v_entry.studio_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_entry.kind = 'other' then
    return jsonb_build_object('ok', false, 'reason', 'not_bookable');
  end if;
  select * into v_client from public.clients where id = p_client_id;
  if not found or v_client.studio_id <> v_entry.studio_id then
    return jsonb_build_object('ok', false, 'reason', 'client_not_found');
  end if;

  select * into v_existing from public.schedule_bookings
   where entry_id = p_entry_id
     and (client_id = p_client_id or (v_client.user_id is not null and user_id = v_client.user_id))
   limit 1
   for update;
  v_has_row := found;
  if v_has_row and v_existing.status in ('booked', 'attended', 'no_show') then
    return jsonb_build_object('ok', false, 'reason', 'already_booked');
  end if;

  v_capacity := nullif(coalesce(
    v_entry.capacity,
    (select w.capacity from public.workouts w where w.id = v_entry.workout_id),
    0), 0);
  if v_capacity is not null and v_entry.booked_count >= v_capacity then
    return jsonb_build_object('ok', false, 'reason', 'full');
  end if;

  if v_has_row then
    -- Отменённая запись или лист ожидания — снова «записан».
    update public.schedule_bookings
       set status = 'booked', cancelled_at = null, client_id = p_client_id
     where id = v_existing.id;
    v_id := v_existing.id;
    -- Счётчик очереди есть не во всех версиях схемы (db/booking_waitlist.sql).
    if v_existing.status = 'waitlist' and exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'schedule_entries'
         and column_name = 'waitlist_count'
    ) then
      execute 'update public.schedule_entries set waitlist_count = greatest(0, waitlist_count - 1) where id = $1'
        using p_entry_id;
    end if;
  else
    insert into public.schedule_bookings (studio_id, entry_id, client_id, user_id, status)
    values (v_entry.studio_id, p_entry_id, p_client_id, v_client.user_id, 'booked')
    returning id into v_id;
  end if;

  update public.schedule_entries set booked_count = booked_count + 1 where id = p_entry_id;
  return jsonb_build_object('ok', true, 'booking_id', v_id);
end;
$$;

revoke all on function public.admin_book_client(uuid, uuid) from public;
grant execute on function public.admin_book_client(uuid, uuid) to authenticated;

-- 3–4. Запись из приложения --------------------------------------------------
-- Тело — как в db/review_fixes.sql, кроме: вместимость пусто/0 — без лимита;
-- дата абонемента — по Тбилиси; посещение и «Не посетил» — уже записан.

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

  -- null — без лимита (как admin_book_client и расписание админки).
  v_capacity := nullif(coalesce(
    v_entry.capacity,
    (select w.capacity from public.workouts w where w.id = v_entry.workout_id),
    0
  ), 0);

  select exists (
    select 1
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
     where c.user_id = v_user
       and cm.studio_id = v_entry.studio_id
       and cm.status = 'active'
       and (cm.ends_at is null or cm.ends_at >= (now() at time zone 'Asia/Tbilisi')::date)
       and (cm.visits_left is null or cm.visits_left > 0)
  ) into v_has_membership;

  if not v_has_membership then
    return jsonb_build_object('ok', false, 'reason', 'no_membership');
  end if;

  select * into v_existing
  from public.schedule_bookings
  where entry_id = p_entry_id and user_id = v_user;

  -- Посещение и «Не посетил» уже отмечены сотрудником: повторная запись
  -- вернула бы списанную тренировку.
  if found and v_existing.status in ('booked', 'attended', 'no_show') then
    return jsonb_build_object('ok', false, 'reason', 'already_booked',
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;
  if found and v_existing.status = 'waitlist' then
    return jsonb_build_object('ok', false, 'reason', 'already_waitlisted', 'waitlisted', true,
      'booking_id', v_existing.id, 'booked_count', v_entry.booked_count, 'capacity', v_capacity);
  end if;

  if v_capacity is not null and v_entry.booked_count >= v_capacity then
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

-- 5. Отмена клиентом после начала занятия ------------------------------------
-- Проверка в триггере, а не в RPC отмены: так она не зависит от того, какая из
-- версий cancel_schedule_booking (db/*.sql) выполнена на живой базе.

create or replace function public.schedule_bookings_no_late_self_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and auth.uid() is not null
     and not public.is_trainer(auth.uid(), new.studio_id)
     and exists (
       select 1 from public.schedule_entries se
        where se.id = new.entry_id and se.starts_at <= now()
     ) then
    raise exception 'Занятие уже началось — отменить запись нельзя';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_no_late_self_cancel_bu on public.schedule_bookings;
create trigger schedule_bookings_no_late_self_cancel_bu
  before update of status on public.schedule_bookings
  for each row execute function public.schedule_bookings_no_late_self_cancel();

-- 6. Удалённая запись возвращает тренировку и место ---------------------------
-- Брони удаляются каскадом при удалении занятия или клиента — триггер
-- списания (только insert/update) этого не видел: тренировка пропадала с
-- абонемента, а у будущих занятий оставались «занятые» места.

create or replace function public.schedule_bookings_refund_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.charged_membership_id is not null then
    if old.charged_balance = 'personal' then
      update public.client_memberships set personal_left = personal_left + 1
       where id = old.charged_membership_id;
    else
      update public.client_memberships set visits_left = visits_left + 1
       where id = old.charged_membership_id and visits_left is not null;
    end if;
    perform public.packages_restart_term(old.charged_membership_id, old.id);
    if old.client_id is not null then
      perform public.packages_settle(old.client_id);
    end if;
  end if;
  -- Занятие, удаляемое целиком, к этому моменту уже удалено — update ничего
  -- не найдёт.
  if old.status = 'booked' then
    update public.schedule_entries
       set booked_count = greatest(0, booked_count - 1)
     where id = old.entry_id;
  elsif old.status = 'waitlist' then
    update public.schedule_entries
       set waitlist_count = greatest(0, waitlist_count - 1)
     where id = old.entry_id;
  end if;
  return old;
end;
$$;

drop trigger if exists schedule_bookings_refund_ad on public.schedule_bookings;
create trigger schedule_bookings_refund_ad
  after delete on public.schedule_bookings
  for each row execute function public.schedule_bookings_refund_on_delete();

-- 7. Запись — в пределах одной студии ----------------------------------------
-- Срабатывает после schedule_bookings_link_person_biu (по имени): client_id
-- уже дополнен по user_id.

create or replace function public.schedule_bookings_same_studio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.schedule_entries se
     where se.id = new.entry_id and se.studio_id = new.studio_id
  ) then
    raise exception 'Занятие из другого клуба';
  end if;
  if new.client_id is not null and not exists (
    select 1 from public.clients c
     where c.id = new.client_id and c.studio_id = new.studio_id
  ) then
    raise exception 'Клиент из другого клуба';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_same_studio_biu on public.schedule_bookings;
create trigger schedule_bookings_same_studio_biu
  before insert or update of studio_id, entry_id, client_id on public.schedule_bookings
  for each row execute function public.schedule_bookings_same_studio();

-- 8. Покупка в приложении -----------------------------------------------------
-- Только для вызова клиентом (не сотрудник этой студии). Сервер (service_role,
-- auth.uid() пуст) и админка не затронуты.

create or replace function public.sales_client_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_trainer(auth.uid(), new.studio_id) then
    return new;
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.id = new.membership_id and m.studio_id = new.studio_id and m.is_active
  ) then
    raise exception 'Абонемент недоступен для покупки';
  end if;
  new.seller_id := null;
  new.trainer_id := null;
  new.trainer_name := null;
  new.sale_kind := null;
  new.membership_note := null;
  new.sold_at := (now() at time zone 'Asia/Tbilisi')::date;
  return new;
end;
$$;

drop trigger if exists sales_client_insert_guard_bi on public.sales;
create trigger sales_client_insert_guard_bi
  before insert on public.sales
  for each row execute function public.sales_client_insert_guard();

-- 9. Индекс журнала по занятию ------------------------------------------------

create index if not exists bookings_log_entry_idx on public.bookings_log(entry_id);

-- 10. Списание и очередь продлений --------------------------------------------
-- Тела — как в 2026-10-11_zzzzzzz_entry_cancel_no_show.sql и
-- 2026-10-11_zzz_packages_renewal_queue.sql, кроме:
--  * продление (pending) списывается, только если у клиента нет текущего
--    абонемента того же вида (active/frozen) — раньше персональное при живом
--    абонементе списывалось с ждущего продления и запускало его срок;
--  * перенос начала срока сдвигает конец, а не пересчитывает его от
--    длительности — дни заморозки и ручная правка не теряются;
--  * packages_settle блокирует карточку клиента на время расчёта.

create or replace function public.packages_settle(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_balance text;
  v_live public.client_memberships%rowtype;
  v_old public.client_memberships%rowtype;
  v_has_live boolean;
begin
  if p_client_id is null or not exists (
    select 1 from public.clients c
      join public.studios st on st.id = c.studio_id and st.format = 'packages'
     where c.id = p_client_id
  ) then
    return;
  end if;
  -- Две отметки одного клиента одновременно не активируют два продления
  -- (второе падало на client_memberships_one_live_per_balance).
  perform 1 from public.clients where id = p_client_id for update;

  foreach v_balance in array array['group', 'personal'] loop
    select * into v_live from public.client_memberships
     where client_id = p_client_id and balance_kind = v_balance
       and status in ('active', 'frozen')
     limit 1;
    v_has_live := found;

    -- Вернули тренировку на исчерпанный прежний абонемент, а продление ещё
    -- не начато — прежний снова текущий, продление снова ждёт.
    if v_has_live and v_live.status = 'active' and v_live.starts_on_first_visit
       and v_live.started_at is null then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and id <> v_live.id
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end)
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'pending' where id = v_live.id;
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_live := v_old;
        v_live.status := 'active';
      end if;
    end if;

    -- Текущий кончился (основной остаток или срок), а продление ждёт.
    if v_has_live and v_live.status = 'active'
       and ((v_balance = 'personal' and v_live.personal_left <= 0)
            or (v_balance = 'group' and v_live.visits_left is not null and v_live.visits_left <= 0)
            or (v_live.ends_at is not null and v_live.ends_at < v_today))
       and exists (
         select 1 from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
       ) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    -- Текущего нет — ждущий (самый ранний по продаже) становится текущим.
    if not v_has_live then
      update public.client_memberships
         set status = 'active'
       where id = (
         select id from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
          order by created_at
          limit 1
       );
    end if;
  end loop;
end;
$$;

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
         -- Сдвиг, а не пересчёт: дни заморозки и ручная правка конца срока
         -- сохраняются. Пересчёт от длительности — только у неначатого срока.
         ends_at = case when v_first is null or m.duration_days is null then null
                        when cm.ends_at is not null and cm.started_at is not null
                          then cm.ends_at + (v_first - cm.started_at)
                        else v_first + m.duration_days end
    from public.memberships m
   where cm.id = p_cm_id and m.id = cm.membership_id;
end;
$$;

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
       and (cm.status = 'active'
            -- Продление — только если текущего того же вида нет: иначе
            -- ждущее списывалось и начинало срок, пока ходят по текущему.
            or (cm.status = 'pending' and not exists (
                  select 1 from public.client_memberships live
                   where live.client_id = cm.client_id
                     and live.balance_kind = cm.balance_kind
                     and live.status in ('active', 'frozen'))))
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
       and (cm.status = 'active'
            -- Продление — только если текущего того же вида нет: иначе
            -- ждущее списывалось и начинало срок, пока ходят по текущему.
            or (cm.status = 'pending' and not exists (
                  select 1 from public.client_memberships live
                   where live.client_id = cm.client_id
                     and live.balance_kind = cm.balance_kind
                     and live.status in ('active', 'frozen'))))
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
                            when cm.ends_at is not null and cm.started_at is not null
                              then cm.ends_at + (v_date - cm.started_at)
                            else v_date + m.duration_days end
        from public.memberships m
       where cm.id = v_cm and m.id = cm.membership_id;
    end if;
    perform public.packages_settle(new.client_id);
  end if;

  return new;
end;
$$;

-- 11. Индекс списаний: по нему идут restart_term и on delete set null при
-- удалении абонемента.
create index if not exists schedule_bookings_charged_cm_idx
  on public.schedule_bookings(charged_membership_id)
  where charged_membership_id is not null;

notify pgrst, 'reload schema';
