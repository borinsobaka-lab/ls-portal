-- Общие тренировки и номенклатура пакетных клубов (решение владельца 2026-10-13).
--
-- В клубах с пакетами тренировок тренировки и номенклатуры одинаковые во всех
-- клубах: в админке это один список на все пакетные клубы (при смене клуба он
-- не меняется), правка — сразу для всех. Подписочные клубы — как раньше: у
-- каждого свой список.
--
-- Модель: строка workouts / memberships по-прежнему с studio_id — это клуб,
-- где её завели («домашний»; колонка обязательна, на неё опираются триггеры
-- формата и связи). Но для пакетного клуба строка видна и правится из любого
-- пакетного клуба:
--   * catalog_shared(a, b)       — у клубов общий каталог (один и тот же клуб
--                                   или оба пакетные);
--   * can_manage_catalog(uid, s) — сотрудник правит каталог клуба s: роль в
--                                   нём или (s пакетный) в любом пакетном клубе.
-- Клиенты уже видят каталог всех клубов своего формата («… client browse»,
-- 2026-10-11_zzzzzzzzzzz_packages_app_studio.sql); покупка в приложении теперь
-- принимает пакет любого пакетного клуба (sales_client_insert_guard).
-- Удаление пакетного клуба переносит его тренировки и номенклатуру в другой
-- пакетный клуб (триггер studios_packages_catalog_rehome) — иначе каскад унёс
-- бы общие строки, а с тренировками и занятия других клубов.
--
-- Разово: одинаковые тренировки и номенклатуры разных пакетных клубов
-- сливаются в одну строку (packages_merge_catalog): тренировки — по названию
-- (без учёта регистра и пробелов по краям), номенклатуры — по названию, типу,
-- количеству тренировок, персональных, сроку, цене и числу платежей.
-- Занятия, журнал записей, продажи и абонементы клиентов переводятся на
-- оставшуюся строку — в аналитике тренировка больше не двоится по клубам.

create or replace function public.catalog_shared(_a uuid, _b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _a = _b or exists (
    select 1
      from public.studios a
      join public.studios b on b.id = _b
     where a.id = _a
       and a.format = 'packages'
       and b.format = 'packages'
  )
$$;

revoke all on function public.catalog_shared(uuid, uuid) from public;
grant execute on function public.catalog_shared(uuid, uuid) to authenticated, service_role;

create or replace function public.can_manage_catalog(_user_id uuid, _studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_trainer(_user_id, _studio_id) or exists (
    select 1
      from public.studios s
      join public.studios other on other.format = s.format
      join public.user_roles ur
        on ur.studio_id = other.id
       and ur.user_id = _user_id
       and ur.role in ('owner', 'admin', 'trainer')
     where s.id = _studio_id
       and s.format = 'packages'
  )
$$;

revoke all on function public.can_manage_catalog(uuid, uuid) from public;
grant execute on function public.can_manage_catalog(uuid, uuid) to authenticated, service_role;

-- Сотрудники: прежнее «роль в клубе строки» + общий каталог пакетных клубов.
drop policy if exists "workouts trainer write" on public.workouts;
create policy "workouts trainer write" on public.workouts
  for all to authenticated
  using (public.can_manage_catalog(auth.uid(), studio_id))
  with check (public.can_manage_catalog(auth.uid(), studio_id));

drop policy if exists "memberships trainer write" on public.memberships;
create policy "memberships trainer write" on public.memberships
  for all to authenticated
  using (public.can_manage_catalog(auth.uid(), studio_id))
  with check (public.can_manage_catalog(auth.uid(), studio_id));

-- Покупка в приложении: пакет — из каталога клуба покупки (у пакетных — общего).
-- Остальное — как в 2026-10-11_zzzzzzzz_review_fixes.sql.
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
     where m.id = new.membership_id
       and public.catalog_shared(m.studio_id, new.studio_id)
       and m.is_active
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

-- Удаление пакетного клуба: общий каталог переезжает в самый старый из
-- оставшихся пакетных клубов (до каскада — триггер before delete).
create or replace function public.studios_packages_catalog_rehome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  if old.format <> 'packages' then
    return old;
  end if;
  select id into v_target from public.studios
   where format = 'packages' and id <> old.id
   order by created_at, id
   limit 1;
  if v_target is null then
    return old;
  end if;
  update public.workouts set studio_id = v_target where studio_id = old.id;
  update public.memberships set studio_id = v_target where studio_id = old.id;
  return old;
end;
$$;

drop trigger if exists studios_packages_catalog_rehome_bd on public.studios;
create trigger studios_packages_catalog_rehome_bd
  before delete on public.studios
  for each row execute function public.studios_packages_catalog_rehome();

-- Слияние одинаковых строк каталога пакетных клубов. Остаётся самая ранняя
-- строка; пустые поля она берёт у слитых, «показывать в приложении» — если
-- показывалась хоть одна. Повторный вызов ничего не меняет.
create or replace function public.packages_merge_catalog()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Тренировки — по названию.
  create temp table _workout_merge on commit drop as
  select id, keep_id from (
    select w.id,
           first_value(w.id) over (
             partition by lower(btrim(w.name)) order by w.created_at, w.id
           ) as keep_id
      from public.workouts w
      join public.studios s on s.id = w.studio_id and s.format = 'packages'
  ) r
  where id <> keep_id;

  update public.workouts k set
    description = coalesce(k.description, (
      select d.description from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.description is not null order by d.created_at limit 1)),
    photo_url = coalesce(k.photo_url, (
      select d.photo_url from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.photo_url is not null order by d.created_at limit 1)),
    capacity = coalesce(k.capacity, (
      select d.capacity from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.capacity is not null order by d.created_at limit 1)),
    met_value = coalesce(k.met_value, (
      select d.met_value from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.met_value is not null order by d.created_at limit 1)),
    color = coalesce(k.color, (
      select d.color from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.color is not null order by d.created_at limit 1)),
    translations = case when k.translations <> '{}'::jsonb then k.translations else coalesce((
      select d.translations from public.workouts d join _workout_merge m on m.id = d.id
       where m.keep_id = k.id and d.translations <> '{}'::jsonb order by d.created_at limit 1),
      k.translations) end
   where k.id in (select keep_id from _workout_merge);

  update public.schedule_entries e set workout_id = m.keep_id
    from _workout_merge m where e.workout_id = m.id;
  update public.bookings_log l set workout_id = m.keep_id
    from _workout_merge m where l.workout_id = m.id;
  delete from public.workouts where id in (select id from _workout_merge);

  -- Номенклатура — только совпадающая по условиям продажи: пакеты с разной
  -- ценой или сроком остаются разными строками.
  create temp table _membership_merge on commit drop as
  select id, keep_id from (
    select m.id,
           first_value(m.id) over (
             partition by lower(btrim(coalesce(m.name, ''))), m.kind,
                          coalesce(m.visits_count, -1), m.personal_count,
                          coalesce(m.duration_days, -1), m.price, m.max_payments
             order by m.created_at, m.id
           ) as keep_id
      from public.memberships m
      join public.studios s on s.id = m.studio_id and s.format = 'packages'
  ) r
  where id <> keep_id;

  update public.memberships k set
    description = coalesce(k.description, (
      select d.description from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.description is not null order by d.created_at limit 1)),
    tag_text = coalesce(k.tag_text, (
      select d.tag_text from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.tag_text is not null order by d.created_at limit 1)),
    tag_style = coalesce(k.tag_style, (
      select d.tag_style from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.tag_style is not null order by d.created_at limit 1)),
    gift_text = coalesce(k.gift_text, (
      select d.gift_text from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.gift_text is not null order by d.created_at limit 1)),
    translations = case when k.translations <> '{}'::jsonb then k.translations else coalesce((
      select d.translations from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.translations <> '{}'::jsonb order by d.created_at limit 1),
      k.translations) end,
    is_active = k.is_active or exists (
      select 1 from public.memberships d join _membership_merge m on m.id = d.id
       where m.keep_id = k.id and d.is_active)
   where k.id in (select keep_id from _membership_merge);

  update public.sales s set membership_id = m.keep_id
    from _membership_merge m where s.membership_id = m.id;
  update public.client_memberships c set membership_id = m.keep_id
    from _membership_merge m where c.membership_id = m.id;
  delete from public.memberships where id in (select id from _membership_merge);

  drop table _workout_merge;
  drop table _membership_merge;
end;
$$;

revoke all on function public.packages_merge_catalog() from public, anon, authenticated;
grant execute on function public.packages_merge_catalog() to service_role;

select public.packages_merge_catalog();

notify pgrst, 'reload schema';
