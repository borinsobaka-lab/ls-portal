-- ============================================================================
-- Правки приложения пакетных студий (2026-10-12).
--
-- 1. Номенклатура: тег справа от названия (текст и вид — бледный / яркий) и
--    блок «В подарок» (текст с форматированием) — «Номенклатуры» в админке,
--    карточка пакета в приложении. Читаются прежними политиками memberships.
-- 2. Аватарка клиента: загрузка в свою папку {uid}/ бакета avatars.
--    db/storage_avatars.sql (до переезда) написан с несуществующим в Postgres
--    `create policy if not exists` — на self-hosted инстансе этих политик нет,
--    и загрузка из приложения падала на RLS (после 2026-10-07 в папках
--    клиентов ни одного нового файла). Здесь же — «clients self update» и
--    защита служебных полей (как в db/client_app_fixes.sql): без политики
--    ссылка на фото не сохранялась в карточку.
-- 3. Калории: снимок калорий (bookings_log_fill_calories, db/stats_stage2.sql)
--    ставился только внутри mark_booking_attended той версии, которая на живой
--    базе могла быть заменена (db/bookings_statuses_v2.sql — без калорий).
--    Теперь его ставит триггер на отметку посещения — от версии RPC не
--    зависит; клиент, указавший вес позже, получает калории за прошлые
--    посещения без снимка. Разово — снимок для посещений без калорий.
-- 4. Сравнение со студией в статистике приложения: RPC
--    my_studio_visit_stats() — место клиента по числу посещений за всё время
--    (топ N %) и среднее по студии за текущий месяц. Только агрегаты, при
--    малой выборке (меньше 5 человек) — без процентов.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Тег и подарок в номенклатуре -------------------------------------------

alter table public.memberships add column if not exists tag_text text;
alter table public.memberships add column if not exists tag_style text;
alter table public.memberships add column if not exists gift_text text;

alter table public.memberships drop constraint if exists memberships_tag_style_check;
alter table public.memberships
  add constraint memberships_tag_style_check
  check (tag_style is null or tag_style in ('soft', 'bright'));

comment on column public.memberships.tag_text is
  'Тег справа от названия в приложении («Популярно», «Старт»…); пусто — без тега.';
comment on column public.memberships.tag_style is
  'Вид тега: soft — бледный, bright — яркий (основной цвет).';
comment on column public.memberships.gift_text is
  'Блок «В подарок» в карточке пакета: текст с разметкой (**жирный**, списки).';

-- 2. Аватарка клиента ---------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars own folder insert" on storage.objects;
create policy "avatars own folder insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars own folder update" on storage.objects;
create policy "avatars own folder update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars own folder delete" on storage.objects;
create policy "avatars own folder delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Чтение — публичное (бакет-витрина), как в 2026-10-11_staff_avatars.sql.
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'avatars');

drop policy if exists "clients self update" on public.clients;
create policy "clients self update" on public.clients
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.clients_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Сотруднику студии можно всё. auth.uid() пуст при работе сервис-ключом и
  -- внутри триггеров — там ограничивать тоже нечего.
  if auth.uid() is null or public.is_trainer(auth.uid(), old.studio_id) then
    return new;
  end if;
  -- Клиенту — только свои личные поля.
  new.id                := old.id;
  new.studio_id         := old.studio_id;
  new.user_id           := old.user_id;
  new.notes             := old.notes;
  new.crm_link          := old.crm_link;
  new.registration_date := old.registration_date;
  new.last_visit_date   := old.last_visit_date;
  return new;
end;
$$;

drop trigger if exists clients_guard_self_update on public.clients;
create trigger clients_guard_self_update
  before update on public.clients
  for each row execute function public.clients_guard_self_update();

-- 3. Калории ------------------------------------------------------------------

alter table public.workouts add column if not exists met_value numeric(4,2);
alter table public.bookings_log
  add column if not exists met_value      numeric(4,2),
  add column if not exists weight_at_time numeric(5,1),
  add column if not exists duration_min   int,
  add column if not exists calories       int;

-- Как в db/stats_stage2.sql: ккал = MET × 3,5 × вес / 200 × минуты. MET — с
-- тренировки (у пакетных задаётся вручную), без него — по типу. У занятия без
-- тренировки (персональное, прочая активность) MET нет — калорий нет. Вес — из
-- анкеты учётной записи (user_id; у записи по карточке — её учётная запись).
create or replace function public.bookings_log_fill_calories(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log      public.bookings_log%rowtype;
  v_user     uuid;
  v_met      numeric;
  v_weight   numeric;
  v_duration int;
  v_calories int;
begin
  select * into v_log from public.bookings_log where booking_id = p_booking_id;
  if not found then return; end if;

  select coalesce(w.met_value,
    case w.type::text
      when 'cardio'   then 8.5
      when 'strength' then 7.0
      when 'hybrid'   then 8.0
      when 'recovery' then 2.8
      else 6.0
    end)
    into v_met
  from public.workouts w
  where w.id = v_log.workout_id;

  v_user := v_log.user_id;
  if v_user is null and v_log.client_id is not null then
    select c.user_id into v_user from public.clients c where c.id = v_log.client_id;
  end if;
  if v_user is not null then
    select weight_kg into v_weight from public.member_profiles where user_id = v_user;
  end if;

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

revoke all on function public.bookings_log_fill_calories(uuid) from public, anon;
grant execute on function public.bookings_log_fill_calories(uuid) to authenticated, service_role;

-- Снимок — при переходе записи в «Посетил», какой бы функцией его ни
-- отметили. Имя триггера — после schedule_bookings_log_aiu и
-- schedule_bookings_log_client_aiu (триггеры одного события идут по имени):
-- строка журнала к этому моменту уже со статусом и карточкой.
create or replace function public.schedule_bookings_fill_calories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status::text = 'attended'
     and (tg_op = 'INSERT' or old.status::text is distinct from 'attended') then
    perform public.bookings_log_fill_calories(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_log_kcal_aiu on public.schedule_bookings;
create trigger schedule_bookings_log_kcal_aiu
  after insert or update of status on public.schedule_bookings
  for each row execute function public.schedule_bookings_fill_calories();

-- Вес указан позже посещений — калории за посещения без снимка.
create or replace function public.member_profiles_fill_calories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if new.weight_kg is null
     or (tg_op = 'UPDATE' and old.weight_kg is not distinct from new.weight_kg) then
    return new;
  end if;
  for r in
    select l.booking_id
      from public.bookings_log l
     where l.status = 'attended'
       and l.calories is null
       and l.booking_id is not null
       and (l.user_id = new.user_id
            or l.client_id in (select c.id from public.clients c where c.user_id = new.user_id))
  loop
    perform public.bookings_log_fill_calories(r.booking_id);
  end loop;
  return new;
end;
$$;

drop trigger if exists member_profiles_fill_calories_aiu on public.member_profiles;
create trigger member_profiles_fill_calories_aiu
  after insert or update of weight_kg on public.member_profiles
  for each row execute function public.member_profiles_fill_calories();

-- Разово: посещения без снимка калорий.
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

-- Пересчёт матвью сравнения калорий — только серверу (раньше мог дёрнуть
-- кто угодно, в том числе без входа).
do $$
begin
  if to_regprocedure('public.refresh_client_stats_30d()') is not null then
    execute 'revoke all on function public.refresh_client_stats_30d() from public, anon, authenticated';
    execute 'grant execute on function public.refresh_client_stats_30d() to service_role';
  end if;
end$$;

-- 4. Сравнение со студией -------------------------------------------------------

-- Студия — из карточки вызывающего; человек в журнале — карточка (client_id),
-- без неё — учётная запись. Месяц — по Тбилиси.
create or replace function public.my_studio_visit_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_client      uuid;
  v_studio      uuid;
  v_month_start timestamptz :=
    date_trunc('month', now() at time zone 'Asia/Tbilisi') at time zone 'Asia/Tbilisi';
  v_my_total    int;
  v_my_month    int;
  v_total_n     int;
  v_total_above int;
  v_month_n     int;
  v_month_below int;
  v_month_sum   int;
begin
  if v_uid is null then
    return null;
  end if;
  select c.id, c.studio_id into v_client, v_studio
    from public.clients c
   where c.user_id = v_uid
   order by c.created_at
   limit 1;
  if v_studio is null then
    return null;
  end if;

  with visits as (
    select coalesce(l.client_id::text, 'u:' || l.user_id::text) as person,
           (coalesce(l.client_id = v_client, false) or coalesce(l.user_id = v_uid, false)) as mine,
           l.starts_at
      from public.bookings_log l
     where l.studio_id = v_studio
       and l.status = 'attended'
       and l.starts_at <= now()
       and (l.client_id is not null or l.user_id is not null)
  ),
  me as (
    select count(*)::int as total,
           count(*) filter (where starts_at >= v_month_start)::int as month
      from visits where mine
  ),
  others as (
    select person,
           count(*)::int as total,
           count(*) filter (where starts_at >= v_month_start)::int as month
      from visits where not mine
     group by person
  )
  select me.total, me.month,
         (select count(*) from others)::int,
         (select count(*) from others o where o.total > me.total)::int,
         (select count(*) from others o where o.month > 0)::int,
         (select count(*) from others o where o.month > 0 and o.month < me.month)::int,
         (select coalesce(sum(o.month), 0) from others o)::int
    into v_my_total, v_my_month, v_total_n, v_total_above, v_month_n, v_month_below, v_month_sum
    from me;

  return jsonb_build_object(
    -- Топ N %: место клиента среди всех, кто хоть раз был в студии.
    'total_top_pct', case when v_my_total > 0 and v_total_n + 1 >= 5
      then greatest(1, ceil(100.0 * (v_total_above + 1) / (v_total_n + 1)))::int end,
    'total_cohort', v_total_n + 1,
    -- Среднее за месяц — среди тех, кто в этом месяце уже занимался.
    'month_avg', case when v_month_n + (case when v_my_month > 0 then 1 else 0 end) >= 5
      then round((v_month_sum + v_my_month)::numeric
                 / (v_month_n + (case when v_my_month > 0 then 1 else 0 end)), 1) end,
    'month_better_pct', case when v_my_month > 0 and v_month_n >= 4
      then round(100.0 * v_month_below / v_month_n)::int end,
    'month_cohort', v_month_n + (case when v_my_month > 0 then 1 else 0 end)
  );
end;
$$;

revoke all on function public.my_studio_visit_stats() from public, anon;
grant execute on function public.my_studio_visit_stats() to authenticated;

notify pgrst, 'reload schema';
