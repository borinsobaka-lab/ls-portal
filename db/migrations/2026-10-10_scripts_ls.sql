-- ============================================================================
-- «Скрипты LS» — скрипты администраторов студий Lady Stretch (перенос из
-- «Аудиоаналитики», решение владельца 2026-10-10).
--
-- Что администратор пишет клиенту в чат и говорит по телефону: разделы
-- (рейка админки → «Скрипты LS», меню раздела — список разделов), в разделе —
-- текстовые скрипты на трёх языках (RU/EN/GE) с вариантами по студиям, или
-- один сценарий звонка с ветвлениями. Раздел общий для студий — без studio_id.
--
-- Доступ — разделы рейки в «Доступах» (admin_permissions, has_admin_section):
--   'scripts'      — читать, копировать, предлагать правки, вести звонки;
--   'scripts-edit' — правка скриптов, разделов, сценариев и настроек.
-- Нет строки прав — открыто всё (как у остальных разделов рейки), владельцу —
-- всё. Граница — RLS ниже, интерфейс только прячет кнопки.
--
-- Таблицы:
--   scripts_sections    — разделы; kind = 'text' | 'call', у звонка flow
--                         (сценарий целиком одним JSONB);
--   scripts_items       — скрипты: варианты по студиям → сообщения → языки
--                         (variants JSONB — читают и сохраняют целиком);
--   scripts_changes     — хронология: каждое создание, правка, удаление
--                         скрипта и правка сценария; пишут только триггеры;
--   scripts_suggestions — «Предложить изменения» от сотрудников;
--   scripts_seen        — когда сотрудник последний раз смотрел предложения
--                         (счётчик новых у каждого свой);
--   scripts_copies      — каждое нажатие «Копировать» (статистика);
--   scripts_call_runs   — проход сценария звонка по шагам (статистика);
--   scripts_settings    — синглтон: названия студий и имена администраторов
--                         на трёх языках, свои переменные ({цена} и т. п.).
--
-- Кто и когда правил (updated_by, author, user_name) ставят триггеры по
-- профилю вошедшего — из браузера подпись не подделать.
--
-- Стартового набора нет — скрипты заводят в портале или импортом в
-- «Настройках скриптов» (scripts_import).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Права ----------------------------------------------------------------------
create or replace function public.scripts_can_read(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_admin_section(_user_id, 'scripts')
$$;

create or replace function public.scripts_can_edit(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_admin_section(_user_id, 'scripts')
     and public.has_admin_section(_user_id, 'scripts-edit')
$$;

-- Подпись того, кто вошёл: ФИО из профиля, иначе почта.
create or replace function public.scripts_author_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''))
       from public.profiles p where p.id = auth.uid()),
    'сотрудник'
  )
$$;

revoke all on function public.scripts_can_read(uuid) from public, anon;
revoke all on function public.scripts_can_edit(uuid) from public, anon;
revoke all on function public.scripts_author_name() from public, anon;
grant execute on function public.scripts_can_read(uuid) to authenticated, service_role;
grant execute on function public.scripts_can_edit(uuid) to authenticated, service_role;
grant execute on function public.scripts_author_name() to authenticated, service_role;

-- Хронологию не пишем при импорте и стартовой загрузке (флаг транзакции).
create or replace function public.scripts_journal_off()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('scripts.skip_journal', true), '') = 'on'
$$;

-- 2) Таблицы ----------------------------------------------------------------------
create table if not exists public.scripts_sections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 255),
  -- Ключ иконки в меню (calendar-add, wallet-money…); пусто — по умолчанию.
  icon text not null default '' check (icon ~ '^[a-z0-9-]{0,40}$'),
  position integer not null default 0,
  kind text not null default 'text' check (kind in ('text', 'call')),
  -- Только у звонка: {start, nodes: [{id, title, group, text, hint, client, answers}]}.
  flow jsonb,
  flow_updated_at timestamptz,
  flow_updated_by text not null default '',
  flow_change_note text not null default '',
  created_at timestamptz not null default now(),
  constraint scripts_sections_flow_kind check (
    (kind = 'call') = (flow is not null)
    and (flow is null or jsonb_typeof(flow -> 'nodes') = 'array')
  )
);
create index if not exists scripts_sections_position_idx on public.scripts_sections (position);

create table if not exists public.scripts_items (
  id uuid primary key default gen_random_uuid(),
  -- Раздел со скриптами не удаляется (триггер ниже говорит почему).
  section_id uuid not null references public.scripts_sections (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 255),
  kind text not null default 'chat' check (kind in ('chat', 'call', 'task', 'info')),
  keywords text not null default '',
  note text not null default '',
  follow_up text not null default '',
  -- [{label, messages: [{label, ru, en, ka}]}]; label варианта — студия.
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  position integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  -- Что изменили при последней правке — внизу карточки.
  change_note text not null default ''
);
create index if not exists scripts_items_section_idx on public.scripts_items (section_id, position);

create table if not exists public.scripts_changes (
  id uuid primary key default gen_random_uuid(),
  -- Скрипт или раздел-звонок; удалённый остаётся в журнале.
  item_id uuid,
  item_title text not null default '',
  action text not null check (action in ('created', 'updated', 'deleted')),
  before jsonb,
  after jsonb,
  change_note text not null default '',
  author text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists scripts_changes_time_idx on public.scripts_changes (created_at desc, id desc);

create table if not exists public.scripts_suggestions (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name text not null default '',
  -- Скрипт, к которому предложение; название — на момент отправки.
  item_id uuid,
  item_title text not null default '',
  text text not null check (length(btrim(text)) between 3 and 3000),
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text not null default ''
);
create index if not exists scripts_suggestions_time_idx on public.scripts_suggestions (created_at desc, id desc);

create table if not exists public.scripts_seen (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  suggestions_seen_at timestamptz not null default now()
);

create table if not exists public.scripts_copies (
  id uuid primary key default gen_random_uuid(),
  item_id uuid,
  item_title text not null default '',
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  user_name text not null default '',
  lang text not null check (lang in ('ru', 'en', 'ka')),
  -- Вариант какой студии скопировали.
  studio text not null default '' check (length(studio) <= 120),
  source text not null default 'card' check (source in ('card')),
  created_at timestamptz not null default now()
);
create index if not exists scripts_copies_time_idx on public.scripts_copies (created_at);
create index if not exists scripts_copies_user_time_idx on public.scripts_copies (user_id, created_at);

create table if not exists public.scripts_call_runs (
  -- id задаёт админка: путь шлётся после каждого шага под одним id.
  id uuid primary key,
  -- Без внешнего ключа: удалили раздел — статистика остаётся под названием.
  section_id uuid not null,
  section_title text not null default '',
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  user_name text not null default '',
  studio text not null default '',
  lang text not null default 'ru',
  -- Версия сценария (время его правки) на момент звонка.
  flow_version timestamptz,
  -- [{id, title, group, answer, at}] — пройденные блоки по порядку.
  path jsonb not null default '[]'::jsonb check (jsonb_typeof(path) = 'array'),
  steps integer not null default 0,
  last_node_id text not null default '',
  last_node_title text not null default '',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Дошли до конца сценария или нажали «Новый звонок».
  ended_at timestamptz
);
create index if not exists scripts_call_runs_time_idx on public.scripts_call_runs (started_at);
create index if not exists scripts_call_runs_section_time_idx on public.scripts_call_runs (section_id, started_at);
create index if not exists scripts_call_runs_user_time_idx on public.scripts_call_runs (user_id, started_at);

create table if not exists public.scripts_settings (
  id boolean primary key default true check (id),
  -- {studios: [{name, ru, en, ka}], admins: {user_id: {ru, en, ka}}, variables: [...]}
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz,
  updated_by text not null default ''
);

-- 3) Триггеры -----------------------------------------------------------------------
-- Версия скрипта для хронологии — всё, что видно в карточке.
create or replace function public.scripts_item_snapshot(_item public.scripts_items)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'title', _item.title,
    'kind', _item.kind,
    'section', coalesce((select s.title from public.scripts_sections s where s.id = _item.section_id), ''),
    'keywords', _item.keywords,
    'note', _item.note,
    'follow_up', _item.follow_up,
    'variants', _item.variants
  )
$$;

create or replace function public.scripts_items_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _kind text;
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'position') = (to_jsonb(old) - 'position') then
    return new; -- перестановка: ни подписи, ни журнала
  end if;

  select kind into _kind from public.scripts_sections where id = new.section_id;
  if _kind = 'call' then
    raise exception 'В разделе-звонке один сценарий — текстовые скрипты сюда не добавляются';
  end if;

  if public.scripts_journal_off() then
    return new;
  end if;

  if tg_op = 'INSERT' or new.section_id is distinct from old.section_id then
    -- Новый и перенесённый скрипт встаёт в конец раздела: там его и ищут.
    new.position := coalesce(
      (select max(position) + 1 from public.scripts_items
        where section_id = new.section_id and id <> new.id), 0);
  end if;

  new.title := btrim(new.title);
  new.updated_at := now();
  new.updated_by := public.scripts_author_name();
  if tg_op = 'INSERT' then
    new.change_note := coalesce(nullif(btrim(new.change_note), ''), 'Новый скрипт');
  elsif btrim(new.change_note) = '' then
    -- Скрипт меняется у всех сразу: без пары слов человек у стойки не
    -- поймёт, ошибка это или так задумано.
    raise exception 'Опишите, что изменили — это увидят все на карточке скрипта';
  end if;
  return new;
end;
$$;

create or replace function public.scripts_items_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.scripts_journal_off() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.scripts_changes (item_id, item_title, action, before, after, change_note, author)
    values (new.id, new.title, 'created', null, public.scripts_item_snapshot(new),
            new.change_note, public.scripts_author_name());
  elsif tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'position') = (to_jsonb(old) - 'position') then
      return null;
    end if;
    insert into public.scripts_changes (item_id, item_title, action, before, after, change_note, author)
    values (new.id, new.title, 'updated', public.scripts_item_snapshot(old),
            public.scripts_item_snapshot(new), new.change_note, public.scripts_author_name());
  else
    insert into public.scripts_changes (item_id, item_title, action, before, after, change_note, author)
    values (old.id, old.title, 'deleted', public.scripts_item_snapshot(old), null,
            'Скрипт удалён', public.scripts_author_name());
  end if;
  return null;
end;
$$;

drop trigger if exists scripts_items_before on public.scripts_items;
create trigger scripts_items_before
  before insert or update on public.scripts_items
  for each row execute function public.scripts_items_before();

drop trigger if exists scripts_items_after on public.scripts_items;
create trigger scripts_items_after
  after insert or update or delete on public.scripts_items
  for each row execute function public.scripts_items_after();

create or replace function public.scripts_sections_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.scripts_items where section_id = old.id) then
      raise exception 'В разделе есть скрипты — сначала перенесите их в другой раздел или удалите';
    end if;
    return old;
  end if;

  new.title := btrim(new.title);
  if public.scripts_journal_off() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.position := coalesce((select max(position) + 1 from public.scripts_sections), 0);
    if new.kind = 'call' then
      new.flow_updated_at := now();
      new.flow_updated_by := public.scripts_author_name();
      new.flow_change_note := coalesce(nullif(btrim(new.flow_change_note), ''), 'Новый сценарий звонка');
    end if;
    return new;
  end if;

  if new.kind <> old.kind then
    raise exception 'Тип раздела не меняется: создайте новый раздел';
  end if;
  if new.flow is distinct from old.flow then
    if btrim(new.flow_change_note) = '' then
      raise exception 'Опишите, что изменили в сценарии — это увидят в хронологии';
    end if;
    new.flow_updated_at := now();
    new.flow_updated_by := public.scripts_author_name();
  end if;
  return new;
end;
$$;

create or replace function public.scripts_sections_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.scripts_journal_off() or new.flow is not distinct from old.flow then
    return null;
  end if;
  insert into public.scripts_changes (item_id, item_title, action, before, after, change_note, author)
  values (
    new.id, new.title, 'updated',
    jsonb_build_object('title', old.title, 'kind', 'call', 'section', old.title, 'flow', old.flow),
    jsonb_build_object('title', new.title, 'kind', 'call', 'section', new.title, 'flow', new.flow),
    new.flow_change_note, public.scripts_author_name()
  );
  return null;
end;
$$;

drop trigger if exists scripts_sections_before on public.scripts_sections;
create trigger scripts_sections_before
  before insert or update or delete on public.scripts_sections
  for each row execute function public.scripts_sections_before();

drop trigger if exists scripts_sections_after on public.scripts_sections;
create trigger scripts_sections_after
  after update on public.scripts_sections
  for each row execute function public.scripts_sections_after();

-- Подписи и названия в предложениях, копированиях, настройках — с сервера.
create or replace function public.scripts_suggestions_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.author_id := auth.uid();
    new.author_name := public.scripts_author_name();
    new.text := btrim(new.text);
    new.status := 'open';
    new.created_at := now();
    new.item_title := coalesce(
      (select title from public.scripts_items where id = new.item_id), new.item_title, '');
    return new;
  end if;
  -- Правится только отметка «Сделано».
  new.author_id := old.author_id;
  new.author_name := old.author_name;
  new.item_id := old.item_id;
  new.item_title := old.item_title;
  new.text := old.text;
  new.created_at := old.created_at;
  if new.status is distinct from old.status then
    new.resolved_at := case when new.status = 'done' then now() end;
    new.resolved_by := case when new.status = 'done' then public.scripts_author_name() else '' end;
  else
    new.resolved_at := old.resolved_at;
    new.resolved_by := old.resolved_by;
  end if;
  return new;
end;
$$;

drop trigger if exists scripts_suggestions_before on public.scripts_suggestions;
create trigger scripts_suggestions_before
  before insert or update on public.scripts_suggestions
  for each row execute function public.scripts_suggestions_before();

create or replace function public.scripts_copies_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  new.user_name := public.scripts_author_name();
  new.created_at := now();
  new.item_title := coalesce(
    (select title from public.scripts_items where id = new.item_id), new.item_title, '');
  return new;
end;
$$;

drop trigger if exists scripts_copies_before on public.scripts_copies;
create trigger scripts_copies_before
  before insert on public.scripts_copies
  for each row execute function public.scripts_copies_before();

create or replace function public.scripts_settings_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.scripts_journal_off() then
    new.updated_at := now();
    new.updated_by := public.scripts_author_name();
  end if;
  return new;
end;
$$;

drop trigger if exists scripts_settings_before on public.scripts_settings;
create trigger scripts_settings_before
  before insert or update on public.scripts_settings
  for each row execute function public.scripts_settings_before();

-- 4) RLS --------------------------------------------------------------------------
revoke all on public.scripts_sections, public.scripts_items, public.scripts_changes,
  public.scripts_suggestions, public.scripts_seen, public.scripts_copies,
  public.scripts_call_runs, public.scripts_settings from anon, authenticated;

grant select, insert, update, delete on public.scripts_sections, public.scripts_items to authenticated;
grant select on public.scripts_changes to authenticated;
grant select, insert, update on public.scripts_suggestions, public.scripts_seen to authenticated;
grant select, insert on public.scripts_copies to authenticated;
grant select, insert, update on public.scripts_call_runs to authenticated;
grant select, insert, update on public.scripts_settings to authenticated;
grant all on public.scripts_sections, public.scripts_items, public.scripts_changes,
  public.scripts_suggestions, public.scripts_seen, public.scripts_copies,
  public.scripts_call_runs, public.scripts_settings to service_role;

alter table public.scripts_sections enable row level security;
alter table public.scripts_items enable row level security;
alter table public.scripts_changes enable row level security;
alter table public.scripts_suggestions enable row level security;
alter table public.scripts_seen enable row level security;
alter table public.scripts_copies enable row level security;
alter table public.scripts_call_runs enable row level security;
alter table public.scripts_settings enable row level security;

do $$
declare
  t text;
begin
  -- Читают все с разделом, правят — с правкой.
  foreach t in array array['scripts_sections', 'scripts_items', 'scripts_settings'] loop
    execute format('drop policy if exists %I on public.%I', t || ' read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.scripts_can_read(auth.uid()))',
      t || ' read', t);
    execute format('drop policy if exists %I on public.%I', t || ' edit', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.scripts_can_edit(auth.uid())) with check (public.scripts_can_edit(auth.uid()))',
      t || ' edit', t);
  end loop;
end;
$$;

-- Хронологию видят все: «почему текст стал другим» — вопрос и того, кто читает.
drop policy if exists "scripts_changes read" on public.scripts_changes;
create policy "scripts_changes read" on public.scripts_changes
  for select to authenticated using (public.scripts_can_read(auth.uid()));

-- Предложить может любой, кто видит скрипты; отмечает сделанным — правка.
drop policy if exists "scripts_suggestions read" on public.scripts_suggestions;
create policy "scripts_suggestions read" on public.scripts_suggestions
  for select to authenticated using (public.scripts_can_read(auth.uid()));
drop policy if exists "scripts_suggestions insert" on public.scripts_suggestions;
create policy "scripts_suggestions insert" on public.scripts_suggestions
  for insert to authenticated with check (public.scripts_can_read(auth.uid()));
drop policy if exists "scripts_suggestions resolve" on public.scripts_suggestions;
create policy "scripts_suggestions resolve" on public.scripts_suggestions
  for update to authenticated
  using (public.scripts_can_edit(auth.uid())) with check (public.scripts_can_edit(auth.uid()));

drop policy if exists "scripts_seen own" on public.scripts_seen;
create policy "scripts_seen own" on public.scripts_seen
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.scripts_can_read(auth.uid()));

-- Статистику копирований видят все с разделом.
drop policy if exists "scripts_copies read" on public.scripts_copies;
create policy "scripts_copies read" on public.scripts_copies
  for select to authenticated using (public.scripts_can_read(auth.uid()));
drop policy if exists "scripts_copies insert" on public.scripts_copies;
create policy "scripts_copies insert" on public.scripts_copies
  for insert to authenticated with check (public.scripts_can_read(auth.uid()));

-- Звонки: свои — все, чужие — с правкой (она же видит статистику всех).
drop policy if exists "scripts_call_runs read" on public.scripts_call_runs;
create policy "scripts_call_runs read" on public.scripts_call_runs
  for select to authenticated
  using (user_id = auth.uid() or public.scripts_can_edit(auth.uid()));
drop policy if exists "scripts_call_runs insert" on public.scripts_call_runs;
create policy "scripts_call_runs insert" on public.scripts_call_runs
  for insert to authenticated
  with check (user_id = auth.uid() and public.scripts_can_read(auth.uid()));
drop policy if exists "scripts_call_runs update own" on public.scripts_call_runs;
create policy "scripts_call_runs update own" on public.scripts_call_runs
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 5) RPC -------------------------------------------------------------------------
-- Порядок разделов или скриптов раздела — целиком и атомарно. Расхождение
-- значит, что список поменяли в соседней вкладке: вслепую не переставляем.
create or replace function public.scripts_reorder(_section_id uuid, _ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.scripts_can_edit(auth.uid()) then
    raise exception 'Нет права правки скриптов';
  end if;
  if _section_id is null then
    if (select count(*) from public.scripts_sections) <> cardinality(_ids)
       or exists (select 1 from public.scripts_sections where id <> all (_ids)) then
      raise exception 'Список разделов изменился — обновите страницу';
    end if;
    update public.scripts_sections s set position = t.ord - 1
      from unnest(_ids) with ordinality as t(id, ord)
     where s.id = t.id and s.position <> t.ord - 1;
  else
    if (select count(*) from public.scripts_items where section_id = _section_id) <> cardinality(_ids)
       or exists (select 1 from public.scripts_items
                   where section_id = _section_id and id <> all (_ids)) then
      raise exception 'Список скриптов изменился — обновите страницу';
    end if;
    update public.scripts_items i set position = t.ord - 1
      from unnest(_ids) with ordinality as t(id, ord)
     where i.id = t.id and i.position <> t.ord - 1;
  end if;
end;
$$;

-- Путь звонка целиком, после каждого шага. Повторная отправка того же id —
-- обновление (шаг назад убирает шаг и в статистике); чужой звонок не
-- перезаписать даже по id.
create or replace function public.scripts_save_call_run(
  _id uuid,
  _section_id uuid,
  _path jsonb,
  _finished boolean,
  _studio text default '',
  _lang text default 'ru'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  _title text;
  _version timestamptz;
  _last jsonb;
  _now timestamptz := now();
begin
  if jsonb_typeof(_path) <> 'array' or jsonb_array_length(_path) not between 1 and 300 then
    raise exception 'Путь звонка: от 1 до 300 шагов';
  end if;
  _last := _path -> -1;
  select title, flow_updated_at into _title, _version
    from public.scripts_sections where id = _section_id;
  insert into public.scripts_call_runs as r (
    id, section_id, section_title, user_id, user_name, studio, lang, flow_version,
    path, steps, last_node_id, last_node_title, started_at, updated_at, ended_at
  ) values (
    _id, _section_id, coalesce(_title, ''), auth.uid(), public.scripts_author_name(),
    left(coalesce(_studio, ''), 120), case when _lang in ('ru', 'en', 'ka') then _lang else 'ru' end,
    _version, _path, jsonb_array_length(_path), left(coalesce(_last ->> 'id', ''), 40),
    left(coalesce(_last ->> 'title', ''), 120), _now, _now, case when _finished then _now end
  )
  on conflict (id) do update set
    section_title = coalesce(_title, r.section_title),
    user_name = excluded.user_name,
    path = excluded.path,
    steps = excluded.steps,
    last_node_id = excluded.last_node_id,
    last_node_title = excluded.last_node_title,
    updated_at = _now,
    ended_at = case when _finished then coalesce(r.ended_at, _now) end
  where r.user_id = auth.uid();
end;
$$;

-- Статистика копирований за период: итог по языкам, рейтинг скриптов (у
-- всех или у одного сотрудника) и список сотрудников (без фильтра по
-- сотруднику — из него выбирают). Названия — текущие; удалённый скрипт —
-- под последним названием.
create or replace function public.scripts_copy_stats(
  _from timestamptz default null,
  _to timestamptz default null,
  _user uuid default null,
  _lang text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select * from public.scripts_copies
     where (_from is null or created_at >= _from)
       and (_to is null or created_at < _to)
       and (_lang is null or lang = _lang)
  ),
  mine as (
    select * from base where _user is null or user_id = _user
  ),
  items as (
    select m.item_id,
           coalesce(max(i.title), max(m.item_title)) as title,
           coalesce(max(s.title), '') as section,
           bool_and(i.id is null) as deleted,
           count(*) as total,
           count(*) filter (where m.lang = 'ru') as ru,
           count(*) filter (where m.lang = 'en') as en,
           count(*) filter (where m.lang = 'ka') as ka
      from mine m
      left join public.scripts_items i on i.id = m.item_id
      left join public.scripts_sections s on s.id = i.section_id
     group by m.item_id
  ),
  users as (
    select user_id, max(user_name) as name,
           count(*) as total,
           count(*) filter (where lang = 'ru') as ru,
           count(*) filter (where lang = 'en') as en,
           count(*) filter (where lang = 'ka') as ka
      from base
     group by user_id
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'total', count(*),
        'ru', count(*) filter (where lang = 'ru'),
        'en', count(*) filter (where lang = 'en'),
        'ka', count(*) filter (where lang = 'ka'))
        from mine),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', item_id, 'title', title, 'section', section, 'deleted', deleted,
        'total', total, 'ru', ru, 'en', en, 'ka', ka) order by total desc, title)
        from items), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', user_id, 'name', name, 'total', total, 'ru', ru, 'en', en, 'ka', ka)
        order by total desc, name)
        from users), '[]'::jsonb)
  )
$$;

-- Статистика звонков за период: сценарии (живые и удалённые, по которым
-- звонили), выбранный (по умолчанию — где больше всего звонков), кто звонил,
-- и по завершённым звонкам выбранного: сколько, сколько шагов в среднем, до
-- каких блоков доходили, на каких заканчивали. Идущие сейчас (не закончены и
-- трогали меньше получаса назад) не считаются. Воронку по этапам сценария
-- складывает админка (lib/scripts/call-stats.ts). Без правки RLS отдаёт
-- только свои звонки.
create or replace function public.scripts_call_stats(
  _section uuid default null,
  _from timestamptz default null,
  _to timestamptz default null,
  _user uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  _sections jsonb;
  _chosen uuid;
  _out jsonb;
begin
  with per as (
    select section_id, max(section_title) as title, count(*) as runs
      from public.scripts_call_runs
     where (_from is null or started_at >= _from) and (_to is null or started_at < _to)
     group by section_id
  ),
  secs as (
    select s.id, s.title, coalesce(p.runs, 0) as runs, false as deleted, s.position as ord
      from public.scripts_sections s
      left join per p on p.section_id = s.id
     where s.kind = 'call'
    union all
    select p.section_id, coalesce(nullif(p.title, ''), 'Удалённый звонок'), p.runs, true, 2147483647
      from per p
     where not exists (select 1 from public.scripts_sections s where s.id = p.section_id and s.kind = 'call')
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'runs', runs, 'deleted', deleted)
                            order by ord, title), '[]'::jsonb)
    into _sections from secs;

  if jsonb_array_length(_sections) = 0 then
    return jsonb_build_object('sections', _sections, 'section_id', null);
  end if;

  select (e ->> 'id')::uuid into _chosen
    from jsonb_array_elements(_sections) e
   where _section is not null and (e ->> 'id')::uuid = _section;
  if _chosen is null then
    select (e ->> 'id')::uuid into _chosen
      from jsonb_array_elements(_sections) with ordinality as t(e, ord)
     order by (e ->> 'runs')::int desc, (e ->> 'deleted')::boolean, ord
     limit 1;
  end if;

  with in_section as (
    select * from public.scripts_call_runs
     where section_id = _chosen
       and (_from is null or started_at >= _from) and (_to is null or started_at < _to)
  ),
  runs as (
    select * from in_section where _user is null or user_id = _user
  ),
  done as (
    select * from runs
     where jsonb_array_length(path) > 0
       and (ended_at is not null or updated_at < now() - interval '30 minutes')
  ),
  steps as (
    select r.id as run_id, r.started_at, t.ord, t.e ->> 'id' as node_id,
           coalesce(t.e ->> 'title', '') as title, coalesce(t.e ->> 'group', 'main') as grp
      from runs r, jsonb_array_elements(r.path) with ordinality as t(e, ord)
  ),
  first_seen as (
    select distinct on (node_id) node_id, title, grp, started_at, ord
      from steps
     order by node_id, started_at, ord
  )
  select jsonb_build_object(
    'sections', _sections,
    'section_id', _chosen,
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'runs', runs) order by runs desc, name)
        from (select user_id, max(user_name) as name, count(*) as runs from in_section group by user_id) u
    ), '[]'::jsonb),
    'runs', (select count(*) from done),
    'avg_steps', (select round(avg(jsonb_array_length(path)), 2) from done),
    'reached', coalesce((
      select jsonb_object_agg(node_id, n)
        from (select s.node_id, count(distinct s.run_id) as n
                from steps s join done d on d.id = s.run_id group by s.node_id) x
    ), '{}'::jsonb),
    'ended', coalesce((
      select jsonb_agg(jsonb_build_object('node_id', node_id, 'title', title, 'group', grp, 'count', n)
                       order by n desc, title)
        from (select path -> -1 ->> 'id' as node_id,
                     coalesce(max(path -> -1 ->> 'title'), '') as title,
                     coalesce(max(path -> -1 ->> 'group'), 'main') as grp,
                     count(*) as n
                from done group by 1) x
    ), '[]'::jsonb),
    'seen', coalesce((
      select jsonb_agg(jsonb_build_object('id', node_id, 'title', title, 'group', grp) order by started_at, ord)
        from first_seen
    ), '[]'::jsonb)
  ) into _out;
  return _out;
end;
$$;

-- Сотрудники с разделом «Скрипты LS» — для имён {админ} в настройках.
-- Профили других сотрудников RLS не отдаёт, поэтому через definer.
create or replace function public.scripts_staff()
returns table (user_id uuid, full_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, coalesce(p.full_name, ''), coalesce(p.email, '')
    from public.profiles p
   where public.scripts_can_read(auth.uid())
     and exists (select 1 from public.user_roles r
                  where r.user_id = p.id and r.role in ('owner', 'admin', 'trainer'))
     and public.scripts_can_read(p.id)
   order by p.full_name nulls last, p.email
$$;

-- Загрузка набора скриптов целиком (стартовый набор, импорт из
-- «Аудиоаналитики»): все разделы и скрипты заменяются. Формат — экспорт
-- «Аудиоаналитики»: {sections: [{title, icon, kind, items, flow, …}]}.
-- Подписи и даты правок переносятся как были; хронология не пишется.
create or replace function public.scripts_load(_data jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _s jsonb;
  _s_ord bigint;
  _i jsonb;
  _i_ord bigint;
  _section_id uuid;
  _kind text;
  _icon text;
  _count integer := 0;
begin
  if jsonb_typeof(_data -> 'sections') <> 'array' or jsonb_array_length(_data -> 'sections') = 0 then
    raise exception 'В файле нет разделов скриптов';
  end if;
  perform set_config('scripts.skip_journal', 'on', true);
  delete from public.scripts_items where true;
  delete from public.scripts_sections where true;

  for _s, _s_ord in select e, ord from jsonb_array_elements(_data -> 'sections') with ordinality as t(e, ord) loop
    _kind := case when _s ->> 'kind' = 'call' or jsonb_typeof(_s -> 'flow') = 'object' then 'call' else 'text' end;
    _icon := coalesce(_s ->> 'icon', '');
    if _icon !~ '^[a-z0-9-]{0,40}$' then
      _icon := '';
    end if;
    insert into public.scripts_sections (
      title, icon, position, kind, flow, flow_updated_at, flow_updated_by, flow_change_note
    ) values (
      left(coalesce(nullif(btrim(_s ->> 'title'), ''), 'Без названия'), 255), _icon, _s_ord - 1, _kind,
      case when _kind = 'call' then _s -> 'flow' end,
      case when _kind = 'call' then coalesce((_s ->> 'flow_updated_at')::timestamptz, now()) end,
      case when _kind = 'call' then coalesce(_s ->> 'flow_updated_by', '') else '' end,
      case when _kind = 'call' then coalesce(_s ->> 'flow_change_note', '') else '' end
    ) returning id into _section_id;

    if _kind = 'text' and jsonb_typeof(_s -> 'items') = 'array' then
      for _i, _i_ord in select e, ord from jsonb_array_elements(_s -> 'items') with ordinality as t(e, ord) loop
        insert into public.scripts_items (
          section_id, title, kind, keywords, note, follow_up, variants, position,
          updated_at, updated_by, change_note
        ) values (
          _section_id,
          left(coalesce(nullif(btrim(_i ->> 'title'), ''), 'Без названия'), 255),
          case when _i ->> 'kind' in ('chat', 'call', 'task', 'info') then _i ->> 'kind' else 'chat' end,
          coalesce(_i ->> 'keywords', ''),
          coalesce(_i ->> 'note', ''),
          coalesce(_i ->> 'follow_up', ''),
          case when jsonb_typeof(_i -> 'variants') = 'array' then _i -> 'variants' else '[]'::jsonb end,
          _i_ord - 1,
          coalesce((_i ->> 'updated_at')::timestamptz, now()),
          coalesce(_i ->> 'updated_by', ''),
          coalesce(_i ->> 'change_note', '')
        );
        _count := _count + 1;
      end loop;
    end if;
  end loop;

  perform set_config('scripts.skip_journal', 'off', true);
  return _count;
end;
$$;

revoke all on function public.scripts_load(jsonb) from public, anon, authenticated;

-- Импорт из «Аудиоаналитики» («Настройки скриптов» → «Импорт»): скрипты
-- заменяются целиком; из настроек — названия студий и свои переменные
-- (имена администраторов там — другие учётные записи, их не переносим).
create or replace function public.scripts_import(_data jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _count integer;
  _settings jsonb := _data -> 'settings';
  _patch jsonb := '{}'::jsonb;
begin
  if not public.scripts_can_edit(auth.uid()) then
    raise exception 'Нет права правки скриптов';
  end if;
  _count := public.scripts_load(_data);

  if jsonb_typeof(_settings -> 'variables') = 'array' then
    _patch := _patch || jsonb_build_object('variables', _settings -> 'variables');
  end if;
  if jsonb_typeof(_settings -> 'studios') = 'array' then
    _patch := _patch || jsonb_build_object('studios', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', coalesce(nullif(e ->> 'name', ''), e ->> 'location_name', e ->> 'ru', ''),
        'ru', coalesce(e ->> 'ru', ''), 'en', coalesce(e ->> 'en', ''), 'ka', coalesce(e ->> 'ka', '')))
        from jsonb_array_elements(_settings -> 'studios') e
       where coalesce((e ->> 'active')::boolean, true)
    ), '[]'::jsonb));
  end if;
  insert into public.scripts_settings (id, data) values (true, _patch)
  on conflict (id) do update set data = public.scripts_settings.data || excluded.data;

  -- Импорт — одной записью в хронологии: что было до него, видно по старым.
  insert into public.scripts_changes (item_id, item_title, action, before, after, change_note, author)
  values (null, 'Импорт из «Аудиоаналитики»', 'updated', null, null,
          format('Скрипты заменены: %s шт.', _count), public.scripts_author_name());
  return _count;
end;
$$;

revoke all on function public.scripts_reorder(uuid, uuid[]) from public, anon;
revoke all on function public.scripts_save_call_run(uuid, uuid, jsonb, boolean, text, text) from public, anon;
revoke all on function public.scripts_copy_stats(timestamptz, timestamptz, uuid, text) from public, anon;
revoke all on function public.scripts_call_stats(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.scripts_staff() from public, anon;
revoke all on function public.scripts_import(jsonb) from public, anon;
grant execute on function public.scripts_reorder(uuid, uuid[]) to authenticated;
grant execute on function public.scripts_save_call_run(uuid, uuid, jsonb, boolean, text, text) to authenticated;
grant execute on function public.scripts_copy_stats(timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.scripts_call_stats(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.scripts_staff() to authenticated;
grant execute on function public.scripts_import(jsonb) to authenticated;

-- 6) Настройки по умолчанию -----------------------------------------------------------
-- Стартовых скриптов в этой копии нет: разделы и скрипты заводят в портале
-- (или импортом в «Настройках скриптов»).
insert into public.scripts_settings (id, data)
values (true, '{"studios": [], "admins": {}, "variables": []}'::jsonb)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
