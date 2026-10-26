-- ============================================================================
-- Права сотрудников в админке (решение владельца 2026-10-10).
--
-- «Доступы» — учётные записи админки. У каждой теперь настраивается:
--   * студии — по-прежнему роль сотрудника в user_roles (owner/admin/trainer)
--     в каждой студии, куда есть доступ; это граница RLS для данных студии;
--   * разделы рейки — admin_permissions.sections: 'club' («Клуб»),
--     'staff' («Сотрудники»), 'app' («Мобильное приложение»);
--   * разделы клуба в каждой студии — admin_studio_permissions.sections:
--     ключи пунктов меню клуба (dashboard, schedule, clients, …; список —
--     apps/admin/src/lib/admin-access.ts).
-- Нет строки — доступно всё (так остаются сотрудники, заведённые раньше).
-- Владелец (owner хоть в одной студии) видит все разделы рейки; в своей
-- студии — все разделы клуба. Пишет обе таблицы только сервер админки
-- сервис-ключом (раздел «Доступы», только владелец); сотрудник читает свои
-- строки, чтобы показать меню.
--
-- Разделы клуба делят одни и те же таблицы (клиенты нужны и расписанию, и
-- продажам, и кассе), поэтому их скрывает интерфейс (меню и guard роутов), а
-- RLS по-прежнему ограничивает студией. Разделы рейки RLS проверяет: правка
-- справочника сотрудников, реквизиты и ставки — только с разделом
-- «Сотрудники»; новости, услуги, пуши и настройки клуба — только с разделом
-- «Мобильное приложение» (has_admin_section). Заодно закрыта запись в
-- club_settings: политика пускала любого авторизованного, в т.ч. клиентов.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы прав --------------------------------------------------------------
create table if not exists public.admin_permissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sections text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_studio_permissions (
  user_id uuid not null references auth.users(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  sections text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, studio_id)
);
create index if not exists admin_studio_permissions_studio_idx
  on public.admin_studio_permissions(studio_id);

revoke all on public.admin_permissions, public.admin_studio_permissions from anon, authenticated;
grant select on public.admin_permissions, public.admin_studio_permissions to authenticated;
grant all on public.admin_permissions, public.admin_studio_permissions to service_role;

alter table public.admin_permissions enable row level security;
alter table public.admin_studio_permissions enable row level security;

drop policy if exists "admin_permissions own select" on public.admin_permissions;
create policy "admin_permissions own select" on public.admin_permissions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "admin_studio_permissions own select" on public.admin_studio_permissions;
create policy "admin_studio_permissions own select" on public.admin_studio_permissions
  for select to authenticated using (user_id = auth.uid());

-- 2) Проверка раздела рейки ------------------------------------------------------
-- Сотрудник, у которого раздел открыт: владелец, сотрудник без строки прав
-- (заведён до настройки разделов) или раздел отмечен.
create or replace function public.has_admin_section(_user_id uuid, _section text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff(_user_id) and (
    exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
    or not exists (select 1 from public.admin_permissions where user_id = _user_id)
    or exists (
      select 1 from public.admin_permissions
       where user_id = _user_id and _section = any(sections)
    )
  )
$$;

revoke all on function public.has_admin_section(uuid, text) from public, anon;
grant execute on function public.has_admin_section(uuid, text) to authenticated, service_role;

-- 3) Раздел «Сотрудники» ---------------------------------------------------------
-- Имена тренеров читают все сотрудники (расписание) и клиенты своей студии —
-- политика "trainers select" не меняется; правка — только с разделом.
do $$
begin
  if to_regclass('public.trainers') is not null then
    drop policy if exists "trainers staff write" on public.trainers;
    create policy "trainers staff write" on public.trainers
      for all to authenticated
      using (public.has_admin_section(auth.uid(), 'staff'))
      with check (public.has_admin_section(auth.uid(), 'staff'));
  end if;

  if to_regclass('public.trainer_studios') is not null then
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
  end if;

  -- Реквизиты и ставки — и чтение тоже: это зарплатные данные.
  if to_regclass('public.trainer_bank_details') is not null then
    drop policy if exists "trainer_bank_details staff" on public.trainer_bank_details;
    create policy "trainer_bank_details staff" on public.trainer_bank_details
      for all to authenticated
      using (public.has_admin_section(auth.uid(), 'staff'))
      with check (public.has_admin_section(auth.uid(), 'staff'));
  end if;

  if to_regclass('public.trainer_pay_rates') is not null then
    drop policy if exists "trainer_pay_rates staff" on public.trainer_pay_rates;
    create policy "trainer_pay_rates staff" on public.trainer_pay_rates
      for all to authenticated
      using (public.has_admin_section(auth.uid(), 'staff'))
      with check (public.has_admin_section(auth.uid(), 'staff'));
  end if;
end;
$$;

-- 4) Раздел «Мобильное приложение» ----------------------------------------------
-- Новости и услуги читаются публично (свои политики read не меняются).
do $$
declare
  t text;
begin
  foreach t in array array['news', 'services', 'push_notifications'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'Таблицы % нет — пропускаю', t;
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || ' staff write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.has_admin_section(auth.uid(), ''app'')) '
      || 'with check (public.has_admin_section(auth.uid(), ''app''))',
      t || ' staff write', t);
  end loop;

  -- Чтение настроек клуба остаётся публичным ("club_settings read").
  if to_regclass('public.club_settings') is not null then
    drop policy if exists "club_settings write" on public.club_settings;
    create policy "club_settings write" on public.club_settings
      for all to authenticated
      using (public.has_admin_section(auth.uid(), 'app'))
      with check (public.has_admin_section(auth.uid(), 'app'));
  end if;
end;
$$;

notify pgrst, 'reload schema';
