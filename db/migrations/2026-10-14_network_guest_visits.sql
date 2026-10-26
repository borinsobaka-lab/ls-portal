-- ============================================================================
-- Гостевые посещения в сети пакетных студий (решение владельца 2026-10-12,
-- повторено 2026-10-14: первая версия этого файла не была выкачена).
--
-- Все студии формата «пакеты тренировок» — одна сеть одного собственника.
-- Абонемент, купленный в любой из них, действует во всех: клиент студии 1
-- записывается на занятие студии 2 (сам в приложении или через
-- администратора), и посещение списывается с его абонемента.
--
-- Модель «домашняя студия + гостевой визит»:
--   * карточка клиента и абонемент остаются в домашней студии (где куплены);
--   * запись (schedule_bookings.studio_id) — студии занятия: расписание,
--     заполняемость, отметки и зарплаты студии 2 работают как раньше;
--   * client_id записи — карточка домашней студии, поэтому списание
--     (schedule_bookings_charge_balance ищет абонемент по client_id) берёт
--     абонемент клиента без изменений;
--   * администратор студии 2 видит о госте только имя, телефон, домашнюю
--     студию и остаток (RPC entry_guest_clients / network_client_search),
--     но не карточку целиком;
--   * сотрудник домашней студии видит гостевые посещения своего клиента в его
--     истории (журнал bookings_log).
-- Подписочные студии не затронуты: у них сеть — сама студия.
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Сеть ---------------------------------------------------------------------

create or replace function public.studios_same_network(_a uuid, _b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(_a = _b, false) or exists (
    select 1
      from public.studios a
      join public.studios b on b.id = _b
     where a.id = _a
       and a.format = 'packages'
       and b.format = 'packages'
  )
$$;

revoke all on function public.studios_same_network(uuid, uuid) from public;
grant execute on function public.studios_same_network(uuid, uuid) to authenticated;

-- 2. Запись из приложения: карточка — из любой студии сети --------------------
-- Раньше карточка искалась только в студии занятия; у гостя её там нет, и
-- запись оставалась без client_id — посещение молча не списывалось.
-- Порядок: карточка с живым абонементом, затем карточка студии занятия.

create or replace function public.schedule_bookings_link_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is null and new.user_id is not null then
    select c.id into new.client_id
      from public.clients c
     where c.user_id = new.user_id
       and public.studios_same_network(c.studio_id, new.studio_id)
     order by exists (
                select 1 from public.client_memberships cm
                 where cm.client_id = c.id and cm.status in ('active', 'pending')
              ) desc,
              (c.studio_id = new.studio_id) desc,
              c.created_at
     limit 1;
  elsif new.user_id is null and new.client_id is not null then
    select c.user_id into new.user_id from public.clients c where c.id = new.client_id;
  end if;
  return new;
end;
$$;

-- 3. Клиент записи — из студии той же сети ------------------------------------

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
     where c.id = new.client_id
       and public.studios_same_network(c.studio_id, new.studio_id)
  ) then
    raise exception 'Клиент из другого клуба';
  end if;
  return new;
end;
$$;

-- 4. Администратор записывает гостя ------------------------------------------
-- Тело — как в 2026-10-11_zzzzzzzz_review_fixes.sql (позже не менялось), кроме
-- проверки студии клиента: студия той же сети.

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
  if not found or not public.studios_same_network(v_client.studio_id, v_entry.studio_id) then
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

-- 5. Клиент записывается в любой студии сети ----------------------------------
-- Тело — как в 2026-10-11_zzzzzzzz_review_fixes.sql (позже не менялось), кроме
-- поиска абонемента: абонемент из студии той же сети, а не только из студии
-- занятия.

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
       and public.studios_same_network(cm.studio_id, v_entry.studio_id)
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

-- 6. Гость глазами студии занятия ---------------------------------------------
-- Карточку клиента читают только сотрудники его студии (RLS clients), поэтому
-- в окне занятия студии 2 гость был бы «Пользователь без анкеты». Отдаём
-- только нужное для работы с записью: имя, телефон, домашнюю студию и
-- действующие абонементы (остаток, срок) — без почты, заметок, продаж.

create or replace function public.guest_client_json(_client_id uuid, _ahead int default 0)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'user_id', c.user_id,
    'first_name', c.first_name,
    'last_name', c.last_name,
    'full_name', c.full_name,
    'phone', c.phone,
    'home_studio_id', c.studio_id,
    'home_studio_name', s.name,
    'ahead', coalesce(_ahead, 0),
    -- Действующие и ждущие продления: остаток в окне занятия считается с
    -- продлением, как у клиентов своего клуба (lib/booking-coverage.ts).
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', cm.client_id,
               'status', cm.status,
               'started_at', cm.started_at,
               'ends_at', cm.ends_at,
               'visits_left', cm.visits_left,
               'personal_left', cm.personal_left,
               'balance_kind', cm.balance_kind,
               'membership', jsonb_build_object('name', m.name)
             ) order by cm.created_at)
        from public.client_memberships cm
        left join public.memberships m on m.id = cm.membership_id
       where cm.client_id = c.id and cm.status in ('active', 'pending')
    ), '[]'::jsonb)
  )
    from public.clients c
    join public.studios s on s.id = c.studio_id
   where c.id = _client_id
$$;

-- Вспомогательная: вызывать только из функций ниже, которые проверяют права.
-- Supabase по умолчанию выдаёт EXECUTE новым функциям anon и authenticated —
-- забираем явно, иначе по id клиента любой получил бы его имя и телефон.
revoke all on function public.guest_client_json(uuid, int) from public, anon, authenticated;

-- Гости занятия: клиенты записей этого занятия, чьи карточки вызывающему не
-- видны (из других студий сети). Только сотрудник студии занятия. ahead —
-- неотмеченные записи гостя на такие же занятия раньше этого (в любой студии
-- сети): остаток абонемента уйдёт сначала на них — как coverage в окне
-- занятия у клиентов своего клуба.
create or replace function public.entry_guest_clients(p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_entry public.schedule_entries%rowtype;
begin
  select * into v_entry from public.schedule_entries where id = p_entry_id;
  if not found or not public.is_trainer(auth.uid(), v_entry.studio_id) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(public.guest_client_json(g.client_id, (
             select count(*)::int
               from public.schedule_bookings ob
               join public.schedule_entries oe on oe.id = ob.entry_id
              where ob.client_id = g.client_id
                and ob.status = 'booked'
                and ob.entry_id <> p_entry_id
                and oe.kind = v_entry.kind
                and oe.cancelled_at is null
                and oe.starts_at < v_entry.starts_at
           )))
      from (
        select distinct b.client_id
          from public.schedule_bookings b
          join public.clients c on c.id = b.client_id
         where b.entry_id = p_entry_id
           and c.studio_id <> v_entry.studio_id
           and not public.is_trainer(auth.uid(), c.studio_id)
      ) g
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.entry_guest_clients(uuid) from public;
grant execute on function public.entry_guest_clients(uuid) to authenticated;

-- Поиск клиента других студий сети, чтобы записать его гостем. Только
-- сотрудник пакетной студии p_studio_id; запрос — от 3 символов (не листать
-- всю базу сети): часть имени, от 4 цифр телефона или почта целиком.
create or replace function public.network_client_search(p_studio_id uuid, p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_query, '')));
  -- Запрос — текст, а не шаблон: «%%%» иначе нашёл бы всех клиентов сети.
  v_like text := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
begin
  if not public.is_trainer(auth.uid(), p_studio_id)
     or not exists (select 1 from public.studios where id = p_studio_id and format = 'packages')
     or length(v_q) < 3 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(public.guest_client_json(f.id))
      from (
        select c.id
          from public.clients c
          join public.studios s on s.id = c.studio_id and s.format = 'packages'
         where c.studio_id <> p_studio_id
           and (
             lower(concat_ws(' ', c.last_name, c.first_name)) like v_like
             or lower(concat_ws(' ', c.first_name, c.last_name)) like v_like
             or lower(coalesce(c.full_name, '')) like v_like
             or (length(v_digits) >= 4 and (
                   regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'
                   or regexp_replace(coalesce(c.phone2, ''), '\D', '', 'g') like '%' || v_digits || '%'))
             or lower(trim(coalesce(c.email, ''))) = v_q
           )
         order by c.last_name nulls last, c.first_name nulls last, c.full_name
         limit 20
      ) f
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.network_client_search(uuid, text) from public;
grant execute on function public.network_client_search(uuid, text) to authenticated;

-- 7. Гостевые посещения в истории клиента домашней студии ---------------------
-- Журнал читают сотрудники студии занятия; добавляем сотрудников студии
-- карточки клиента — иначе списанная в студии 2 тренировка «пропадала».

drop policy if exists "bookings_log home studio read" on public.bookings_log;
create policy "bookings_log home studio read" on public.bookings_log
  for select to authenticated
  using (
    client_id is not null
    and exists (
      select 1 from public.clients c
       where c.id = bookings_log.client_id
         and public.is_trainer(auth.uid(), c.studio_id)
    )
  );

notify pgrst, 'reload schema';
