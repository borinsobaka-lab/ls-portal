-- ============================================================================
-- Пользователи портала, роли и доступы (решение владельца 2026-10-25;
-- устройство, решения и источники — ACCESS.md).
--
-- Раньше доступ сотрудника задавался руками в «Доступах»: роль в каждом
-- клубе (user_roles), разделы рейки (admin_permissions), разделы клуба
-- (admin_studio_permissions), базы знаний (kb_grants), «Академия»
-- (acad_staff). А «владелец хоть одного клуба» автоматически становился
-- администратором всей сети: базы знаний, Академия, все разделы. Для сети
-- Lady Stretch (100+ клубов, партнёры — владельцы своих клубов, 40+
-- сотрудников УК без клуба) так нельзя.
--
-- Теперь:
--   * Сеть: бренды (org_brands) → клубы (studios.brand_id, ownership,
--     city).
--   * Оргструктура УК: подразделения деревом (org_units, руководители и
--     заместители — org_unit_members, человек может быть в нескольких),
--     должности (org_positions).
--   * Пользователь портала — portal_users (тип, должность, статус, «доступ
--     до»). Сотрудник УК может не иметь клуба вовсе.
--   * Роль — набор прав из каталога access_permissions (матрица в карточке
--     роли), личные права человека — его «личная» роль.
--   * Назначение роли (access_assignments): кому — человеку, подразделению
--     (с подразделениями ниже, всем или только руководителям) или
--     должности; где — во всех клубах, в клубах брендов (и будущих) или в
--     выбранных; когда — с / до (временный и демо-доступ).
--
-- Права вычисляются (access_compile) и записываются в прежние таблицы,
-- на которых стоят RLS и интерфейс: user_roles, admin_permissions,
-- admin_studio_permissions, kb_grants (уровень базы), acad_staff, плюс
-- сетевые права — access_user_rights. Поэтому все прежние политики и
-- быстрые массивы (auth_staff_studio_ids и т. п.) работают как раньше, а
-- руками в этих таблицах права больше не правятся: изменение роли,
-- назначения, структуры или статуса помечает затронутых людей
-- (access_dirty) и пересчитывает их в той же транзакции.
--
-- «Владелец клуба» больше не администратор сети: kb_is_admin, разделы
-- рейки и Академия смотрят на сетевые права (kb.admin, academy.admin,
-- portal.admin). У людей вне новой модели (нет строки access_user_rights)
-- прежние правила остаются — так живут тесты и сервисные записи.
--
-- Текущие доступы переносятся без изменений (access_import_legacy):
-- владелец всех клубов — «Суперадминистратор»; прочие — роли
-- «… (перенесено)» по клубам и личные права.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Сеть клубов -------------------------------------------------------------
create table if not exists public.org_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  short_name text check (short_name is null or char_length(short_name) <= 12),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists org_brands_name_uidx on public.org_brands (lower(btrim(name)));

alter table public.studios add column if not exists brand_id uuid
  references public.org_brands(id) on delete set null;
alter table public.studios add column if not exists ownership text not null default 'own';
alter table public.studios add column if not exists city text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studios_ownership_check') then
    alter table public.studios add constraint studios_ownership_check
      check (ownership in ('own', 'franchise'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studios_city_check') then
    alter table public.studios add constraint studios_city_check
      check (city is null or char_length(city) <= 80);
  end if;
end;
$$;
create index if not exists studios_brand_idx on public.studios (brand_id);
-- У studios чтение — грантом колонок (публичная таблица).
grant select (brand_id, ownership, city) on public.studios to anon, authenticated;

-- Бренды сети — стартовый набор; клубы раскладываются по формату приложения.
insert into public.org_brands (name, short_name, color, sort_order)
select v.name, v.short, v.color, v.ord
  from (values ('Lady Stretch', 'LS', '#e5007e', 1),
               ('Lady Jump', 'LJ', '#7c3aed', 2),
               ('Base40', 'B40', '#f763fc', 3)) v(name, short, color, ord)
 where not exists (select 1 from public.org_brands);
update public.studios s
   set brand_id = (select b.id from public.org_brands b
                    where b.name = case s.format when 'packages' then 'Lady Stretch' else 'Base40' end)
 where s.brand_id is null;

-- 2) Оргструктура ------------------------------------------------------------
create table if not exists public.org_units (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.org_units(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  sort_order integer not null default 0,
  -- Подразделения выше (от корня), ставит триггер.
  path uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create index if not exists org_units_parent_idx on public.org_units (parent_id, sort_order);
create index if not exists org_units_path_idx on public.org_units using gin (path);

create table if not exists public.org_positions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists org_positions_name_uidx on public.org_positions (lower(btrim(name)));

-- 3) Пользователи портала --------------------------------------------------
create table if not exists public.portal_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- УК / партнёр / сотрудник клуба / подрядчик / служебный; null — не указан.
  user_type text check (user_type in ('hq', 'partner', 'studio', 'contractor', 'service')),
  position_id uuid references public.org_positions(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'blocked')),
  -- Последний день доступа (включительно, по Тбилиси) — демо и временный доступ.
  access_until date,
  note text check (note is null or char_length(note) <= 2000),
  blocked_at timestamptz,
  blocked_by uuid references auth.users(id) on delete set null,
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index if not exists portal_users_position_idx on public.portal_users (position_id);

create table if not exists public.org_unit_members (
  unit_id uuid not null references public.org_units(id) on delete cascade,
  user_id uuid not null references public.portal_users(user_id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('head', 'deputy', 'member')),
  created_at timestamptz not null default now(),
  primary key (unit_id, user_id)
);
create index if not exists org_unit_members_user_idx on public.org_unit_members (user_id);

-- 4) Каталог прав ------------------------------------------------------------
-- scope: studio — действует в клубах назначения; network — на всю сеть.
-- levels: допустимые уровни ('on' — просто включено). target: kb_base —
-- право на конкретную базу знаний (null — на все, и на будущие).
create table if not exists public.access_permissions (
  key text primary key,
  block text not null,
  label text not null,
  hint text,
  scope text not null check (scope in ('studio', 'network')),
  levels text[] not null default '{on}',
  target text check (target in ('kb_base')),
  sort_order integer not null default 0
);

insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('studio.tier', 'club', 'Доступ к данным клуба',
   'Сотрудник и администратор видят и ведут данные клуба (клиенты, расписание, продажи…), владелец клуба — ещё настройки клуба, удаление, перенос из 1С.',
   'studio', '{trainer,admin,owner}', null, 10),
  ('club.all', 'club', 'Все разделы клуба', 'И те, что появятся позже.', 'studio', '{on}', null, 20),
  ('club.dashboard', 'club', 'Дашборд', null, 'studio', '{on}', null, 30),
  ('club.schedule', 'club', 'Расписание', null, 'studio', '{on}', null, 31),
  ('club.clients', 'club', 'Клиенты', null, 'studio', '{on}', null, 32),
  ('club.client-memberships', 'club', 'Абонементы', null, 'studio', '{on}', null, 33),
  ('club.sales', 'club', 'Продажи', null, 'studio', '{on}', null, 34),
  ('club.other-sales', 'club', 'Прочие продажи', null, 'studio', '{on}', null, 35),
  ('club.bookings-log', 'club', 'История записей', null, 'studio', '{on}', null, 36),
  ('club.autorenew-cancellations', 'club', 'Отмены автопродления', null, 'studio', '{on}', null, 37),
  ('club.cash', 'club', 'Касса', null, 'studio', '{on}', null, 38),
  ('club.feedback', 'club', 'Обратная связь', null, 'studio', '{on}', null, 39),
  ('club.requests', 'club', 'Заявки', null, 'studio', '{on}', null, 40),
  ('club.nps', 'club', 'NPS-опросы', null, 'studio', '{on}', null, 41),
  ('club.workouts', 'club', 'Тренировки', null, 'studio', '{on}', null, 42),
  ('club.memberships', 'club', 'Номенклатуры', null, 'studio', '{on}', null, 43),
  ('club.promocodes', 'club', 'Промокоды', null, 'studio', '{on}', null, 44),
  ('staff.directory', 'sections', 'Сотрудники',
   'Справочник сотрудников, зарплаты, график, ставки (общие для клубов).', 'network', '{on}', null, 100),
  ('app.content', 'sections', 'Мобильное приложение',
   'Новости, услуги, пуши, тексты приложения — в клубах, где есть доступ к данным.', 'network', '{on}', null, 110),
  ('scripts', 'sections', 'Скрипты LS', 'Просмотр — читать и копировать; правка — менять скрипты и настройки.',
   'network', '{view,edit}', null, 120),
  ('kb.base', 'knowledge', 'База знаний', 'Просмотр или правка статей базы.', 'network', '{view,edit}', 'kb_base', 200),
  ('kb.admin', 'knowledge', 'Администратор баз знаний',
   'Все базы: создаёт базы, настройки, аналитика, корзина.', 'network', '{on}', null, 210),
  ('academy.create', 'knowledge', 'Академия: создаёт курсы', 'Конструктор, назначения, отчёт.', 'network', '{on}', null, 220),
  ('academy.review', 'knowledge', 'Академия: проверяет ответы', 'Свободные ответы и комментарии к ошибкам.', 'network', '{on}', null, 230),
  ('academy.admin', 'knowledge', 'Администратор Академии', 'Все курсы и права Академии.', 'network', '{on}', null, 240),
  ('users.manage', 'admin', 'Управляет пользователями',
   'Добавляет людей и выдаёт им роли в клубах назначения — не больше своих прав. «Во всех клубах» — все пользователи портала.',
   'studio', '{on}', null, 300),
  ('roles.manage', 'admin', 'Создаёт и меняет роли',
   'Доверенное право: через роли выдаются любые права, кроме суперадминистратора.', 'network', '{on}', null, 310),
  ('structure.manage', 'admin', 'Оргструктура и сеть',
   'Подразделения, руководители, должности, бренды и данные клубов.', 'network', '{on}', null, 320),
  ('studios.create', 'admin', 'Создаёт клубы', null, 'network', '{on}', null, 330),
  ('audit.view', 'admin', 'Журнал изменений доступа', null, 'network', '{on}', null, 340),
  ('portal.admin', 'admin', 'Суперадминистратор',
   'Все права в сети, включая назначение суперадминистраторов.', 'network', '{on}', null, 350)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

-- 5) Роли и назначения -------------------------------------------------------
create table if not exists public.access_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  -- Роль из стартового набора (ключ, чтобы найти её в миграциях).
  system_key text unique,
  -- Права роли не меняются (суперадминистратор — защита от потери доступа).
  locked boolean not null default false,
  -- Личная роль человека — «Личные права» в его карточке.
  personal_user_id uuid unique references public.portal_users(user_id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists access_roles_name_uidx
  on public.access_roles (lower(btrim(name))) where personal_user_id is null;

create table if not exists public.access_role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.access_roles(id) on delete cascade,
  perm_key text not null references public.access_permissions(key) on delete cascade,
  target_id uuid,
  level text not null default 'on'
);
create unique index if not exists access_role_permissions_uidx
  on public.access_role_permissions (role_id, perm_key, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.access_assignments (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.access_roles(id) on delete cascade,
  subject_type text not null check (subject_type in ('user', 'unit', 'position')),
  user_id uuid references public.portal_users(user_id) on delete cascade,
  unit_id uuid references public.org_units(id) on delete cascade,
  position_id uuid references public.org_positions(id) on delete cascade,
  -- Подразделение: все сотрудники или только руководители и заместители;
  -- с подразделениями ниже по дереву («с подчинёнными»).
  unit_members text not null default 'all' check (unit_members in ('all', 'heads')),
  with_subunits boolean not null default true,
  -- Где действуют права роли «в клубе»: все клубы (и новые), клубы брендов
  -- (и новые клубы бренда) или выбранные клубы.
  scope_type text not null default 'all' check (scope_type in ('all', 'brands', 'studios')),
  scope_ids uuid[] not null default '{}',
  valid_from timestamptz,
  valid_until timestamptz,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  check (
    (subject_type = 'user' and user_id is not null and unit_id is null and position_id is null)
    or (subject_type = 'unit' and unit_id is not null and user_id is null and position_id is null)
    or (subject_type = 'position' and position_id is not null and user_id is null and unit_id is null)
  ),
  check (valid_from is null or valid_until is null or valid_until > valid_from)
);
create index if not exists access_assignments_role_idx on public.access_assignments (role_id);
create index if not exists access_assignments_user_idx on public.access_assignments (user_id) where user_id is not null;
create index if not exists access_assignments_unit_idx on public.access_assignments (unit_id) where unit_id is not null;
create index if not exists access_assignments_position_idx on public.access_assignments (position_id) where position_id is not null;

-- 6) Вычисленные права и служебное ---------------------------------------------
create table if not exists public.access_user_rights (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Вход в админку: активен и есть хоть одно действующее назначение.
  portal boolean not null default false,
  -- Сетевые права (portal.admin раскрыт во все) и users.manage.
  rights text[] not null default '{}',
  -- users.manage: во всех клубах (все пользователи портала) или в этих.
  manage_all boolean not null default false,
  manage_studio_ids uuid[] not null default '{}',
  -- Итог целиком — для карточки пользователя и журнала.
  effective jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Кого пересчитать. Строку вставляют триггеры; отложенный триггер
-- пересчитывает при фиксации, RPC — сразу (access_flush).
create table if not exists public.access_dirty (
  user_id uuid primary key
);

create table if not exists public.access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_user uuid,
  target_role uuid,
  summary text,
  details jsonb not null default '{}'
);
create index if not exists access_log_at_idx on public.access_log (at desc);
create index if not exists access_log_user_idx on public.access_log (target_user, at desc);

-- 7) Доступ к таблицам ---------------------------------------------------------
-- Пишут только RPC (security definer) — из браузера читаются по политикам.
revoke all on public.org_brands, public.org_units, public.org_positions, public.org_unit_members,
  public.portal_users, public.access_permissions, public.access_roles,
  public.access_role_permissions, public.access_assignments, public.access_user_rights,
  public.access_dirty, public.access_log from anon, authenticated;
grant select on public.org_brands, public.org_units, public.org_positions, public.org_unit_members,
  public.portal_users, public.access_permissions, public.access_roles,
  public.access_role_permissions, public.access_assignments, public.access_user_rights
  to authenticated;
grant all on public.org_brands, public.org_units, public.org_positions, public.org_unit_members,
  public.portal_users, public.access_permissions, public.access_roles,
  public.access_role_permissions, public.access_assignments, public.access_user_rights,
  public.access_dirty, public.access_log to service_role;

alter table public.org_brands enable row level security;
alter table public.org_units enable row level security;
alter table public.org_positions enable row level security;
alter table public.org_unit_members enable row level security;
alter table public.portal_users enable row level security;
alter table public.access_permissions enable row level security;
alter table public.access_roles enable row level security;
alter table public.access_role_permissions enable row level security;
alter table public.access_assignments enable row level security;
alter table public.access_user_rights enable row level security;
alter table public.access_dirty enable row level security;
alter table public.access_log enable row level security;

-- 8) Базовые хелперы -------------------------------------------------------------
create or replace function public.access_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Tbilisi')::date
$$;

create or replace function public.access_tier_rank(_tier text)
returns integer
language sql
immutable
as $$
  select case _tier when 'owner' then 3 when 'admin' then 2 when 'trainer' then 1 else 0 end
$$;

-- В новой модели ли человек (права вычисляет access_compile).
create or replace function public.access_is_managed(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.access_user_rights where user_id = _user_id)
$$;

-- Право человека: сетевое право или users.manage (portal.admin раскрыт).
create or replace function public.access_has_right(_user_id uuid, _right text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.access_user_rights r
     where r.user_id = _user_id and r.portal and _right = any (r.rights)
  )
$$;

-- Права вызывающего — для политик: `(select auth_access_rights()) && array[…]`.
create or replace function public.auth_access_rights()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select r.rights from public.access_user_rights r
                    where r.user_id = auth.uid() and r.portal), '{}')
$$;

-- Пользователь админки: сотрудник клуба (роль в user_roles) или человек
-- портала с действующими назначениями (сотрудник УК может быть без клуба).
create or replace function public.is_portal_user(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff(_user_id)
      or exists (select 1 from public.access_user_rights r where r.user_id = _user_id and r.portal)
$$;

-- Клубы области назначения.
create or replace function public.access_scope_studios(_scope_type text, _scope_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.id order by s.created_at), '{}')
    from public.studios s
   where case _scope_type
           when 'all' then true
           when 'brands' then s.brand_id = any (_scope_ids)
           else s.id = any (_scope_ids)
         end
$$;

-- Назначения, которые действуют на человека сейчас (без проверки статуса).
create or replace function public.access_applicable(_user_id uuid, _at timestamptz default now())
returns setof public.access_assignments
language sql
stable
security definer
set search_path = public
as $$
  select a.*
    from public.access_assignments a
   where (a.valid_from is null or a.valid_from <= _at)
     and (a.valid_until is null or a.valid_until > _at)
     and (
       (a.subject_type = 'user' and a.user_id = _user_id)
       or (a.subject_type = 'position'
           and a.position_id = (select pu.position_id from public.portal_users pu
                                 where pu.user_id = _user_id))
       or (a.subject_type = 'unit' and exists (
             select 1
               from public.org_unit_members m
               join public.org_units u on u.id = m.unit_id
              where m.user_id = _user_id
                and (a.unit_members = 'all' or m.member_role in ('head', 'deputy'))
                and (u.id = a.unit_id or (a.with_subunits and a.unit_id = any (u.path)))))
     )
$$;

-- Кого касается назначение (без срока) — для пересчёта и Академии.
create or replace function public.access_assignment_user_ids(
  _subject_type text, _user_id uuid, _unit_id uuid, _position_id uuid,
  _unit_members text, _with_subunits boolean
)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select _user_id where _subject_type = 'user' and _user_id is not null
  union
  select pu.user_id from public.portal_users pu
   where _subject_type = 'position' and pu.position_id = _position_id
  union
  select m.user_id
    from public.org_unit_members m
    join public.org_units u on u.id = m.unit_id
   where _subject_type = 'unit'
     and (_unit_members = 'all' or m.member_role in ('head', 'deputy'))
     and (u.id = _unit_id or (_with_subunits and _unit_id = any (u.path)))
$$;

revoke all on function public.access_is_managed(uuid), public.access_has_right(uuid, text),
  public.auth_access_rights(), public.is_portal_user(uuid) from public, anon;
grant execute on function public.access_is_managed(uuid), public.access_has_right(uuid, text),
  public.auth_access_rights(), public.is_portal_user(uuid), public.access_today(),
  public.access_tier_rank(text) to authenticated, service_role;
revoke all on function public.access_scope_studios(text, uuid[]),
  public.access_applicable(uuid, timestamptz),
  public.access_assignment_user_ids(text, uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- 9) Пересчёт прав (компилятор) -------------------------------------------------
create or replace function public.access_compile(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pu public.portal_users;
  v_active boolean;
  v_rights text[];
  v_admin boolean;
  v_studios jsonb;
  v_rails text[];
  v_kb jsonb;
  v_acad_create boolean;
  v_acad_review boolean;
  v_manage_all boolean;
  v_manage uuid[];
  v_portal boolean;
  v_effective jsonb;
  v_old jsonb;
  v_all_network text[];
begin
  select * into v_pu from public.portal_users where user_id = _user_id;

  if not found then
    -- Убран из портала: снимаем всё, что выдавала модель.
    select effective into v_old from public.access_user_rights where user_id = _user_id;
    if not found then
      return;
    end if;
    delete from public.user_roles
     where user_id = _user_id and role::text in ('owner', 'admin', 'trainer');
    delete from public.admin_permissions where user_id = _user_id;
    delete from public.admin_studio_permissions where user_id = _user_id;
    delete from public.kb_grants
     where subject_type = 'user' and subject_id = _user_id and node_id is null;
    delete from public.acad_staff where user_id = _user_id;
    delete from public.access_user_rights where user_id = _user_id;
    insert into public.access_log (actor_id, action, target_user, summary, details)
    values (auth.uid(), 'effective', _user_id, 'Все права сняты',
            jsonb_build_object('before', v_old, 'after', null));
    return;
  end if;

  v_active := v_pu.status = 'active'
              and (v_pu.access_until is null or v_pu.access_until >= public.access_today());

  select coalesce(array_agg(key order by sort_order), '{}') into v_all_network
    from public.access_permissions
   where scope = 'network' and key not in ('kb.base', 'scripts');

  if to_regclass('pg_temp.access_compile_perms') is null then
    create temp table access_compile_perms (
      scope_type text, scope_ids uuid[], perm_key text, target_id uuid, level text, scope text
    ) on commit drop;
  else
    truncate access_compile_perms;
  end if;
  insert into access_compile_perms
  select a.scope_type, a.scope_ids, rp.perm_key, rp.target_id, rp.level, c.scope
    from public.access_applicable(_user_id) a
    join public.access_role_permissions rp on rp.role_id = a.role_id
    join public.access_permissions c on c.key = rp.perm_key
   where v_active;

  v_portal := v_active and exists (select 1 from public.access_applicable(_user_id));

  -- Сетевые права.
  select coalesce(array_agg(distinct perm_key), '{}') into v_rights
    from access_compile_perms
   where (scope = 'network' and perm_key not in ('kb.base', 'scripts'))
      or perm_key = 'users.manage';
  v_admin := 'portal.admin' = any (v_rights);
  if v_admin then
    v_rights := array(select distinct unnest(v_all_network || array['users.manage']));
  end if;

  -- Клубы: уровень доступа и разделы.
  with ps as (
    select s.sid, p.perm_key, p.level
      from access_compile_perms p
      cross join lateral unnest(public.access_scope_studios(p.scope_type, p.scope_ids)) s(sid)
     where p.scope = 'studio'
  ),
  tiers as (
    select sid, (array['trainer', 'admin', 'owner'])[max(public.access_tier_rank(level))] as tier
      from ps where perm_key = 'studio.tier' group by sid
  )
  select coalesce(jsonb_object_agg(t.sid::text, jsonb_build_object(
           'tier', t.tier,
           'sections', case
             when t.tier = 'owner'
               or exists (select 1 from ps x where x.sid = t.sid and x.perm_key = 'club.all')
               then null
             else coalesce((select jsonb_agg(distinct substr(x.perm_key, 6))
                              from ps x where x.sid = t.sid and x.perm_key like 'club.%'), '[]'::jsonb)
           end)), '{}'::jsonb)
    into v_studios
    from tiers t;

  -- users.manage: где управляет пользователями.
  v_manage_all := v_admin or exists (
    select 1 from access_compile_perms where perm_key = 'users.manage' and scope_type = 'all');
  select coalesce(array_agg(distinct s.sid), '{}') into v_manage
    from access_compile_perms p
    cross join lateral unnest(public.access_scope_studios(p.scope_type, p.scope_ids)) s(sid)
   where p.perm_key = 'users.manage';
  if v_admin then
    v_manage := public.access_scope_studios('all', '{}');
  end if;

  -- Базы знаний (null — все базы, в том числе будущие: новая база пересчитает).
  select coalesce(jsonb_object_agg(k.base_id::text, k.lvl), '{}'::jsonb) into v_kb
    from (
      select b.id as base_id, case when bool_or(p.level = 'edit') then 'edit' else 'view' end as lvl
        from access_compile_perms p
        join public.kb_bases b on p.target_id is null or p.target_id = b.id
       where p.perm_key = 'kb.base'
       group by b.id
    ) k;

  -- Разделы рейки (null — все).
  if v_admin then
    v_rails := null;
  else
    v_rails := array_remove(array[
      case when exists (
        select 1 from jsonb_each(v_studios) e
         where case when e.value->'sections' = 'null'::jsonb then true
                    else jsonb_array_length(e.value->'sections') > 0 end
      ) then 'club' end,
      case when 'staff.directory' = any (v_rights) then 'staff' end,
      case when 'app.content' = any (v_rights) then 'app' end,
      case when exists (select 1 from access_compile_perms where perm_key = 'scripts') then 'scripts' end,
      case when exists (select 1 from access_compile_perms where perm_key = 'scripts' and level = 'edit')
           then 'scripts-edit' end
    ], null);
    if v_rails @> array['club', 'staff', 'app', 'scripts', 'scripts-edit'] then
      v_rails := null;
    end if;
  end if;

  -- Администратору Академии строки acad_staff не нужны (у него всё).
  v_acad_create := 'academy.create' = any (v_rights) and not ('academy.admin' = any (v_rights));
  v_acad_review := 'academy.review' = any (v_rights) and not ('academy.admin' = any (v_rights));

  v_effective := jsonb_build_object(
    'active', v_active,
    'portal', v_portal,
    'rights', to_jsonb(v_rights),
    'rails', to_jsonb(v_rails),
    'studios', v_studios,
    'kb', v_kb,
    'academy', jsonb_build_object('create', v_acad_create, 'review', v_acad_review),
    'manage', jsonb_build_object('all', v_manage_all, 'studios', to_jsonb(v_manage))
  );

  -- Запись в таблицы, на которых стоят RLS и интерфейс — только разница.
  delete from public.user_roles ur
   where ur.user_id = _user_id
     and ur.role::text in ('owner', 'admin', 'trainer')
     and not exists (select 1 from jsonb_each(v_studios) e
                      where e.key::uuid = ur.studio_id and e.value->>'tier' = ur.role::text);
  insert into public.user_roles (user_id, studio_id, role)
  select _user_id, e.key::uuid, (e.value->>'tier')::public.app_role
    from jsonb_each(v_studios) e
   where not exists (select 1 from public.user_roles ur
                      where ur.user_id = _user_id and ur.studio_id = e.key::uuid
                        and ur.role::text = e.value->>'tier')
  on conflict do nothing;

  if v_rails is null then
    delete from public.admin_permissions where user_id = _user_id;
  else
    insert into public.admin_permissions (user_id, sections, updated_at)
    values (_user_id, v_rails, now())
    on conflict (user_id) do update set sections = excluded.sections, updated_at = now()
     where public.admin_permissions.sections is distinct from excluded.sections;
  end if;

  delete from public.admin_studio_permissions sp
   where sp.user_id = _user_id
     and not exists (select 1 from jsonb_each(v_studios) e
                      where e.key::uuid = sp.studio_id and e.value->'sections' <> 'null'::jsonb);
  insert into public.admin_studio_permissions (user_id, studio_id, sections, updated_at)
  select _user_id, e.key::uuid,
         array(select jsonb_array_elements_text(e.value->'sections') order by 1), now()
    from jsonb_each(v_studios) e
   where e.value->'sections' <> 'null'::jsonb
  on conflict (user_id, studio_id) do update set sections = excluded.sections, updated_at = now()
   where public.admin_studio_permissions.sections is distinct from excluded.sections;

  delete from public.kb_grants g
   where g.subject_type = 'user' and g.subject_id = _user_id and g.node_id is null
     and g.level is distinct from (v_kb->>(g.base_id::text));
  insert into public.kb_grants (base_id, subject_type, subject_id, level)
  select e.key::uuid, 'user', _user_id, e.value #>> '{}'
    from jsonb_each(v_kb) e
   where not exists (select 1 from public.kb_grants g
                      where g.subject_type = 'user' and g.subject_id = _user_id
                        and g.node_id is null and g.base_id = e.key::uuid);

  if v_acad_create or v_acad_review then
    insert into public.acad_staff (user_id, can_create, can_review, updated_at)
    values (_user_id, v_acad_create, v_acad_review, now())
    on conflict (user_id) do update
      set can_create = excluded.can_create, can_review = excluded.can_review, updated_at = now()
     where (public.acad_staff.can_create, public.acad_staff.can_review)
           is distinct from (excluded.can_create, excluded.can_review);
  else
    delete from public.acad_staff where user_id = _user_id;
  end if;

  select effective into v_old from public.access_user_rights where user_id = _user_id;
  insert into public.access_user_rights
    (user_id, portal, rights, manage_all, manage_studio_ids, effective, updated_at)
  values (_user_id, v_portal, v_rights, v_manage_all, v_manage, v_effective, now())
  on conflict (user_id) do update
    set portal = excluded.portal, rights = excluded.rights, manage_all = excluded.manage_all,
        manage_studio_ids = excluded.manage_studio_ids, effective = excluded.effective,
        updated_at = now()
   where public.access_user_rights.effective is distinct from excluded.effective;

  if v_old is distinct from v_effective then
    insert into public.access_log (actor_id, action, target_user, summary, details)
    values (auth.uid(), 'effective', _user_id, 'Права пересчитаны',
            jsonb_build_object('before', v_old, 'after', v_effective));
  end if;
end;
$$;

-- Пересчитать помеченных сейчас (RPC зовут в конце).
create or replace function public.access_flush()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_n integer := 0;
begin
  loop
    select user_id into v_uid from public.access_dirty limit 1;
    exit when v_uid is null;
    delete from public.access_dirty where user_id = v_uid;
    perform public.access_compile(v_uid);
    v_n := v_n + 1;
    v_uid := null;
  end loop;
  return v_n;
end;
$$;

-- Отложенный пересчёт при фиксации — для записей в обход RPC (сервер, тесты).
create or replace function public.access_dirty_flush()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.access_dirty where user_id = new.user_id) then
    delete from public.access_dirty where user_id = new.user_id;
    perform public.access_compile(new.user_id);
  end if;
  return null;
end;
$$;
drop trigger if exists access_dirty_flush_aiu on public.access_dirty;
create constraint trigger access_dirty_flush_aiu
  after insert on public.access_dirty
  deferrable initially deferred
  for each row execute function public.access_dirty_flush();

create or replace function public.access_mark(_user_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_dirty (user_id)
  select distinct u from unnest(_user_ids) u where u is not null
  on conflict do nothing
$$;

revoke all on function public.access_compile(uuid), public.access_flush(),
  public.access_mark(uuid[]) from public, anon, authenticated;
grant execute on function public.access_compile(uuid), public.access_flush(),
  public.access_mark(uuid[]) to service_role;

-- 10) Триггеры: кого пересчитать ------------------------------------------------
create or replace function public.access_assignments_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.access_mark(array(select public.access_assignment_user_ids(
      old.subject_type, old.user_id, old.unit_id, old.position_id, old.unit_members, old.with_subunits)));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.access_mark(array(select public.access_assignment_user_ids(
      new.subject_type, new.user_id, new.unit_id, new.position_id, new.unit_members, new.with_subunits)));
  end if;
  return null;
end;
$$;
drop trigger if exists access_assignments_mark_aiud on public.access_assignments;
create trigger access_assignments_mark_aiud
  after insert or update or delete on public.access_assignments
  for each row execute function public.access_assignments_mark();

-- Все, кому выдана роль.
create or replace function public.access_role_user_ids(_role_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct u), '{}')
    from public.access_assignments a
    cross join lateral public.access_assignment_user_ids(
      a.subject_type, a.user_id, a.unit_id, a.position_id, a.unit_members, a.with_subunits) u
   where a.role_id = _role_id
$$;
revoke all on function public.access_role_user_ids(uuid) from public, anon, authenticated;

create or replace function public.access_role_permissions_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.access_permissions;
  v_personal uuid;
begin
  select * into c from public.access_permissions where key = new.perm_key;
  if not (new.level = any (c.levels)) then
    raise exception 'access_bad_level' using errcode = '22023',
      detail = format('%s: %s', new.perm_key, new.level);
  end if;
  if c.target is null and new.target_id is not null then
    raise exception 'access_bad_target' using errcode = '22023';
  end if;
  if c.target = 'kb_base' and new.target_id is not null
     and not exists (select 1 from public.kb_bases where id = new.target_id) then
    raise exception 'access_bad_target' using errcode = '22023';
  end if;
  -- Личные права — только сетевые: права «в клубе» выдаются ролью с клубами.
  select personal_user_id into v_personal from public.access_roles where id = new.role_id;
  if v_personal is not null and c.scope <> 'network' then
    raise exception 'access_personal_network_only' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists access_role_permissions_biu on public.access_role_permissions;
create trigger access_role_permissions_biu
  before insert or update on public.access_role_permissions
  for each row execute function public.access_role_permissions_biu();

create or replace function public.access_role_permissions_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_mark(public.access_role_user_ids(
    case when tg_op = 'DELETE' then old.role_id else new.role_id end));
  if tg_op = 'UPDATE' and old.role_id <> new.role_id then
    perform public.access_mark(public.access_role_user_ids(old.role_id));
  end if;
  return null;
end;
$$;
drop trigger if exists access_role_permissions_mark_aiud on public.access_role_permissions;
create trigger access_role_permissions_mark_aiud
  after insert or update or delete on public.access_role_permissions
  for each row execute function public.access_role_permissions_mark();

create or replace function public.org_unit_members_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_mark(array[
    case when tg_op <> 'INSERT' then old.user_id end,
    case when tg_op <> 'DELETE' then new.user_id end]);
  return null;
end;
$$;
drop trigger if exists org_unit_members_mark_aiud on public.org_unit_members;
create trigger org_unit_members_mark_aiud
  after insert or update or delete on public.org_unit_members
  for each row execute function public.org_unit_members_mark();

create or replace function public.portal_users_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (old.status, old.access_until, old.position_id)
         is not distinct from (new.status, new.access_until, new.position_id) then
    return null;
  end if;
  perform public.access_mark(array[case when tg_op = 'DELETE' then old.user_id else new.user_id end]);
  return null;
end;
$$;
drop trigger if exists portal_users_mark_aiud on public.portal_users;
create trigger portal_users_mark_aiud
  after insert or update or delete on public.portal_users
  for each row execute function public.portal_users_mark();

-- Путь подразделения и защита от циклов; перенос — пересчёт ветки.
create or replace function public.org_units_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id then
    return new;
  end if;
  if new.parent_id is null then
    new.path := '{}';
  else
    if new.parent_id = new.id
       or exists (select 1 from public.org_units p where p.id = new.parent_id and new.id = any (p.path)) then
      raise exception 'org_unit_cycle' using errcode = '22023';
    end if;
    select p.path || p.id into new.path from public.org_units p where p.id = new.parent_id;
  end if;
  return new;
end;
$$;
drop trigger if exists org_units_biu on public.org_units;
create trigger org_units_biu
  before insert or update on public.org_units
  for each row execute function public.org_units_biu();

create or replace function public.org_units_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is distinct from old.parent_id then
    update public.org_units u
       set path = new.path || u.path[array_position(u.path, new.id):]
     where new.id = any (u.path);
    perform public.access_mark(array(
      select m.user_id from public.org_unit_members m
        join public.org_units u on u.id = m.unit_id
       where u.id = new.id or new.id = any (u.path)));
  end if;
  return null;
end;
$$;
drop trigger if exists org_units_au on public.org_units;
create trigger org_units_au
  after update on public.org_units
  for each row execute function public.org_units_au();

-- Новый клуб и смена бренда: пересчитать назначения «все клубы» и «бренды».
-- Удалённый клуб уходит из выбранных клубов назначений.
create or replace function public.studios_access_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.brand_id is not distinct from old.brand_id then
    return null;
  end if;
  if tg_op = 'DELETE' then
    update public.access_assignments
       set scope_ids = array_remove(scope_ids, old.id)
     where scope_type = 'studios' and old.id = any (scope_ids);
    return null;
  end if;
  perform public.access_mark(array(
    select u
      from public.access_assignments a
      cross join lateral public.access_assignment_user_ids(
        a.subject_type, a.user_id, a.unit_id, a.position_id, a.unit_members, a.with_subunits) u
     where a.scope_type in ('all', 'brands')));
  return null;
end;
$$;
drop trigger if exists studios_access_mark_aiud on public.studios;
create trigger studios_access_mark_aiud
  after insert or update or delete on public.studios
  for each row execute function public.studios_access_mark();

-- Новая база знаний — тем, у кого «все базы»; удалённая — из прав ролей.
create or replace function public.kb_bases_access_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.access_role_permissions where perm_key = 'kb.base' and target_id = old.id;
    return null;
  end if;
  perform public.access_mark(array(
    select distinct u
      from public.access_role_permissions rp
      cross join lateral unnest(public.access_role_user_ids(rp.role_id)) u
     where rp.perm_key = 'kb.base' and rp.target_id is null));
  return null;
end;
$$;
drop trigger if exists kb_bases_access_mark_aid on public.kb_bases;
create trigger kb_bases_access_mark_aid
  after insert or delete on public.kb_bases
  for each row execute function public.kb_bases_access_mark();

-- 11) Прежние правила → права модели ---------------------------------------------
-- Администратор баз знаний: в модели — право kb.admin; вне модели — как
-- раньше, владелец хоть одного клуба.
create or replace function public.kb_is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.access_user_rights where user_id = _user_id)
      then exists (select 1 from public.access_user_rights r
                    where r.user_id = _user_id and r.portal and 'kb.admin' = any (r.rights))
    else exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
  end
$$;

create or replace function public.acad_is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.access_user_rights where user_id = _user_id)
      then exists (select 1 from public.access_user_rights r
                    where r.user_id = _user_id and r.portal and 'academy.admin' = any (r.rights))
    else exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
  end
$$;
revoke all on function public.acad_is_admin(uuid) from public, anon;
grant execute on function public.acad_is_admin(uuid) to authenticated, service_role;

-- Владельцы баз знаний (все базы) — им не нужны строки доступа, в отчётах
-- чтения их не считают.
create or replace function public.kb_admin_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select r.user_id from public.access_user_rights r
   where r.portal and 'kb.admin' = any (r.rights)
  union
  select ur.user_id from public.user_roles ur
   where ur.role = 'owner'
     and not exists (select 1 from public.access_user_rights x where x.user_id = ur.user_id)
$$;
revoke all on function public.kb_admin_user_ids() from public, anon, authenticated;

-- Раздел рейки: в модели — строка прав (нет строки — все разделы, так у
-- суперадминистратора); вне модели — как раньше (владелец — все).
create or replace function public.has_admin_section(_user_id uuid, _section text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_portal_user(_user_id) and (
    (not public.access_is_managed(_user_id)
     and exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner'))
    or not exists (select 1 from public.admin_permissions where user_id = _user_id)
    or exists (
      select 1 from public.admin_permissions
       where user_id = _user_id and _section = any (sections)
    )
  )
$$;

-- Базы знаний: сотрудник УК без клуба — тоже читатель (is_portal_user).
create or replace function public.kb_base_level(_user_id uuid, _base_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(_user_id) then 'manage'
    when not public.is_portal_user(_user_id) then null
    else (
      select case when bool_or(level = 'edit') then 'edit' when count(*) > 0 then 'view' end
        from public.kb_grants
       where base_id = _base_id and node_id is null
         and subject_type = 'user' and subject_id = _user_id
    )
  end
$$;

create or replace function public.auth_kb_view_base_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(auth.uid()) then coalesce((select array_agg(id) from public.kb_bases), '{}')
    when not public.is_portal_user(auth.uid()) then '{}'::uuid[]
    else coalesce((
      select array_agg(distinct base_id) from public.kb_grants
       where node_id is null and subject_type = 'user' and subject_id = auth.uid()
    ), '{}')
  end
$$;

create or replace function public.auth_kb_edit_base_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(auth.uid()) then coalesce((select array_agg(id) from public.kb_bases), '{}')
    when not public.is_portal_user(auth.uid()) then '{}'::uuid[]
    else coalesce((
      select array_agg(distinct base_id) from public.kb_grants
       where node_id is null and subject_type = 'user' and subject_id = auth.uid()
         and level = 'edit'
    ), '{}')
  end
$$;

-- Аудитория отчётов чтения — без администраторов баз (а не «без владельцев
-- клубов»: партнёр-владелец клуба — как раз читатель).
create or replace function public.kb_base_people(p_base uuid)
returns table (user_id uuid, level text)
language sql
stable
security definer
set search_path = public
as $$
  select g.subject_id, case when bool_or(g.level = 'edit') then 'edit' else 'view' end
    from public.kb_grants g
   where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
     and public.is_portal_user(g.subject_id)
     and not public.kb_is_admin(g.subject_id)
   group by g.subject_id
$$;

create or replace function public.kb_article_audience(p_node uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct g.subject_id
    from public.kb_nodes n
    join public.kb_grants g
      on g.base_id = n.base_id and g.node_id is null and g.subject_type = 'user'
   where n.id = p_node
     and public.is_portal_user(g.subject_id)
     and not public.kb_is_admin(g.subject_id)
     and g.subject_id is distinct from n.created_by
     and g.subject_id is distinct from n.updated_by
     and g.subject_id is distinct from n.published_by
     and not exists (
       select 1 from public.kb_drafts d where d.node_id = n.id and d.updated_by = g.subject_id
     )
     and not exists (
       select 1 from public.kb_revisions v where v.node_id = n.id and v.published_by = g.subject_id
     )
$$;

create or replace function public.kb_base_audience(p_base uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u from public.kb_admin_user_ids() u
  union
  select g.subject_id from public.kb_grants g
   where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
     and public.is_portal_user(g.subject_id)
$$;

create or replace function public.kb_mention_candidates(p_base uuid)
returns table (user_id uuid, full_name text, avatar_url text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(public.kb_base_level(auth.uid(), p_base), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  return query
  select u.id, coalesce(nullif(btrim(p.full_name), ''), u.email::text), p.avatar_url
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id in (
     select a from public.kb_admin_user_ids() a
     union
     select g.subject_id from public.kb_grants g
      where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
        and public.is_portal_user(g.subject_id)
   )
   order by 2;
end;
$$;

-- Строки доступа к базе целиком пишет только пересчёт прав; администраторам
-- баз — будущие доступы к отдельной ветке (node_id).
drop policy if exists "kb_grants admin write" on public.kb_grants;
create policy "kb_grants admin write" on public.kb_grants
  for all to authenticated
  using (node_id is not null and (select public.kb_is_admin(auth.uid())))
  with check (node_id is not null and (select public.kb_is_admin(auth.uid())));

-- Академия: свой администратор (academy.admin), ученик — и сотрудник УК без клуба.
create or replace function public.acad_can_create(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.acad_is_admin(_user_id)
      or (public.is_portal_user(_user_id)
          and exists (select 1 from public.acad_staff where user_id = _user_id and can_create))
$$;

create or replace function public.acad_can_review(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.acad_is_admin(_user_id)
      or (public.is_portal_user(_user_id)
          and exists (select 1 from public.acad_staff where user_id = _user_id and can_review))
$$;

drop policy if exists "acad_staff read" on public.acad_staff;
create policy "acad_staff read" on public.acad_staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.acad_is_admin(auth.uid())));

drop policy if exists "academy insert" on storage.objects;
create policy "academy insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kb-media' and (storage.foldername(name))[1] = 'academy'
    and (
      ((storage.foldername(name))[2] <> 'answers' and (select public.acad_can_create(auth.uid())))
      or ((storage.foldername(name))[2] = 'answers'
          and (storage.foldername(name))[3] = (select auth.uid())::text
          and (select public.is_portal_user(auth.uid())))
    )
  );

-- Назначения курсов: ещё по роли портала, подразделению (с подчинёнными)
-- и должности (бриф №61).
alter table public.acad_assignments add column if not exists access_role_id uuid
  references public.access_roles(id) on delete cascade;
alter table public.acad_assignments add column if not exists unit_id uuid
  references public.org_units(id) on delete cascade;
alter table public.acad_assignments add column if not exists position_id uuid
  references public.org_positions(id) on delete cascade;
alter table public.acad_assignments add column if not exists with_subunits boolean not null default true;
alter table public.acad_assignments drop constraint if exists acad_assignments_subject_type_check;
alter table public.acad_assignments add constraint acad_assignments_subject_type_check
  check (subject_type in ('user', 'role', 'access_role', 'unit', 'position'));
alter table public.acad_assignments drop constraint if exists acad_assignments_check;
alter table public.acad_assignments drop constraint if exists acad_assignments_subject_check;
alter table public.acad_assignments add constraint acad_assignments_subject_check check (
  (subject_type = 'user' and user_id is not null and role is null)
  or (subject_type = 'role' and role is not null and user_id is null)
  or (subject_type = 'access_role' and access_role_id is not null and user_id is null and role is null)
  or (subject_type = 'unit' and unit_id is not null and user_id is null and role is null)
  or (subject_type = 'position' and position_id is not null and user_id is null and role is null)
);

-- Ученики курса: люди, роли клубов, роли портала, подразделения, должности.
create or replace function public.acad_pairs(p_course uuid default null, p_user uuid default null)
returns table (course_id uuid, user_id uuid, assigned_at timestamptz, due_date date)
language sql
stable
security definer
set search_path = public
as $$
  with a as (
    select * from public.acad_assignments x where p_course is null or x.course_id = p_course
  ),
  raw as (
    select a.course_id, a.user_id, a.created_at as assigned_at, a.due_date, a.due_days
      from a
     where a.subject_type = 'user' and (p_user is null or a.user_id = p_user)
    union all
    select a.course_id, r.user_id, greatest(a.created_at, min(r.created_at)), a.due_date, a.due_days
      from a
      join public.user_roles r
        on r.role::text = a.role
       and (cardinality(a.studio_ids) = 0 or r.studio_id = any (a.studio_ids))
     where a.subject_type = 'role' and (p_user is null or r.user_id = p_user)
     group by a.id, a.course_id, r.user_id, a.created_at, a.due_date, a.due_days
    union all
    -- Роль портала: кому она сейчас действует.
    select a.course_id, u.user_id, greatest(a.created_at, min(x.created_at)), a.due_date, a.due_days
      from a
      join public.access_assignments x on x.role_id = a.access_role_id
      cross join lateral public.access_assignment_user_ids(
        x.subject_type, x.user_id, x.unit_id, x.position_id, x.unit_members, x.with_subunits) u(user_id)
     where a.subject_type = 'access_role' and (p_user is null or u.user_id = p_user)
       and (x.valid_from is null or x.valid_from <= now())
       and (x.valid_until is null or x.valid_until > now())
     group by a.id, a.course_id, u.user_id, a.created_at, a.due_date, a.due_days
    union all
    select a.course_id, m.user_id, greatest(a.created_at, min(m.created_at)), a.due_date, a.due_days
      from a
      join public.org_units un on un.id = a.unit_id or (a.with_subunits and a.unit_id = any (un.path))
      join public.org_unit_members m on m.unit_id = un.id
     where a.subject_type = 'unit' and (p_user is null or m.user_id = p_user)
     group by a.id, a.course_id, m.user_id, a.created_at, a.due_date, a.due_days
    union all
    select a.course_id, pu.user_id, greatest(a.created_at, pu.created_at), a.due_date, a.due_days
      from a
      join public.portal_users pu on pu.position_id = a.position_id
     where a.subject_type = 'position' and (p_user is null or pu.user_id = p_user)
  )
  select raw.course_id, raw.user_id, min(raw.assigned_at),
         min(coalesce(raw.due_date,
                      case when raw.due_days is not null
                           then (raw.assigned_at at time zone 'Asia/Tbilisi')::date + raw.due_days end))
    from raw
   where public.is_portal_user(raw.user_id)
   group by raw.course_id, raw.user_id
$$;

create or replace function public.acad_user_course_ids(_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct p.course_id), '{}')
    from public.acad_pairs(null, _user_id) p
    join public.acad_courses c on c.id = p.course_id and c.status = 'published'
$$;

create or replace function public.acad_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'is_admin', public.acad_is_admin(auth.uid()),
    'can_create', public.acad_can_create(auth.uid()),
    'can_review', public.acad_can_review(auth.uid()),
    'my_courses', cardinality(public.acad_user_course_ids(auth.uid())),
    'my_open', (
      select count(*) from unnest(public.acad_user_course_ids(auth.uid())) c(id)
       where not exists (select 1 from public.acad_enrollments e
                          where e.course_id = c.id and e.user_id = auth.uid()
                            and e.completed_at is not null)),
    'to_review', case when public.acad_can_review(auth.uid())
                      then (select count(*) from public.acad_attempts
                             where status = 'review' and user_id <> auth.uid())
                      else 0 end
  )
$$;

-- Люди для назначений Академии: и сотрудники УК без клуба; подразделения
-- (с путём — для «и ниже»), должность и роли портала — счётчик учеников в
-- конструкторе курса считает их у себя.
drop function if exists public.acad_staff_directory();
create function public.acad_staff_directory()
returns table (
  user_id uuid, full_name text, avatar_url text, email text, roles jsonb,
  position_id uuid, units jsonb, access_role_ids jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  with people as (
    select ur.user_id from public.user_roles ur where ur.role::text in ('owner', 'admin', 'trainer')
    union
    select r.user_id from public.access_user_rights r where r.portal
  )
  select x.user_id, p.full_name, p.avatar_url, p.email,
         coalesce((select jsonb_agg(distinct jsonb_build_object('role', r.role::text, 'studio_id', r.studio_id))
                     from public.user_roles r
                    where r.user_id = x.user_id and r.role::text in ('owner', 'admin', 'trainer')), '[]'::jsonb),
         pu.position_id,
         coalesce((select jsonb_agg(jsonb_build_object('unit_id', m.unit_id, 'path', to_jsonb(u.path),
                                                       'member_role', m.member_role))
                     from public.org_unit_members m join public.org_units u on u.id = m.unit_id
                    where m.user_id = x.user_id), '[]'::jsonb),
         coalesce((select jsonb_agg(distinct a.role_id) from public.access_applicable(x.user_id) a), '[]'::jsonb)
    from people x
    left join public.profiles p on p.id = x.user_id
    left join public.portal_users pu on pu.user_id = x.user_id
   where public.is_portal_user(x.user_id)
   order by p.full_name;
end;
$$;
revoke all on function public.acad_staff_directory() from public, anon;
grant execute on function public.acad_staff_directory() to authenticated, service_role;

-- Создать клуб: право studios.create (вне модели — как раньше, владелец).
-- Создатель, которого новый клуб не покрывает, получает «Владельца клуба» в нём.
create or replace function public.create_studio(
  _name text,
  _format text,
  _brand_color text,
  _logo_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _id uuid;
  _owner_role uuid;
begin
  if auth.uid() is null or not (
    public.access_has_right(auth.uid(), 'studios.create')
    or (not public.access_is_managed(auth.uid())
        and exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'owner'))
  ) then
    raise exception 'Создавать клубы может только тот, у кого есть право «Создаёт клубы»'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(_name, '')), '') is null then
    raise exception 'Укажите название клуба' using errcode = '22023';
  end if;

  insert into public.studios (name, format, brand_color, logo_url, brand_id)
  values (trim(_name), _format, _brand_color, nullif(trim(coalesce(_logo_url, '')), ''),
          (select b.id from public.org_brands b
            where b.name = case _format when 'packages' then 'Lady Stretch' else 'Base40' end))
  returning id into _id;

  if public.access_is_managed(auth.uid()) then
    perform public.access_flush();
    if not exists (select 1 from public.user_roles
                    where user_id = auth.uid() and studio_id = _id and role = 'owner') then
      select id into _owner_role from public.access_roles where system_key = 'studio_owner';
      insert into public.access_assignments (role_id, subject_type, user_id, scope_type, scope_ids, created_by, note)
      values (_owner_role, 'user', auth.uid(), 'studios', array[_id], auth.uid(), 'Создал клуб');
      perform public.access_flush();
    end if;
    insert into public.access_log (actor_id, action, summary, details)
    values (auth.uid(), 'studio.create', format('Создан клуб «%s»', trim(_name)),
            jsonb_build_object('studio_id', _id));
  else
    insert into public.user_roles (user_id, studio_id, role)
    values (auth.uid(), _id, 'owner')
    on conflict (user_id, studio_id, role) do nothing;
  end if;

  return _id;
end;
$$;

-- Роли в клубах пишет только пересчёт прав (и сервер сервис-ключом). Прежняя
-- политика давала владельцу клуба запись в обход «Доступов»; читать роли
-- своего клуба по-прежнему можно ("user_roles self or trainer select").
drop policy if exists "user_roles owner manage" on public.user_roles;

-- 12) Политики чтения новых таблиц ------------------------------------------
-- Структура и роли видны всем пользователям портала (оргсхема и «кто есть
-- кто»); назначения, личные строки и пользователи целиком — управляющим.
drop policy if exists "org_brands read" on public.org_brands;
create policy "org_brands read" on public.org_brands
  for select to authenticated using ((select public.is_portal_user(auth.uid())));
drop policy if exists "org_units read" on public.org_units;
create policy "org_units read" on public.org_units
  for select to authenticated using ((select public.is_portal_user(auth.uid())));
drop policy if exists "org_positions read" on public.org_positions;
create policy "org_positions read" on public.org_positions
  for select to authenticated using ((select public.is_portal_user(auth.uid())));
drop policy if exists "org_unit_members read" on public.org_unit_members;
create policy "org_unit_members read" on public.org_unit_members
  for select to authenticated using ((select public.is_portal_user(auth.uid())));
drop policy if exists "access_permissions read" on public.access_permissions;
create policy "access_permissions read" on public.access_permissions
  for select to authenticated using (true);
drop policy if exists "access_roles read" on public.access_roles;
create policy "access_roles read" on public.access_roles
  for select to authenticated
  using ((select public.is_portal_user(auth.uid()))
         and (personal_user_id is null or personal_user_id = (select auth.uid())
              or (select public.auth_access_rights()) && array['users.manage', 'roles.manage']));
drop policy if exists "access_role_permissions read" on public.access_role_permissions;
create policy "access_role_permissions read" on public.access_role_permissions
  for select to authenticated
  using (exists (select 1 from public.access_roles r where r.id = role_id));
drop policy if exists "portal_users read" on public.portal_users;
create policy "portal_users read" on public.portal_users
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.auth_access_rights()) && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']);
drop policy if exists "access_assignments read" on public.access_assignments;
create policy "access_assignments read" on public.access_assignments
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.auth_access_rights()) && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']);
drop policy if exists "access_user_rights read" on public.access_user_rights;
create policy "access_user_rights read" on public.access_user_rights
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.auth_access_rights()) && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']);
-- access_dirty и access_log — только через RPC.

-- 13) Проверки прав для RPC -------------------------------------------------
create or replace function public.access_actor()
returns public.access_user_rights
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.access_user_rights;
begin
  select * into r from public.access_user_rights where user_id = auth.uid() and portal;
  if not found then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  return r;
end;
$$;

create or replace function public.access_require(_right text)
returns public.access_user_rights
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.access_user_rights := public.access_actor();
begin
  if not (_right = any (r.rights)) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  return r;
end;
$$;

create or replace function public.access_superadmin_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.access_user_rights where portal and 'portal.admin' = any (rights)
$$;

-- Нельзя оставить портал без суперадминистратора (если он был).
create or replace function public.access_guard(_before integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_flush();
  if _before > 0 and public.access_superadmin_count() = 0 then
    raise exception 'access_last_superadmin' using errcode = '42501';
  end if;
end;
$$;

-- Может ли actor выдать роль на эту область этому субъекту. null — может,
-- иначе — причина. Правило: не больше своих прав (как делегирование у
-- Google Workspace и границы прав AWS) и только в своих клубах.
create or replace function public.access_grant_problem(
  _actor public.access_user_rights,
  _role_id uuid,
  _subject_type text,
  _scope_type text,
  _scope_ids uuid[]
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.access_roles;
  v_scope uuid[];
  p record;
  v_my jsonb := coalesce(_actor.effective, '{}'::jsonb);
  v_mine jsonb;
  v_sid uuid;
begin
  select * into v_role from public.access_roles where id = _role_id;
  if not found then
    return 'Роль не найдена';
  end if;
  if 'portal.admin' = any (_actor.rights) then
    return null;
  end if;
  if not ('users.manage' = any (_actor.rights)) then
    return 'Нет права управлять пользователями';
  end if;
  if v_role.locked or exists (select 1 from public.access_role_permissions
                               where role_id = _role_id and perm_key = 'portal.admin') then
    return 'Эту роль выдаёт только суперадминистратор';
  end if;
  if _subject_type <> 'user' and not _actor.manage_all then
    return 'Подразделению и должности роль выдаёт администратор всех пользователей';
  end if;
  -- Клубы важны, только если у роли есть права «в клубе».
  if not _actor.manage_all and exists (
       select 1 from public.access_role_permissions rp
         join public.access_permissions c on c.key = rp.perm_key
        where rp.role_id = _role_id and c.scope = 'studio') then
    if _scope_type <> 'studios' then
      return 'Выберите клубы: вам доступны только свои';
    end if;
    if not (_scope_ids <@ _actor.manage_studio_ids) then
      return 'Выдавать роль можно только в клубах, где вы управляете пользователями';
    end if;
  end if;
  v_scope := public.access_scope_studios(_scope_type, _scope_ids);

  for p in
    select rp.perm_key, rp.target_id, rp.level, c.scope, c.label
      from public.access_role_permissions rp
      join public.access_permissions c on c.key = rp.perm_key
     where rp.role_id = _role_id
  loop
    if p.perm_key = 'kb.base' then
      if 'kb.admin' = any (_actor.rights) then
        continue;
      end if;
      if p.target_id is null then
        return 'Доступ ко всем базам знаний выдаёт администратор баз знаний';
      end if;
      if coalesce(v_my->'kb'->>(p.target_id::text), '') = ''
         or (p.level = 'edit' and v_my->'kb'->>(p.target_id::text) <> 'edit') then
        return format('Нельзя выдать «%s» на базу, где у вас нет такого доступа', p.label);
      end if;
    elsif p.perm_key = 'scripts' then
      if v_my->'rails' <> 'null'::jsonb and not (
        v_my->'rails' ? (case when p.level = 'edit' then 'scripts-edit' else 'scripts' end)) then
        return format('Нельзя выдать «%s» — у вас его нет', p.label);
      end if;
    elsif p.scope = 'network' then
      if not (p.perm_key = any (_actor.rights)) then
        return format('Нельзя выдать «%s» — у вас его нет', p.label);
      end if;
    elsif not _actor.manage_all then
      -- Права «в клубе» — не больше своих в каждом клубе области.
      foreach v_sid in array v_scope loop
        v_mine := v_my->'studios'->(v_sid::text);
        if v_mine is null then
          return 'В одном из клубов у вас нет доступа';
        end if;
        if p.perm_key = 'studio.tier'
           and public.access_tier_rank(p.level) > public.access_tier_rank(v_mine->>'tier') then
          return format('Нельзя выдать уровень выше своего в клубе');
        end if;
        if p.perm_key like 'club.%' and v_mine->'sections' <> 'null'::jsonb
           and (p.perm_key = 'club.all' or not (v_mine->'sections' ? substr(p.perm_key, 6))) then
          return format('Нельзя выдать раздел «%s» — у вас его нет', p.label);
        end if;
      end loop;
    end if;
  end loop;
  return null;
end;
$$;

-- Может ли actor править человека: суперадминистратор — всех; администратор
-- всех пользователей — всех, кроме суперадминистраторов; управляющий
-- клубами — тех, чьи роли выданы только в его клубах и не шире его прав.
create or replace function public.access_can_manage_user(_actor public.access_user_rights, _target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a record;
begin
  if 'portal.admin' = any (_actor.rights) then
    return true;
  end if;
  if not ('users.manage' = any (_actor.rights)) or _target = _actor.user_id then
    return false;
  end if;
  if public.access_has_right(_target, 'portal.admin') then
    return false;
  end if;
  if _actor.manage_all then
    return true;
  end if;
  if not exists (select 1 from public.portal_users where user_id = _target) then
    return false;
  end if;
  -- Роли от подразделения и должности — дело администраторов сети.
  if exists (select 1 from public.access_applicable(_target) x where x.subject_type <> 'user') then
    return false;
  end if;
  for a in
    select x.*, ro.personal_user_id is not null as personal
      from public.access_assignments x
      join public.access_roles ro on ro.id = x.role_id
     where x.subject_type = 'user' and x.user_id = _target
  loop
    -- Личные права — только сетевые: важны сами права, не клубы.
    if public.access_grant_problem(_actor, a.role_id, 'user',
         case when a.personal then 'studios' else a.scope_type end,
         case when a.personal then _actor.manage_studio_ids else a.scope_ids end) is not null then
      return false;
    end if;
  end loop;
  return exists (select 1 from public.access_assignments x
                  where x.subject_type = 'user' and x.user_id = _target
                    and x.scope_type = 'studios' and x.scope_ids && _actor.manage_studio_ids)
      or exists (select 1 from public.portal_users where user_id = _target and created_by = _actor.user_id);
end;
$$;

revoke all on function public.access_actor(), public.access_require(text),
  public.access_superadmin_count(), public.access_guard(integer),
  public.access_grant_problem(public.access_user_rights, uuid, text, text, uuid[]),
  public.access_can_manage_user(public.access_user_rights, uuid)
  from public, anon, authenticated;

create or replace function public.access_log_add(
  _action text, _summary text, _target_user uuid default null, _target_role uuid default null,
  _details jsonb default '{}'
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_log (actor_id, action, target_user, target_role, summary, details)
  values (auth.uid(), _action, _target_user, _target_role, _summary, coalesce(_details, '{}'))
$$;
revoke all on function public.access_log_add(text, text, uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.access_user_name(_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(p.full_name), ''), u.email::text, 'Пользователь')
    from auth.users u left join public.profiles p on p.id = u.id
   where u.id = _user_id
$$;
revoke all on function public.access_user_name(uuid) from public, anon, authenticated;

-- 14) RPC: я и списки ----------------------------------------------------------
-- Свои права — интерфейсу (рейка, меню, кнопки).
create or replace function public.access_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'managed', public.access_is_managed(auth.uid()),
    'portal', public.is_portal_user(auth.uid()),
    'rights', coalesce((select to_jsonb(r.rights) from public.access_user_rights r
                         where r.user_id = auth.uid() and r.portal), '[]'::jsonb),
    'manage_all', coalesce((select r.manage_all from public.access_user_rights r
                             where r.user_id = auth.uid() and r.portal), false),
    'manage_studio_ids', coalesce((select to_jsonb(r.manage_studio_ids) from public.access_user_rights r
                                    where r.user_id = auth.uid() and r.portal), '[]'::jsonb)
  )
$$;

-- Пользователи, которых actor видит: все — администратору пользователей,
-- управляющему клубами — тех, у кого роль в его клубах или кого он завёл.
create or replace function public.access_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  avatar_url text,
  user_type text,
  position_id uuid,
  status text,
  access_until date,
  note text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  portal boolean,
  studio_ids uuid[],
  units jsonb,
  roles jsonb,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
begin
  me := public.access_actor();
  if not (me.rights && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  return query
  select pu.user_id, u.email::text, p.full_name, p.phone, p.avatar_url, pu.user_type, pu.position_id,
         pu.status, pu.access_until, pu.note, pu.created_at, u.last_sign_in_at,
         coalesce(r.portal, false),
         coalesce(array(select jsonb_object_keys(r.effective->'studios'))::uuid[], '{}'),
         coalesce((select jsonb_agg(jsonb_build_object('unit_id', m.unit_id, 'member_role', m.member_role)
                                    order by m.created_at)
                     from public.org_unit_members m where m.user_id = pu.user_id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'assignment_id', x.id, 'role_id', x.role_id, 'subject_type', x.subject_type,
                     'scope_type', x.scope_type, 'scope_ids', to_jsonb(x.scope_ids),
                     'valid_until', x.valid_until, 'personal', ro.personal_user_id is not null)
                     order by ro.sort_order, ro.name)
                     from public.access_applicable(pu.user_id) x
                     join public.access_roles ro on ro.id = x.role_id), '[]'::jsonb),
         public.access_can_manage_user(me, pu.user_id)
    from public.portal_users pu
    join auth.users u on u.id = pu.user_id
    left join public.profiles p on p.id = pu.user_id
    left join public.access_user_rights r on r.user_id = pu.user_id
   where 'portal.admin' = any (me.rights) or me.manage_all
      or me.rights && array['audit.view', 'roles.manage', 'structure.manage']
      or pu.created_by = me.user_id
      or exists (select 1 from public.access_assignments x
                  where x.subject_type = 'user' and x.user_id = pu.user_id
                    and x.scope_type = 'studios' and x.scope_ids && me.manage_studio_ids)
      or (r.effective->'studios') ?| array(select s::text from unnest(me.manage_studio_ids) s)
   order by p.full_name nulls last, u.email;
end;
$$;

-- Откуда право: роль, назначение, через кого (человек, подразделение,
-- должность) и в каких клубах.
create or replace function public.access_explain(p_user uuid)
returns table (
  assignment_id uuid,
  role_id uuid,
  role_name text,
  personal boolean,
  subject_type text,
  via text,
  scope_type text,
  scope_ids uuid[],
  valid_from timestamptz,
  valid_until timestamptz,
  perm_key text,
  target_id uuid,
  level text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
begin
  if p_user is distinct from auth.uid() then
    me := public.access_actor();
    if not (me.rights && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']) then
      raise exception 'access_forbidden' using errcode = '42501';
    end if;
  end if;
  return query
  select x.id, x.role_id, ro.name, ro.personal_user_id is not null, x.subject_type,
         case x.subject_type
           when 'user' then 'Лично'
           when 'unit' then 'Подразделение «' || un.name || '»'
                            || case when x.unit_members = 'heads' then ' (руководители)' else '' end
                            || case when x.with_subunits then ' и ниже' else '' end
           else 'Должность «' || po.name || '»'
         end,
         x.scope_type, x.scope_ids, x.valid_from, x.valid_until,
         rp.perm_key, rp.target_id, rp.level
    from public.access_applicable(p_user) x
    join public.access_roles ro on ro.id = x.role_id
    left join public.org_units un on un.id = x.unit_id
    left join public.org_positions po on po.id = x.position_id
    left join public.access_role_permissions rp on rp.role_id = x.role_id
   order by ro.sort_order, ro.name, rp.perm_key;
end;
$$;

-- Карточка пользователя.
create or replace function public.access_user(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
  v jsonb;
begin
  me := public.access_actor();
  if p_user <> me.user_id and not (me.rights && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'user_id', pu.user_id,
    'email', u.email,
    'full_name', p.full_name,
    'phone', p.phone,
    'avatar_url', p.avatar_url,
    'user_type', pu.user_type,
    'position_id', pu.position_id,
    'status', pu.status,
    'access_until', pu.access_until,
    'note', pu.note,
    'blocked_at', pu.blocked_at,
    'blocked_reason', pu.blocked_reason,
    'created_at', pu.created_at,
    'created_by_name', public.access_user_name(pu.created_by),
    'last_sign_in_at', u.last_sign_in_at,
    'can_manage', public.access_can_manage_user(me, pu.user_id),
    'effective', coalesce(r.effective, '{}'::jsonb),
    'units', coalesce((select jsonb_agg(jsonb_build_object('unit_id', m.unit_id, 'member_role', m.member_role)
                                        order by m.created_at)
                         from public.org_unit_members m where m.user_id = pu.user_id), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object(
                               'created_by_name', public.access_user_name(x.created_by),
                               'active', exists (select 1 from public.access_applicable(pu.user_id) y where y.id = x.id))
                               order by x.created_at)
                               from public.access_assignments x
                               join public.access_roles ro on ro.id = x.role_id
                              where x.subject_type = 'user' and x.user_id = pu.user_id
                                and ro.personal_user_id is null), '[]'::jsonb),
    'personal_role_id', (select ro.id from public.access_roles ro where ro.personal_user_id = pu.user_id),
    'personal', coalesce((select jsonb_agg(jsonb_build_object('perm_key', rp.perm_key,
                                                             'target_id', rp.target_id, 'level', rp.level))
                            from public.access_roles ro
                            join public.access_role_permissions rp on rp.role_id = ro.id
                           where ro.personal_user_id = pu.user_id), '[]'::jsonb)
  ) into v
    from public.portal_users pu
    join auth.users u on u.id = pu.user_id
    left join public.profiles p on p.id = pu.user_id
    left join public.access_user_rights r on r.user_id = pu.user_id
   where pu.user_id = p_user;
  if v is null then
    raise exception 'access_user_not_found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

create or replace function public.access_roles_list()
returns table (
  id uuid,
  name text,
  description text,
  color text,
  system_key text,
  locked boolean,
  sort_order integer,
  updated_at timestamptz,
  permissions jsonb,
  assignments integer,
  users integer,
  grant_problem text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
begin
  me := public.access_actor();
  if not (me.rights && array['users.manage', 'roles.manage', 'audit.view', 'structure.manage']) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  return query
  select ro.id, ro.name, ro.description, ro.color, ro.system_key, ro.locked, ro.sort_order, ro.updated_at,
         coalesce((select jsonb_agg(jsonb_build_object('perm_key', rp.perm_key, 'target_id', rp.target_id,
                                                       'level', rp.level))
                     from public.access_role_permissions rp where rp.role_id = ro.id), '[]'::jsonb),
         (select count(*)::int from public.access_assignments x where x.role_id = ro.id),
         cardinality(public.access_role_user_ids(ro.id)),
         -- Для окна «Назначить»: можно ли вызывающему выдать роль в своих
         -- клубах (не больше своих прав); null — можно.
         public.access_grant_problem(me, ro.id, 'user',
           case when me.manage_all then 'all' else 'studios' end, me.manage_studio_ids)
    from public.access_roles ro
   where ro.personal_user_id is null
   order by ro.sort_order, ro.name;
end;
$$;

create or replace function public.access_log_list(p_user uuid default null, p_limit integer default 200)
returns table (
  id bigint,
  at timestamptz,
  actor_id uuid,
  actor_name text,
  action text,
  target_user uuid,
  target_name text,
  target_role uuid,
  summary text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
begin
  me := public.access_actor();
  if not (me.rights && array['audit.view', 'roles.manage'])
     and not (p_user is not null and public.access_can_manage_user(me, p_user)) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  return query
  select l.id, l.at, l.actor_id, public.access_user_name(l.actor_id), l.action, l.target_user,
         public.access_user_name(l.target_user), l.target_role, l.summary, l.details
    from public.access_log l
   where p_user is null or l.target_user = p_user
   order by l.at desc, l.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

-- 15) RPC: роли ---------------------------------------------------------------
-- p: {id?, name, description, color, permissions: [{perm_key, target_id, level}]}
create or replace function public.access_role_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('roles.manage');
  v_before integer := public.access_superadmin_count();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_role public.access_roles;
  v_perms jsonb := coalesce(p->'permissions', '[]'::jsonb);
  v_old jsonb;
  v_admin boolean := 'portal.admin' = any (me.rights);
begin
  if v_id is not null then
    select * into v_role from public.access_roles where id = v_id and personal_user_id is null;
    if not found then
      raise exception 'access_role_not_found' using errcode = 'P0002';
    end if;
  end if;
  if not v_admin then
    if v_role.locked or exists (select 1 from public.access_role_permissions
                                 where role_id = v_id and perm_key = 'portal.admin')
       or exists (select 1 from jsonb_array_elements(v_perms) e where e->>'perm_key' = 'portal.admin') then
      raise exception 'access_superadmin_only' using errcode = '42501';
    end if;
  end if;
  -- Права «в клубе» без доступа к данным клуба ничего не дают.
  if exists (select 1 from jsonb_array_elements(v_perms) e
              join public.access_permissions c on c.key = e->>'perm_key'
             where c.scope = 'studio' and c.key like 'club.%')
     and not exists (select 1 from jsonb_array_elements(v_perms) e where e->>'perm_key' = 'studio.tier') then
    raise exception 'access_sections_need_tier' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.access_roles (name, description, color, created_by, updated_by, sort_order)
    values (btrim(p->>'name'), nullif(btrim(coalesce(p->>'description', '')), ''),
            nullif(p->>'color', ''), auth.uid(), auth.uid(),
            coalesce((select max(sort_order) + 1 from public.access_roles where personal_user_id is null), 0))
    returning * into v_role;
  else
    select coalesce(jsonb_agg(jsonb_build_object('perm_key', perm_key, 'target_id', target_id, 'level', level)
                              order by perm_key, target_id), '[]') into v_old
      from public.access_role_permissions where role_id = v_id;
    update public.access_roles
       set name = btrim(p->>'name'),
           description = nullif(btrim(coalesce(p->>'description', '')), ''),
           color = nullif(p->>'color', ''),
           updated_at = now(), updated_by = auth.uid()
     where id = v_id
    returning * into v_role;
  end if;

  if not v_role.locked then
    delete from public.access_role_permissions rp
     where rp.role_id = v_role.id
       and not exists (select 1 from jsonb_array_elements(v_perms) e
                        where e->>'perm_key' = rp.perm_key
                          and nullif(e->>'target_id', '')::uuid is not distinct from rp.target_id
                          and coalesce(e->>'level', 'on') = rp.level);
    insert into public.access_role_permissions (role_id, perm_key, target_id, level)
    select distinct v_role.id, e->>'perm_key', nullif(e->>'target_id', '')::uuid, coalesce(e->>'level', 'on')
      from jsonb_array_elements(v_perms) e
     where not exists (select 1 from public.access_role_permissions rp
                        where rp.role_id = v_role.id and rp.perm_key = e->>'perm_key'
                          and rp.target_id is not distinct from nullif(e->>'target_id', '')::uuid);
    -- Тот же ключ и база, другой уровень — уровень меняем.
    update public.access_role_permissions rp
       set level = coalesce(e->>'level', 'on')
      from jsonb_array_elements(v_perms) e
     where rp.role_id = v_role.id and rp.perm_key = e->>'perm_key'
       and rp.target_id is not distinct from nullif(e->>'target_id', '')::uuid
       and rp.level <> coalesce(e->>'level', 'on');
  end if;

  perform public.access_log_add(
    case when v_id is null then 'role.create' else 'role.update' end,
    format(case when v_id is null then 'Создана роль «%s»' else 'Изменена роль «%s»' end, v_role.name),
    null, v_role.id,
    jsonb_build_object('before', v_old, 'after', (
      select coalesce(jsonb_agg(jsonb_build_object('perm_key', perm_key, 'target_id', target_id, 'level', level)
                                order by perm_key, target_id), '[]')
        from public.access_role_permissions where role_id = v_role.id)));
  perform public.access_guard(v_before);
  return v_role.id;
end;
$$;

create or replace function public.access_role_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('roles.manage');
  v_role public.access_roles;
begin
  select * into v_role from public.access_roles where id = p_id and personal_user_id is null;
  if not found then
    raise exception 'access_role_not_found' using errcode = 'P0002';
  end if;
  if v_role.locked or v_role.system_key = 'superadmin' then
    raise exception 'access_role_locked' using errcode = '42501';
  end if;
  if exists (select 1 from public.access_assignments where role_id = p_id)
     or exists (select 1 from public.acad_assignments where access_role_id = p_id) then
    raise exception 'access_role_in_use' using errcode = '23503';
  end if;
  delete from public.access_roles where id = p_id;
  perform public.access_log_add('role.delete', format('Удалена роль «%s»', v_role.name), null, p_id);
end;
$$;

-- 16) RPC: назначения -------------------------------------------------------------
-- p: {id?, role_id, subject_type, user_id|unit_id|position_id, unit_members,
--     with_subunits, scope_type, scope_ids, valid_from, valid_until, note}
create or replace function public.access_assignment_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_old public.access_assignments;
  v_new public.access_assignments;
  v_problem text;
  v_scope_type text := coalesce(p->>'scope_type', 'all');
  v_scope uuid[] := coalesce(array(select jsonb_array_elements_text(coalesce(p->'scope_ids', '[]')))::uuid[], '{}');
  v_subject text := coalesce(p->>'subject_type', 'user');
  v_role public.access_roles;
begin
  if v_id is not null then
    select * into v_old from public.access_assignments where id = v_id;
    if not found then
      raise exception 'access_assignment_not_found' using errcode = 'P0002';
    end if;
    v_problem := public.access_grant_problem(me, v_old.role_id, v_old.subject_type, v_old.scope_type, v_old.scope_ids);
    if v_problem is not null then
      raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
    end if;
  end if;
  select * into v_role from public.access_roles where id = (p->>'role_id')::uuid;
  if not found or v_role.personal_user_id is not null then
    raise exception 'access_role_not_found' using errcode = 'P0002';
  end if;
  if v_scope_type = 'all' then
    v_scope := '{}';
  elsif cardinality(v_scope) = 0 then
    raise exception 'access_scope_empty' using errcode = '22023';
  end if;
  v_problem := public.access_grant_problem(me, v_role.id, v_subject, v_scope_type, v_scope);
  if v_problem is not null then
    raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
  end if;
  if v_subject = 'user' and nullif(p->>'user_id', '')::uuid is distinct from me.user_id
     and not public.access_can_manage_user(me, (p->>'user_id')::uuid)
     and not exists (select 1 from public.portal_users where user_id = (p->>'user_id')::uuid
                                                          and created_by = me.user_id) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  -- Себе роль выдаёт только суперадминистратор.
  if v_subject = 'user' and (p->>'user_id')::uuid = me.user_id and not ('portal.admin' = any (me.rights)) then
    raise exception 'access_self' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.access_assignments (role_id, subject_type, user_id, unit_id, position_id, unit_members,
      with_subunits, scope_type, scope_ids, valid_from, valid_until, note, created_by)
    values (v_role.id, v_subject,
            case when v_subject = 'user' then (p->>'user_id')::uuid end,
            case when v_subject = 'unit' then (p->>'unit_id')::uuid end,
            case when v_subject = 'position' then (p->>'position_id')::uuid end,
            coalesce(p->>'unit_members', 'all'), coalesce((p->>'with_subunits')::boolean, true),
            v_scope_type, v_scope,
            nullif(p->>'valid_from', '')::timestamptz, nullif(p->>'valid_until', '')::timestamptz,
            nullif(btrim(coalesce(p->>'note', '')), ''), auth.uid())
    returning * into v_new;
  else
    update public.access_assignments
       set role_id = v_role.id, unit_members = coalesce(p->>'unit_members', 'all'),
           with_subunits = coalesce((p->>'with_subunits')::boolean, true),
           scope_type = v_scope_type, scope_ids = v_scope,
           valid_from = nullif(p->>'valid_from', '')::timestamptz,
           valid_until = nullif(p->>'valid_until', '')::timestamptz,
           note = nullif(btrim(coalesce(p->>'note', '')), '')
     where id = v_id
    returning * into v_new;
  end if;

  perform public.access_log_add(
    case when v_id is null then 'assign' else 'assign.update' end,
    format('Роль «%s» — %s', v_role.name,
           case v_subject
             when 'user' then public.access_user_name(v_new.user_id)
             when 'unit' then 'подразделение «' || (select name from public.org_units where id = v_new.unit_id) || '»'
             else 'должность «' || (select name from public.org_positions where id = v_new.position_id) || '»'
           end),
    v_new.user_id, v_role.id,
    jsonb_build_object('before', case when v_id is null then null else to_jsonb(v_old) end,
                       'after', to_jsonb(v_new)));
  perform public.access_guard(v_before);
  return v_new.id;
end;
$$;

create or replace function public.access_assignment_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_old public.access_assignments;
  v_problem text;
begin
  select * into v_old from public.access_assignments where id = p_id;
  if not found then
    return;
  end if;
  v_problem := public.access_grant_problem(me, v_old.role_id, v_old.subject_type, v_old.scope_type, v_old.scope_ids);
  if v_problem is not null then
    raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
  end if;
  if v_old.subject_type = 'user' and v_old.user_id <> me.user_id
     and not public.access_can_manage_user(me, v_old.user_id) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  delete from public.access_assignments where id = p_id;
  perform public.access_log_add('unassign',
    format('Снята роль «%s»%s', (select name from public.access_roles where id = v_old.role_id),
           case when v_old.user_id is not null then ' — ' || public.access_user_name(v_old.user_id) else '' end),
    v_old.user_id, v_old.role_id, jsonb_build_object('before', to_jsonb(v_old)));
  perform public.access_guard(v_before);
end;
$$;

-- Личные права человека (только сетевые: разделы, базы знаний, Академия…).
-- p_perms: [{perm_key, target_id, level}]
create or replace function public.access_personal_save(p_user uuid, p_perms jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_role uuid;
  v_problem text;
begin
  if not public.access_can_manage_user(me, p_user) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  select id into v_role from public.access_roles where personal_user_id = p_user;
  if v_role is null then
    insert into public.access_roles (name, personal_user_id, created_by, updated_by)
    values ('Личные права: ' || public.access_user_name(p_user), p_user, auth.uid(), auth.uid())
    returning id into v_role;
    insert into public.access_assignments (role_id, subject_type, user_id, scope_type, created_by)
    values (v_role, 'user', p_user, 'all', auth.uid());
  end if;
  delete from public.access_role_permissions where role_id = v_role;
  insert into public.access_role_permissions (role_id, perm_key, target_id, level)
  select distinct v_role, e->>'perm_key', nullif(e->>'target_id', '')::uuid, coalesce(e->>'level', 'on')
    from jsonb_array_elements(coalesce(p_perms, '[]'::jsonb)) e;
  -- Не больше своих прав.
  v_problem := public.access_grant_problem(me, v_role, 'user',
    case when me.manage_all then 'all' else 'studios' end, me.manage_studio_ids);
  if v_problem is not null then
    raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
  end if;
  perform public.access_log_add('personal.update',
    'Личные права — ' || public.access_user_name(p_user), p_user, v_role,
    jsonb_build_object('after', coalesce(p_perms, '[]'::jsonb)));
  perform public.access_guard(v_before);
end;
$$;

-- 17) RPC: пользователи --------------------------------------------------------------
-- Новый человек портала (учётную запись создаёт сервер админки). Человек
-- уже в портале — править его может только тот, кто им управляет.
-- p: {first_name, last_name, phone, user_type, position_id, access_until, note}
create or replace function public.access_user_save(p_user uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_exists boolean;
  v_name text;
begin
  if not ('users.manage' = any (me.rights)) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  select true into v_exists from public.portal_users where user_id = p_user;
  v_exists := coalesce(v_exists, false);
  if v_exists and p_user <> me.user_id and not public.access_can_manage_user(me, p_user) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  if not v_exists and public.is_staff(p_user) and not me.manage_all then
    -- Сотрудник других клубов, ещё не перенесённый в модель.
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'access_user_not_found' using errcode = 'P0002';
  end if;
  -- Должность и тип меняет только тот, кто управляет человеком; себе — данные.
  if p_user = me.user_id and not ('portal.admin' = any (me.rights)) then
    p := p - 'user_type' - 'position_id' - 'access_until';
  end if;

  if not v_exists then
    insert into public.portal_users (user_id, user_type, position_id, access_until, note, created_by, updated_by)
    values (p_user, nullif(p->>'user_type', ''), nullif(p->>'position_id', '')::uuid,
            nullif(p->>'access_until', '')::date, nullif(btrim(coalesce(p->>'note', '')), ''),
            auth.uid(), auth.uid());
  else
    update public.portal_users
       set user_type = case when p ? 'user_type' then nullif(p->>'user_type', '') else user_type end,
           position_id = case when p ? 'position_id' then nullif(p->>'position_id', '')::uuid else position_id end,
           access_until = case when p ? 'access_until' then nullif(p->>'access_until', '')::date else access_until end,
           note = case when p ? 'note' then nullif(btrim(coalesce(p->>'note', '')), '') else note end,
           updated_at = now(), updated_by = auth.uid()
     where user_id = p_user;
  end if;

  if p ? 'last_name' and p ? 'first_name' then
    v_name := btrim(btrim(coalesce(p->>'last_name', '')) || ' ' || btrim(coalesce(p->>'first_name', '')));
    if v_name = '' then
      raise exception 'access_name_required' using errcode = '22023';
    end if;
    update public.profiles set full_name = v_name where id = p_user;
  end if;
  if p ? 'phone' then
    update public.profiles set phone = nullif(btrim(coalesce(p->>'phone', '')), '') where id = p_user;
  end if;

  perform public.access_log_add(case when v_exists then 'user.update' else 'user.create' end,
    format(case when v_exists then 'Изменены данные — %s' else 'Добавлен в портал — %s' end,
           public.access_user_name(p_user)),
    p_user, null, jsonb_build_object('fields', p));
  perform public.access_guard(v_before);
end;
$$;

create or replace function public.access_user_status(p_user uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
begin
  if p_status not in ('active', 'blocked') then
    raise exception 'access_bad_status' using errcode = '22023';
  end if;
  if p_user = me.user_id then
    raise exception 'access_self' using errcode = '42501';
  end if;
  if not public.access_can_manage_user(me, p_user) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  update public.portal_users
     set status = p_status,
         blocked_at = case when p_status = 'blocked' then now() end,
         blocked_by = case when p_status = 'blocked' then auth.uid() end,
         blocked_reason = case when p_status = 'blocked' then nullif(btrim(coalesce(p_reason, '')), '') end,
         updated_at = now(), updated_by = auth.uid()
   where user_id = p_user;
  perform public.access_log_add(case when p_status = 'blocked' then 'user.block' else 'user.unblock' end,
    format(case when p_status = 'blocked' then 'Заблокирован — %s' else 'Разблокирован — %s' end,
           public.access_user_name(p_user)),
    p_user, null, jsonb_build_object('reason', p_reason));
  perform public.access_guard(v_before);
end;
$$;

-- Убрать из портала: назначения, подразделения, личные права; вход в
-- админку пропадает. Учётную запись (если больше ни к чему не привязана)
-- удаляет сервер админки.
create or replace function public.access_user_remove(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_name text := public.access_user_name(p_user);
begin
  if p_user = me.user_id then
    raise exception 'access_self' using errcode = '42501';
  end if;
  if not public.access_can_manage_user(me, p_user) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  delete from public.portal_users where user_id = p_user;
  perform public.access_log_add('user.remove', 'Убран из портала — ' || v_name, p_user);
  perform public.access_guard(v_before);
end;
$$;

-- Могу ли я управлять этим человеком (для сервера: смена почты, удаление).
create or replace function public.access_can_manage(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
begin
  select * into me from public.access_user_rights where user_id = auth.uid() and portal;
  if not found then
    return false;
  end if;
  return public.access_can_manage_user(me, p_user)
      or exists (select 1 from public.portal_users where user_id = p_user and created_by = me.user_id);
end;
$$;

-- 18) RPC: структура и сеть -----------------------------------------------------
create or replace function public.org_unit_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_row public.org_units;
begin
  if v_id is null then
    insert into public.org_units (parent_id, name, description, sort_order, created_by)
    values (nullif(p->>'parent_id', '')::uuid, p->>'name', nullif(btrim(coalesce(p->>'description', '')), ''),
            coalesce((p->>'sort_order')::int,
                     (select coalesce(max(sort_order) + 1, 0) from public.org_units
                       where parent_id is not distinct from nullif(p->>'parent_id', '')::uuid)),
            auth.uid())
    returning * into v_row;
  else
    update public.org_units
       set parent_id = case when p ? 'parent_id' then nullif(p->>'parent_id', '')::uuid else parent_id end,
           name = coalesce(p->>'name', name),
           description = case when p ? 'description' then nullif(btrim(coalesce(p->>'description', '')), '')
                              else description end,
           sort_order = coalesce((p->>'sort_order')::int, sort_order)
     where id = v_id
    returning * into v_row;
    if v_row.id is null then
      raise exception 'org_unit_not_found' using errcode = 'P0002';
    end if;
  end if;
  perform public.access_log_add(case when v_id is null then 'unit.create' else 'unit.update' end,
    format(case when v_id is null then 'Создано подразделение «%s»' else 'Изменено подразделение «%s»' end, v_row.name),
    null, null, jsonb_build_object('unit_id', v_row.id, 'parent_id', v_row.parent_id));
  perform public.access_guard(v_before);
  return v_row.id;
end;
$$;

create or replace function public.org_unit_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
  v_name text;
begin
  select name into v_name from public.org_units where id = p_id;
  if v_name is null then
    return;
  end if;
  if exists (select 1 from public.org_units where parent_id = p_id) then
    raise exception 'org_unit_has_children' using errcode = '23503';
  end if;
  delete from public.org_units where id = p_id;
  perform public.access_log_add('unit.delete', format('Удалено подразделение «%s»', v_name));
  perform public.access_guard(v_before);
end;
$$;

-- Человек в подразделении: роль (руководитель / заместитель / сотрудник) или
-- null — убрать.
create or replace function public.org_member_set(p_unit uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
begin
  if p_role is null then
    delete from public.org_unit_members where unit_id = p_unit and user_id = p_user;
  else
    insert into public.org_unit_members (unit_id, user_id, member_role)
    values (p_unit, p_user, p_role)
    on conflict (unit_id, user_id) do update set member_role = excluded.member_role;
  end if;
  perform public.access_log_add('member.set',
    format('%s — %s: %s', (select name from public.org_units where id = p_unit),
           public.access_user_name(p_user),
           case p_role when 'head' then 'руководитель' when 'deputy' then 'заместитель'
                       when 'member' then 'сотрудник' else 'убран' end),
    p_user, null, jsonb_build_object('unit_id', p_unit, 'member_role', p_role));
  perform public.access_guard(v_before);
end;
$$;

create or replace function public.org_position_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_row public.org_positions;
begin
  if v_id is null then
    insert into public.org_positions (name, description, sort_order)
    values (btrim(p->>'name'), nullif(btrim(coalesce(p->>'description', '')), ''),
            coalesce((select max(sort_order) + 1 from public.org_positions), 0))
    returning * into v_row;
  else
    update public.org_positions
       set name = btrim(coalesce(p->>'name', name)),
           description = case when p ? 'description' then nullif(btrim(coalesce(p->>'description', '')), '')
                              else description end,
           sort_order = coalesce((p->>'sort_order')::int, sort_order)
     where id = v_id
    returning * into v_row;
  end if;
  perform public.access_log_add('position.save', format('Должность «%s»', v_row.name));
  return v_row.id;
end;
$$;

create or replace function public.org_position_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
  v_name text;
begin
  select name into v_name from public.org_positions where id = p_id;
  delete from public.org_positions where id = p_id;
  if v_name is not null then
    perform public.access_log_add('position.delete', format('Удалена должность «%s»', v_name));
  end if;
  perform public.access_guard(v_before);
end;
$$;

create or replace function public.org_brand_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_row public.org_brands;
begin
  if v_id is null then
    insert into public.org_brands (name, short_name, color, sort_order)
    values (btrim(p->>'name'), nullif(btrim(coalesce(p->>'short_name', '')), ''), nullif(p->>'color', ''),
            coalesce((select max(sort_order) + 1 from public.org_brands), 0))
    returning * into v_row;
  else
    update public.org_brands
       set name = btrim(coalesce(p->>'name', name)),
           short_name = case when p ? 'short_name' then nullif(btrim(coalesce(p->>'short_name', '')), '')
                             else short_name end,
           color = case when p ? 'color' then nullif(p->>'color', '') else color end
     where id = v_id
    returning * into v_row;
  end if;
  perform public.access_log_add('brand.save', format('Бренд «%s»', v_row.name));
  return v_row.id;
end;
$$;

create or replace function public.org_brand_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
  v_name text;
begin
  select name into v_name from public.org_brands where id = p_id;
  if v_name is null then
    return;
  end if;
  if exists (select 1 from public.studios where brand_id = p_id) then
    raise exception 'org_brand_in_use' using errcode = '23503';
  end if;
  update public.access_assignments
     set scope_ids = array_remove(scope_ids, p_id)
   where scope_type = 'brands' and p_id = any (scope_ids);
  delete from public.org_brands where id = p_id;
  perform public.access_log_add('brand.delete', format('Удалён бренд «%s»', v_name));
  perform public.access_guard(v_before);
end;
$$;

-- Бренд, собственный / франшиза и город клуба.
create or replace function public.org_studio_save(p_studio uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
begin
  update public.studios
     set brand_id = case when p ? 'brand_id' then nullif(p->>'brand_id', '')::uuid else brand_id end,
         ownership = coalesce(nullif(p->>'ownership', ''), ownership),
         city = case when p ? 'city' then nullif(btrim(coalesce(p->>'city', '')), '') else city end
   where id = p_studio;
  perform public.access_log_add('studio.update',
    format('Клуб «%s»', (select name from public.studios where id = p_studio)),
    null, null, jsonb_build_object('studio_id', p_studio, 'fields', p));
  perform public.access_guard(v_before);
end;
$$;

-- Сроки: назначения «с / до» и «доступ до» — сервер админки зовёт раз в
-- несколько минут. Пересчитывает тех, у кого есть сроки (лишнего не пишет).
create or replace function public.access_sync_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_mark(array(
    select distinct u
      from public.access_assignments a
      cross join lateral public.access_assignment_user_ids(
        a.subject_type, a.user_id, a.unit_id, a.position_id, a.unit_members, a.with_subunits) u
     where a.valid_from is not null or a.valid_until is not null
    union
    select pu.user_id from public.portal_users pu where pu.access_until is not null));
  return public.access_flush();
end;
$$;

revoke all on function
  public.access_me(), public.access_users(), public.access_explain(uuid), public.access_user(uuid),
  public.access_roles_list(), public.access_log_list(uuid, integer), public.access_role_save(jsonb),
  public.access_role_delete(uuid), public.access_assignment_save(jsonb), public.access_assignment_delete(uuid),
  public.access_personal_save(uuid, jsonb), public.access_user_save(uuid, jsonb),
  public.access_user_status(uuid, text, text), public.access_user_remove(uuid), public.access_can_manage(uuid),
  public.org_unit_save(jsonb), public.org_unit_delete(uuid), public.org_member_set(uuid, uuid, text),
  public.org_position_save(jsonb), public.org_position_delete(uuid), public.org_brand_save(jsonb),
  public.org_brand_delete(uuid), public.org_studio_save(uuid, jsonb)
  from public, anon;
grant execute on function
  public.access_me(), public.access_users(), public.access_explain(uuid), public.access_user(uuid),
  public.access_roles_list(), public.access_log_list(uuid, integer), public.access_role_save(jsonb),
  public.access_role_delete(uuid), public.access_assignment_save(jsonb), public.access_assignment_delete(uuid),
  public.access_personal_save(uuid, jsonb), public.access_user_save(uuid, jsonb),
  public.access_user_status(uuid, text, text), public.access_user_remove(uuid), public.access_can_manage(uuid),
  public.org_unit_save(jsonb), public.org_unit_delete(uuid), public.org_member_set(uuid, uuid, text),
  public.org_position_save(jsonb), public.org_position_delete(uuid), public.org_brand_save(jsonb),
  public.org_brand_delete(uuid), public.org_studio_save(uuid, jsonb)
  to authenticated, service_role;
revoke all on function public.access_sync_due() from public, anon, authenticated;
grant execute on function public.access_sync_due() to service_role;

-- 19) Стартовые роли ---------------------------------------------------------------
-- Из ТЗ портала XFIT (п. 5.7.2) и схемы ролей Битрикс24 Lady Stretch;
-- все, кроме суперадминистратора, можно менять и удалять.
create or replace function public.access_seed_role(
  _key text, _name text, _description text, _color text, _sort integer, _locked boolean, _perms text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_perm text;
begin
  select id into v_id from public.access_roles where system_key = _key;
  if v_id is not null then
    return v_id;
  end if;
  -- Имя занято своей ролью — стартовую не заводим.
  if exists (select 1 from public.access_roles
              where lower(btrim(name)) = lower(btrim(_name)) and personal_user_id is null) then
    return null;
  end if;
  insert into public.access_roles (name, description, color, system_key, locked, sort_order)
  values (_name, _description, _color, _key, _locked, _sort)
  returning id into v_id;
  foreach v_perm in array _perms loop
    insert into public.access_role_permissions (role_id, perm_key, level)
    values (v_id, split_part(v_perm, '=', 1), coalesce(nullif(split_part(v_perm, '=', 2), ''), 'on'));
  end loop;
  return v_id;
end;
$$;
revoke all on function public.access_seed_role(text, text, text, text, integer, boolean, text[])
  from public, anon, authenticated;

select public.access_seed_role('superadmin', 'Суперадминистратор',
  'Всё в портале: все клубы, все разделы, роли, структура, суперадминистраторы.', '#111827', 0, true,
  array['portal.admin', 'studio.tier=owner', 'club.all']);
select public.access_seed_role('portal_admin', 'Администратор портала',
  'Пользователи, роли, оргструктура и клубы сети — без доступа к данным клубов.', '#334155', 10, false,
  array['users.manage', 'roles.manage', 'structure.manage', 'studios.create', 'audit.view']);
select public.access_seed_role('studio_owner', 'Владелец клуба',
  'Партнёр или управляющий: всё в своих клубах и сотрудники этих клубов.', '#e5007e', 20, false,
  array['studio.tier=owner', 'club.all', 'users.manage', 'app.content', 'staff.directory', 'scripts=edit']);
select public.access_seed_role('studio_manager', 'Управляющий клубом',
  'Все разделы клуба, мобильное приложение клуба, сотрудники клуба.', '#db2777', 30, false,
  array['studio.tier=admin', 'club.all', 'users.manage', 'app.content', 'scripts=view']);
select public.access_seed_role('studio_admin', 'Администратор клуба',
  'Ресепшн: расписание, клиенты, абонементы, продажи, касса, обратная связь.', '#f59e0b', 40, false,
  array['studio.tier=admin', 'club.schedule', 'club.clients', 'club.client-memberships', 'club.sales',
        'club.other-sales', 'club.bookings-log', 'club.cash', 'club.feedback', 'club.requests', 'scripts=view']);
select public.access_seed_role('trainer', 'Тренер',
  'Расписание и история записей своего клуба.', '#10b981', 50, false,
  array['studio.tier=trainer', 'club.schedule', 'club.bookings-log']);
select public.access_seed_role('curator', 'Куратор клубов',
  'Эксперт отдела развития: показатели и работа закреплённых клубов.', '#6366f1', 60, false,
  array['studio.tier=admin', 'club.dashboard', 'club.schedule', 'club.clients', 'club.client-memberships',
        'club.sales', 'club.feedback', 'club.requests', 'club.nps']);
select public.access_seed_role('kb_admin', 'Администратор знаний',
  'Базы знаний и Академия целиком.', '#0ea5e9', 70, false,
  array['kb.admin', 'academy.admin']);
select public.access_seed_role('trainer_academy', 'Наставник Академии',
  'Проверяет свободные ответы в тестах.', '#14b8a6', 80, false,
  array['academy.review']);
select public.access_seed_role('marketing', 'Маркетолог',
  'Мобильное приложение: новости, услуги, пуши — в клубах назначения.', '#a855f7', 90, false,
  array['studio.tier=trainer', 'app.content']);

-- 20) Перенос текущих доступов ---------------------------------------------------
-- Только тех, кого модель ещё не знает. Итог пересчёта совпадает с прежним:
-- владелец всех клубов — «Суперадминистратор»; владелец части клубов —
-- «Владелец клуба» в них и личные права администратора сети (так раньше
-- давала роль владельца); прочие — роль «… (перенесено)» на каждое сочетание
-- «уровень + разделы клуба» и личные права (разделы рейки, базы, Академия).
create or replace function public.access_import_legacy(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  u record;
  s record;
  v_n integer := 0;
  v_all_studios integer := (select count(*) from public.studios);
  v_owned uuid[];
  v_rail text[];
  v_has_rail boolean;
  v_perms text[];
  v_role uuid;
  v_name text;
  v_personal uuid;
  v_key text;
  v_sections text[];
begin
  for u in
    select distinct ur.user_id
      from public.user_roles ur
     where ur.role::text in ('owner', 'admin', 'trainer')
       and (p_user is null or ur.user_id = p_user)
       and not exists (select 1 from public.portal_users pu where pu.user_id = ur.user_id)
  loop
    v_n := v_n + 1;
    insert into public.portal_users (user_id, note) values (u.user_id, null);

    select coalesce(array_agg(distinct studio_id), '{}') into v_owned
      from public.user_roles where user_id = u.user_id and role = 'owner';

    if cardinality(v_owned) > 0 and cardinality(v_owned) = v_all_studios then
      insert into public.access_assignments (role_id, subject_type, user_id, scope_type, note)
      values ((select id from public.access_roles where system_key = 'superadmin'), 'user', u.user_id, 'all',
              'Перенесено из «Доступов»: владелец всех клубов');
      continue;
    end if;

    if cardinality(v_owned) > 0 then
      insert into public.access_assignments (role_id, subject_type, user_id, scope_type, scope_ids, note)
      values ((select id from public.access_roles where system_key = 'studio_owner'), 'user', u.user_id,
              'studios', v_owned, 'Перенесено из «Доступов»');
    end if;

    -- Разделы рейки: строки нет — все.
    select sections into v_rail from public.admin_permissions where user_id = u.user_id;
    v_has_rail := found;

    -- Клубы, где не владелец: роль на сочетание «уровень + разделы».
    for s in
      select ur.studio_id,
             (array['trainer', 'admin', 'owner'])[max(public.access_tier_rank(ur.role::text))] as tier
        from public.user_roles ur
       where ur.user_id = u.user_id and ur.role::text in ('admin', 'trainer')
         and not (ur.studio_id = any (v_owned))
       group by ur.studio_id
    loop
      if v_has_rail and not ('club' = any (v_rail)) then
        v_sections := '{}';
      else
        select sp.sections into v_sections
          from public.admin_studio_permissions sp
         where sp.user_id = u.user_id and sp.studio_id = s.studio_id;
        if not found then
          v_sections := null;
        end if;
      end if;
      v_key := 'legacy:' || s.tier || ':' || case when v_sections is null then '*' else coalesce(
        (select string_agg(x, ',' order by x) from unnest(v_sections) x), '') end;
      select id into v_role from public.access_roles where system_key = v_key;
      if v_role is null then
        v_name := case s.tier when 'admin' then 'Администратор' else 'Сотрудник' end
          || case when v_sections is null then ' — все разделы клуба'
                  when cardinality(v_sections) = 0 then ' — без разделов клуба'
                  else ' — разделов: ' || cardinality(v_sections) end
          || ' (перенесено)';
        while exists (select 1 from public.access_roles
                       where lower(name) = lower(v_name) and personal_user_id is null) loop
          v_name := v_name || ' ·';
        end loop;
        v_perms := array['studio.tier=' || s.tier]
          || case when v_sections is null then array['club.all']
                  else array(select 'club.' || x from unnest(v_sections) x
                              where exists (select 1 from public.access_permissions c where c.key = 'club.' || x)) end;
        v_role := public.access_seed_role(v_key, v_name,
          'Создана при переносе прежних «Доступов». Переименуйте или замените стартовой ролью.',
          '#64748b', 500, false, v_perms);
      end if;
      if exists (select 1 from public.access_assignments
                  where role_id = v_role and subject_type = 'user' and user_id = u.user_id) then
        update public.access_assignments
           set scope_ids = scope_ids || s.studio_id
         where role_id = v_role and subject_type = 'user' and user_id = u.user_id;
      else
        insert into public.access_assignments (role_id, subject_type, user_id, scope_type, scope_ids, note)
        values (v_role, 'user', u.user_id, 'studios', array[s.studio_id], 'Перенесено из «Доступов»');
      end if;
    end loop;

    -- Личные права: разделы рейки, базы знаний, Академия; владельцу части
    -- клубов — права администратора сети, как раньше давала его роль.
    v_perms := '{}';
    if cardinality(v_owned) > 0 then
      v_perms := array['staff.directory', 'app.content', 'scripts=edit', 'kb.admin', 'academy.admin',
                       'studios.create', 'audit.view'];
    else
      if not v_has_rail or 'staff' = any (v_rail) then v_perms := v_perms || 'staff.directory'::text; end if;
      if not v_has_rail or 'app' = any (v_rail) then v_perms := v_perms || 'app.content'::text; end if;
      if not v_has_rail or 'scripts-edit' = any (v_rail) then
        v_perms := v_perms || 'scripts=edit'::text;
      elsif 'scripts' = any (v_rail) then
        v_perms := v_perms || 'scripts=view'::text;
      end if;
      select v_perms || coalesce(array_agg(case when can_create then 'academy.create' end)
                                 filter (where can_create), '{}')
                      || coalesce(array_agg(case when can_review then 'academy.review' end)
                                 filter (where can_review), '{}')
        into v_perms
        from public.acad_staff where user_id = u.user_id;
    end if;
    if cardinality(v_perms) > 0 or exists (
         select 1 from public.kb_grants g
          where g.subject_type = 'user' and g.subject_id = u.user_id and g.node_id is null) then
      insert into public.access_roles (name, personal_user_id)
      values ('Личные права: ' || public.access_user_name(u.user_id), u.user_id)
      returning id into v_personal;
      insert into public.access_assignments (role_id, subject_type, user_id, scope_type, note)
      values (v_personal, 'user', u.user_id, 'all', 'Перенесено из «Доступов»');
      insert into public.access_role_permissions (role_id, perm_key, level)
      select v_personal, split_part(x, '=', 1), coalesce(nullif(split_part(x, '=', 2), ''), 'on')
        from unnest(v_perms) x;
      if cardinality(v_owned) = 0 then
        insert into public.access_role_permissions (role_id, perm_key, target_id, level)
        select v_personal, 'kb.base', g.base_id, g.level
          from public.kb_grants g
         where g.subject_type = 'user' and g.subject_id = u.user_id and g.node_id is null;
      end if;
    end if;
  end loop;

  perform public.access_flush();
  if v_n > 0 then
    insert into public.access_log (action, summary, details)
    values ('import', format('Перенесены прежние «Доступы»: %s чел.', v_n), jsonb_build_object('users', v_n));
  end if;
  return v_n;
end;
$$;
revoke all on function public.access_import_legacy(uuid) from public, anon, authenticated;
grant execute on function public.access_import_legacy(uuid) to service_role;

-- Перенос — один раз, при выкатке.
do $$
begin
  if not exists (select 1 from public.portal_users) then
    perform public.access_import_legacy(null);
  end if;
end;
$$;

notify pgrst, 'reload schema';
