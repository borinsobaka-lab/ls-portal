-- ============================================================================
-- Мобильное приложение — по клубам (решение владельца 2026-10-11).
--
-- Отменяет «приложение общее для всех студий» (2026-10-10_app_content_shared.sql):
--
-- 1) Новости, услуги, пуш-уведомления — studio_ids uuid[]: в каких студиях
--    запись показывается (новости, услуги) или кому уходит (пуши). Старые
--    записи получают ВСЕ студии — клиенты видят то же, что и до миграции.
--    Прежний studio_id не используется (остаётся историей).
--    Сотрудник выбирает только студии, где у него есть роль (is_trainer):
--      - видит и правит запись, если в ней есть хоть одна его студия;
--      - добавлять и убирать может только свои студии (триггер
--        app_content_studios_guard), чужие в записи остаются как есть;
--      - удаляет запись, только если все её студии — его.
--    Плюс раздел рейки «Мобильное приложение» (has_admin_section 'app'), как
--    раньше. Чтение новостей и услуг для клиентов — публичное, как было.
--    Удалённая студия убирается из списков; запись без студий удаляется.
--
-- 2) «Контакты и правила» — своя строка на студию: studio_app_settings
--    (ссылки кнопок главного экрана, срок отмены записи). Заполняется из
--    общего club_settings — у клиентов ничего не меняется. Чтение публичное
--    (как club_settings), правка — раздел 'app' + роль в этой студии.
--
-- 3) Установка приложения (иконка и подпись PWA) — своя у каждого клиентского
--    приложения: app_install_settings, строка на формат студий
--    (subscription — app.base40.fit, packages — pack.base40.fit). Заполняется
--    из club_settings.app_name/app_icon_path (2026-10-11_app_install_settings.sql,
--    те колонки больше не читаются). Правка — раздел 'app' + роль хоть в одной
--    студии этого формата.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- Хелперы: все / хоть одна из студий — студии сотрудника. security definer,
-- как is_trainer: читают user_roles в обход RLS.
create or replace function public.staff_has_all_studios(_user_id uuid, _studio_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(cardinality(_studio_ids), 0) > 0
     and not exists (
       select 1 from unnest(_studio_ids) s where not public.is_trainer(_user_id, s)
     )
$$;

create or replace function public.staff_has_any_studio(_user_id uuid, _studio_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from unnest(_studio_ids) s where public.is_trainer(_user_id, s))
$$;

-- Проверка списка студий при записи из админки. Внутренние правки (из
-- других триггеров — удаление студии) и сервисный ключ (auth.uid() пуст)
-- не проверяются.
create or replace function public.app_content_studios_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed uuid[];
begin
  new.studio_ids := array(select distinct s from unnest(new.studio_ids) s where s is not null order by s);

  if pg_trigger_depth() > 1 or auth.uid() is null then
    return new;
  end if;

  if cardinality(new.studio_ids) = 0 then
    raise exception 'Выберите хотя бы один клуб' using errcode = '22023';
  end if;

  if tg_op = 'INSERT' then
    v_changed := new.studio_ids;
  else
    -- Добавленные и убранные студии.
    v_changed := array(
      select s from unnest(new.studio_ids) s where not (s = any(old.studio_ids))
      union
      select s from unnest(old.studio_ids) s where not (s = any(new.studio_ids))
    );
  end if;

  if exists (select 1 from unnest(v_changed) s where not public.is_trainer(auth.uid(), s)) then
    raise exception 'Можно выбирать только клубы, к которым у вас есть доступ'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

do $$
declare
  t text;
  v_all uuid[];
begin
  select coalesce(array_agg(id order by created_at, id), '{}') into v_all from public.studios;

  foreach t in array array['news', 'services', 'push_notifications'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'Таблицы % нет — пропускаю', t;
      continue;
    end if;

    execute format(
      'alter table public.%I add column if not exists studio_ids uuid[] not null default ''{}''', t);
    -- Было «общее для всех студий» — так и остаётся, но уже явно.
    execute format('update public.%I set studio_ids = $1 where cardinality(studio_ids) = 0', t)
      using v_all;
    execute format(
      'create index if not exists %I on public.%I using gin (studio_ids)', t || '_studio_ids_idx', t);

    execute format('drop trigger if exists app_content_studios_guard on public.%I', t);
    execute format(
      'create trigger app_content_studios_guard before insert or update of studio_ids on public.%I '
      || 'for each row execute function public.app_content_studios_guard()', t);

    -- Правка: раздел «Мобильное приложение» + свои студии (см. шапку).
    execute format('drop policy if exists %I on public.%I', t || ' staff write', t);
    execute format('drop policy if exists %I on public.%I', t || ' app insert', t);
    execute format('drop policy if exists %I on public.%I', t || ' app update', t);
    execute format('drop policy if exists %I on public.%I', t || ' app delete', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ('
      || 'public.has_admin_section(auth.uid(), ''app'') '
      || 'and public.staff_has_all_studios(auth.uid(), studio_ids))',
      t || ' app insert', t);
    -- with check без «своей студии»: убрать из записи все свои студии можно
    -- (запись остаётся у чужих), что именно поменялось — проверяет триггер.
    execute format(
      'create policy %I on public.%I for update to authenticated using ('
      || 'public.has_admin_section(auth.uid(), ''app'') '
      || 'and public.staff_has_any_studio(auth.uid(), studio_ids)) '
      || 'with check (public.has_admin_section(auth.uid(), ''app''))',
      t || ' app update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ('
      || 'public.has_admin_section(auth.uid(), ''app'') '
      || 'and public.staff_has_all_studios(auth.uid(), studio_ids))',
      t || ' app delete', t);
  end loop;

  -- Пуши клиенты не читают: чтение — тем же сотрудникам, что и правка.
  if to_regclass('public.push_notifications') is not null then
    drop policy if exists "push_notifications app select" on public.push_notifications;
    create policy "push_notifications app select" on public.push_notifications
      for select to authenticated
      using (
        public.has_admin_section(auth.uid(), 'app')
        and public.staff_has_any_studio(auth.uid(), studio_ids)
      );
  end if;
end;
$$;

-- Удалённая студия уходит из списков; запись без студий удаляется.
create or replace function public.studios_app_content_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  foreach t in array array['news', 'services', 'push_notifications'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format(
      'update public.%I set studio_ids = array_remove(studio_ids, $1) where $1 = any(studio_ids)', t)
      using old.id;
    execute format('delete from public.%I where cardinality(studio_ids) = 0', t);
  end loop;
  return old;
end;
$$;

drop trigger if exists studios_app_content_cleanup on public.studios;
create trigger studios_app_content_cleanup after delete on public.studios
  for each row execute function public.studios_app_content_cleanup();

-- 2. «Контакты и правила» по студиям ------------------------------------------

create table if not exists public.studio_app_settings (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  write_url text,
  call_url text,
  feedback_url text,
  cancel_booking_minutes integer not null default 180 check (cancel_booking_minutes >= 0),
  updated_at timestamptz not null default now()
);

grant select on public.studio_app_settings to anon, authenticated;
grant insert, update, delete on public.studio_app_settings to authenticated;
grant all on public.studio_app_settings to service_role;

alter table public.studio_app_settings enable row level security;

drop policy if exists "studio_app_settings read" on public.studio_app_settings;
create policy "studio_app_settings read" on public.studio_app_settings
  for select to anon, authenticated using (true);

drop policy if exists "studio_app_settings write" on public.studio_app_settings;
create policy "studio_app_settings write" on public.studio_app_settings
  for all to authenticated
  using (
    public.has_admin_section(auth.uid(), 'app') and public.is_trainer(auth.uid(), studio_id)
  )
  with check (
    public.has_admin_section(auth.uid(), 'app') and public.is_trainer(auth.uid(), studio_id)
  );

do $$
begin
  if to_regclass('public.club_settings') is not null then
    insert into public.studio_app_settings
      (studio_id, write_url, call_url, feedback_url, cancel_booking_minutes)
    select s.id, cs.write_url, cs.call_url, cs.feedback_url,
           coalesce(cs.cancel_booking_minutes, 180)
      from public.studios s
      left join public.club_settings cs on cs.id = true
    on conflict (studio_id) do nothing;
  else
    insert into public.studio_app_settings (studio_id)
    select id from public.studios
    on conflict (studio_id) do nothing;
  end if;
end;
$$;

-- 3. Установка приложения — по формату (у каждого приложения своя) ------------

create table if not exists public.app_install_settings (
  format text primary key check (format in ('subscription', 'packages')),
  app_name text check (app_name is null or char_length(app_name) between 1 and 30),
  app_icon_path text,
  updated_at timestamptz not null default now()
);

grant select on public.app_install_settings to anon, authenticated;
grant insert, update, delete on public.app_install_settings to authenticated;
grant all on public.app_install_settings to service_role;

alter table public.app_install_settings enable row level security;

drop policy if exists "app_install_settings read" on public.app_install_settings;
create policy "app_install_settings read" on public.app_install_settings
  for select to anon, authenticated using (true);

drop policy if exists "app_install_settings write" on public.app_install_settings;
create policy "app_install_settings write" on public.app_install_settings
  for all to authenticated
  using (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = app_install_settings.format and public.is_trainer(auth.uid(), s.id)
    )
  )
  with check (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = app_install_settings.format and public.is_trainer(auth.uid(), s.id)
    )
  );

do $$
declare
  v_name text;
  v_icon text;
begin
  if to_regclass('public.club_settings') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'club_settings'
          and column_name = 'app_name'
     ) then
    execute 'select app_name, app_icon_path from public.club_settings where id = true'
      into v_name, v_icon;
  end if;
  insert into public.app_install_settings (format, app_name, app_icon_path)
  values ('subscription', v_name, v_icon), ('packages', v_name, v_icon)
  on conflict (format) do nothing;
end;
$$;

notify pgrst, 'reload schema';
