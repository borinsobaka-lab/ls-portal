-- ============================================================================
-- Запись на занятие по карточке клиента (решение владельца 2026-10-11).
--
-- Раньше запись (schedule_bookings) была привязана только к учётной записи
-- приложения (user_id) — клиента, которого завёл администратор и у которого
-- приложения нет, записать было нельзя. Теперь:
--   * у записи есть client_id (карточка клиента); user_id — необязателен;
--   * у клиента с приложением user_id подставляется сам (BEFORE-триггер), и
--     запись, сделанную администратором, он видит в приложении как свою;
--   * когда клиент без приложения зарегистрируется и карточка привяжется к
--     учётной записи, его записи и строки журнала получат user_id;
--   * администратор записывает клиента RPC admin_book_client — на групповое
--     и персональное занятие (клиент сам — только на групповое).
--
-- Существующие функции журнала (bookings_log_sync) и «последнего визита» не
-- переписываем: какие из старых db/*.sql выполнены на живой базе, точно не
-- известно (AGENT_TASKS.md). Рядом — свои триггеры, которые дописывают
-- client_id и данные клиента. Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Колонка и ограничения ---------------------------------------------------

alter table public.schedule_bookings
  add column if not exists client_id uuid references public.clients(id) on delete cascade;
alter table public.schedule_bookings alter column user_id drop not null;

alter table public.schedule_bookings drop constraint if exists schedule_bookings_person_chk;
alter table public.schedule_bookings
  add constraint schedule_bookings_person_chk check (user_id is not null or client_id is not null);

-- Разово: карточки для записей из приложения.
update public.schedule_bookings b
   set client_id = c.id
  from public.clients c
 where b.client_id is null
   and c.user_id = b.user_id
   and c.studio_id = b.studio_id;

create index if not exists schedule_bookings_client_idx on public.schedule_bookings(client_id);
-- Один человек — одна запись на занятие (как unique(entry_id, user_id) у приложения).
create unique index if not exists schedule_bookings_entry_client_uniq
  on public.schedule_bookings(entry_id, client_id) where client_id is not null;

alter table public.bookings_log add column if not exists client_id uuid;
create index if not exists bookings_log_client_idx on public.bookings_log(client_id);

-- 2. user_id <-> client_id при вставке и правке записи ------------------------

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
     where c.user_id = new.user_id and c.studio_id = new.studio_id
     order by c.created_at
     limit 1;
  elsif new.user_id is null and new.client_id is not null then
    select c.user_id into new.user_id from public.clients c where c.id = new.client_id;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_link_person_biu on public.schedule_bookings;
create trigger schedule_bookings_link_person_biu
  before insert or update of user_id, client_id on public.schedule_bookings
  for each row execute function public.schedule_bookings_link_person();

-- 3. Журнал: client_id и данные клиента без приложения ----------------------
-- Срабатывает после schedule_bookings_log_aiu (триггеры одного события идут по
-- имени): тот пишет строку журнала, этот дописывает карточку.

create or replace function public.bookings_log_fill_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
begin
  if new.client_id is null then
    return new;
  end if;
  select * into v_client from public.clients where id = new.client_id;
  update public.bookings_log
     set client_id = new.client_id,
         user_id = coalesce(user_id, new.user_id),
         client_first_name = coalesce(client_first_name, v_client.first_name),
         client_last_name = coalesce(client_last_name, v_client.last_name),
         client_full_name = coalesce(client_full_name, v_client.full_name),
         client_phone = coalesce(client_phone, v_client.phone),
         client_email = coalesce(client_email, v_client.email)
   where booking_id = new.id;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_log_client_aiu on public.schedule_bookings;
create trigger schedule_bookings_log_client_aiu
  after insert or update on public.schedule_bookings
  for each row execute function public.bookings_log_fill_client();

-- Разово: client_id у прежних строк журнала.
update public.bookings_log l
   set client_id = b.client_id
  from public.schedule_bookings b
 where l.booking_id = b.id and l.client_id is null and b.client_id is not null;
update public.bookings_log l
   set client_id = c.id
  from public.clients c
 where l.client_id is null and l.user_id is not null
   and c.user_id = l.user_id and c.studio_id = l.studio_id;

-- 4. «Последний визит» клиента без приложения ------------------------------
-- Прежний триггер ищет карточку по user_id; у клиента без приложения его нет.

create or replace function public.update_last_visit_by_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
begin
  if new.status = 'attended' and old.status is distinct from 'attended'
     and new.client_id is not null then
    select se.starts_at::date into v_date from public.schedule_entries se where se.id = new.entry_id;
    if v_date is not null then
      update public.clients
         set last_visit_date = greatest(coalesce(last_visit_date, v_date), v_date)
       where id = new.client_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_last_visit_client on public.schedule_bookings;
create trigger schedule_bookings_last_visit_client
  after update on public.schedule_bookings
  for each row execute function public.update_last_visit_by_client();

-- 5. Карточка привязалась к приложению — записи тоже ------------------------

create or replace function public.clients_link_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null and old.user_id is null then
    update public.schedule_bookings set user_id = new.user_id
     where client_id = new.id and user_id is null
       -- unique(entry_id, user_id): если человек уже записан из приложения,
       -- админскую запись не трогаем.
       and not exists (
         select 1 from public.schedule_bookings o
          where o.entry_id = schedule_bookings.entry_id and o.user_id = new.user_id
       );
    update public.bookings_log set user_id = new.user_id
     where client_id = new.id and user_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_link_bookings_au on public.clients;
create trigger clients_link_bookings_au
  after update of user_id on public.clients
  for each row execute function public.clients_link_bookings();

-- 6. Кто куда может записать -------------------------------------------------
-- Групповое — все (клиент сам или сотрудник); персональное — только сотрудник
-- студии; прочая активность — никто (там нет участников).

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

-- 7. Запись клиента администратором -----------------------------------------
-- Ответ как у остальных RPC записей: { ok, reason }. Места считает так же, как
-- book_schedule_entry: вместимость занятия или тренировки, пусто/0 — без лимита.

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
  if v_has_row and v_existing.status in ('booked', 'attended') then
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

notify pgrst, 'reload schema';
