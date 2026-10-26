-- ============================================================================
-- База знаний (решение владельца 2026-10-24; план — KNOWLEDGE_BASE.md).
--
-- Несколько баз знаний (kb_bases), в каждой — дерево папок и статей
-- (kb_nodes). Раздел общий для сети — без studio_id, как «Скрипты LS».
--
-- Доступ (пока — в текущей модели «Доступов», решение владельца):
--   * владелец (owner хоть в одной студии) — видит и правит всё, создаёт базы
--     и раздаёт доступы (kb_is_admin);
--   * остальные сотрудники — только базы, выданные в «Доступах»
--     (kb_grants: сотрудник → база → «просмотр» / «редактирование»);
--     по умолчанию не видно ничего. Доступ к базе действует на всё её
--     дерево. Колонки node_id и subject_type — задел под доступ к ветке и по
--     ролям/должностям сети, пока не используются (политики их не читают).
--   * читатель видит только опубликованное, у которого опубликованы и все
--     папки выше (kb_nodes.reader_visible, ставят триггеры); редактор — всё.
--
-- Текст статьи — документ редактора BlockNote (jsonb). Опубликованный текст
-- — kb_nodes.content; правки копятся в kb_drafts (автосохранение,
-- RPC kb_save_draft) и видны только редакторам, читатель видит прежний текст
-- до kb_publish. Каждая публикация — снимок в kb_revisions.
-- Поиск — kb_search (русская морфология + начало слова), чтение —
-- kb_mark_read, отчёт — kb_report / kb_article_readers.
-- Файлы — закрытый бакет kb-media, путь {base_id}/{node_id}/{файл}, лимит
-- 50 МБ на файл (решение владельца: маленький лимит на видео).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Таблицы ---------------------------------------------------------------------
create table if not exists public.kb_bases (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  -- Подпись в рейке: в строку помещается ~7 букв, длинное — на две строки.
  rail_title text not null check (char_length(btrim(rail_title)) between 1 and 16),
  icon text not null default 'notebook',
  description text not null default '' check (char_length(description) <= 500),
  sort_order integer not null default 0,
  show_in_rail boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kb_nodes (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  -- no action, не cascade: папку с содержимым не удалить одной строкой (при
  -- удалении базы всё дерево уходит одной командой — проверка в её конце).
  parent_id uuid references public.kb_nodes(id),
  kind text not null check (kind in ('folder', 'article')),
  title text not null default '' check (char_length(title) <= 200),
  -- Вступление папки (над списком вложенного).
  description text not null default '' check (char_length(description) <= 1000),
  sort_order integer,
  -- Цепочка папок выше (от верхней); ставит триггер.
  path uuid[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- Опубликован сам и все папки выше; ставит триггер.
  reader_visible boolean not null default false,
  content jsonb,
  content_text text not null default '',
  search tsvector generated always as (
    setweight(to_tsvector('russian'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('russian'::regconfig, coalesce(content_text, '')), 'B')
  ) stored,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- Последняя публикация текста — «Обновлено» в шапке статьи.
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz
);
create index if not exists kb_nodes_tree_idx on public.kb_nodes (base_id, parent_id, sort_order);
create index if not exists kb_nodes_parent_idx on public.kb_nodes (parent_id);
create index if not exists kb_nodes_path_idx on public.kb_nodes using gin (path);
create index if not exists kb_nodes_search_idx on public.kb_nodes using gin (search);

create table if not exists public.kb_drafts (
  node_id uuid primary key references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  content jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists kb_drafts_base_idx on public.kb_drafts (base_id);

create table if not exists public.kb_revisions (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  title text not null,
  content jsonb,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now()
);
create index if not exists kb_revisions_node_idx on public.kb_revisions (node_id, published_at desc);
create index if not exists kb_revisions_base_idx on public.kb_revisions (base_id);

create table if not exists public.kb_grants (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  node_id uuid references public.kb_nodes(id) on delete cascade,
  subject_type text not null default 'user' check (subject_type in ('user')),
  subject_id uuid not null,
  level text not null check (level in ('view', 'edit')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists kb_grants_base_subject_uidx
  on public.kb_grants (base_id, subject_type, subject_id) where node_id is null;
create unique index if not exists kb_grants_node_subject_uidx
  on public.kb_grants (node_id, subject_type, subject_id) where node_id is not null;
create index if not exists kb_grants_subject_idx on public.kb_grants (subject_type, subject_id);

create table if not exists public.kb_reads (
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  first_read_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  read_count integer not null default 1,
  primary key (node_id, user_id)
);
create index if not exists kb_reads_base_idx on public.kb_reads (base_id);

-- 2) Права -----------------------------------------------------------------------
create or replace function public.kb_is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = 'owner')
$$;

-- 'manage' (владелец) / 'edit' / 'view' / null — нет доступа.
create or replace function public.kb_base_level(_user_id uuid, _base_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(_user_id) then 'manage'
    when not public.is_staff(_user_id) then null
    else (
      select case when bool_or(level = 'edit') then 'edit' when count(*) > 0 then 'view' end
        from public.kb_grants
       where base_id = _base_id and node_id is null
         and subject_type = 'user' and subject_id = _user_id
    )
  end
$$;

-- Базы вызывающего — массивом, один вызов на запрос в политиках:
-- base_id = any ((select public.auth_kb_view_base_ids())::uuid[]).
create or replace function public.auth_kb_view_base_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(auth.uid()) then coalesce((select array_agg(id) from public.kb_bases), '{}')
    when not public.is_staff(auth.uid()) then '{}'::uuid[]
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
    when not public.is_staff(auth.uid()) then '{}'::uuid[]
    else coalesce((
      select array_agg(distinct base_id) from public.kb_grants
       where node_id is null and subject_type = 'user' and subject_id = auth.uid()
         and level = 'edit'
    ), '{}')
  end
$$;

revoke all on function public.kb_is_admin(uuid), public.kb_base_level(uuid, uuid),
  public.auth_kb_view_base_ids(), public.auth_kb_edit_base_ids() from public, anon;
grant execute on function public.kb_is_admin(uuid), public.kb_base_level(uuid, uuid),
  public.auth_kb_view_base_ids(), public.auth_kb_edit_base_ids() to authenticated, service_role;

-- 3) Триггеры ------------------------------------------------------------------
-- Плоский текст документа BlockNote для поиска: все строки "text" на любой
-- глубине (абзацы, списки, ссылки, ячейки таблиц) и подписи файлов.
create or replace function public.kb_document_text(_doc jsonb)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(v #>> '{}', ' '), '')
    from (
      select jsonb_path_query(_doc, 'strict $.**.text ? (@.type() == "string")') v
      union all
      select jsonb_path_query(_doc, 'strict $.**.props.caption ? (@.type() == "string")')
      union all
      select jsonb_path_query(_doc, 'strict $.**.props.name ? (@.type() == "string")')
    ) t
   where _doc is not null
$$;

create or replace function public.kb_nodes_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.kb_nodes;
begin
  if tg_op = 'UPDATE' and new.base_id <> old.base_id then
    raise exception 'kb_base_immutable';
  end if;
  if tg_op = 'UPDATE' and new.kind <> old.kind then
    raise exception 'kb_kind_immutable';
  end if;

  if new.parent_id is null then
    new.path := '{}';
    new.reader_visible := new.status = 'published';
  else
    select * into p from public.kb_nodes where id = new.parent_id;
    if not found or p.base_id <> new.base_id then
      raise exception 'kb_bad_parent';
    end if;
    if p.kind <> 'folder' then
      raise exception 'kb_parent_not_folder';
    end if;
    if p.id = new.id or new.id = any(p.path) then
      raise exception 'kb_move_into_self';
    end if;
    new.path := p.path || p.id;
    new.reader_visible := new.status = 'published' and p.reader_visible;
  end if;

  if new.kind = 'folder' then
    new.content := null;
  end if;
  if tg_op = 'INSERT' or new.content is distinct from old.content then
    new.content_text := public.kb_document_text(new.content);
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.updated_by := new.created_by;
    new.updated_at := now();
    if new.sort_order is null then
      select coalesce(max(sort_order), 0) + 1 into new.sort_order
        from public.kb_nodes
       where base_id = new.base_id and parent_id is not distinct from new.parent_id;
    end if;
  elsif new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.status is distinct from old.status
     or new.content is distinct from old.content then
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists kb_nodes_biu on public.kb_nodes;
create trigger kb_nodes_biu
  before insert or update on public.kb_nodes
  for each row execute function public.kb_nodes_biu();

-- Сменились путь или видимость — пересчитать детей (их BEFORE-триггер берёт
-- новые значения у этой строки, их AFTER-триггер идёт дальше вниз).
create or replace function public.kb_nodes_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.path is distinct from old.path or new.reader_visible is distinct from old.reader_visible then
    update public.kb_nodes set path = path where parent_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists kb_nodes_au on public.kb_nodes;
create trigger kb_nodes_au
  after update on public.kb_nodes
  for each row execute function public.kb_nodes_au();

create or replace function public.kb_drafts_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
begin
  select * into n from public.kb_nodes where id = new.node_id;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if n.kind <> 'article' then
    raise exception 'kb_not_article';
  end if;
  new.base_id := n.base_id;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  -- До миллисекунд: метка возвращается редактору и сравнивается при следующем
  -- сохранении, а в браузере (Date) микросекунды теряются.
  new.updated_at := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$$;

drop trigger if exists kb_drafts_biu on public.kb_drafts;
create trigger kb_drafts_biu
  before insert or update on public.kb_drafts
  for each row execute function public.kb_drafts_biu();

create or replace function public.kb_bases_bu()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kb_bases_bu on public.kb_bases;
create trigger kb_bases_bu
  before update on public.kb_bases
  for each row execute function public.kb_bases_bu();

create or replace function public.kb_bases_bi()
returns trigger
language plpgsql
as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  if new.sort_order = 0 then
    select coalesce(max(sort_order), 0) + 1 into new.sort_order from public.kb_bases;
  end if;
  return new;
end;
$$;

drop trigger if exists kb_bases_bi on public.kb_bases;
create trigger kb_bases_bi
  before insert on public.kb_bases
  for each row execute function public.kb_bases_bi();

-- 4) RLS -------------------------------------------------------------------------
revoke all on public.kb_bases, public.kb_nodes, public.kb_drafts, public.kb_revisions,
  public.kb_grants, public.kb_reads from anon, authenticated;
grant select, insert, update, delete on public.kb_bases, public.kb_nodes, public.kb_drafts,
  public.kb_grants to authenticated;
grant select on public.kb_revisions, public.kb_reads to authenticated;
grant all on public.kb_bases, public.kb_nodes, public.kb_drafts, public.kb_revisions,
  public.kb_grants, public.kb_reads to service_role;

alter table public.kb_bases enable row level security;
alter table public.kb_nodes enable row level security;
alter table public.kb_drafts enable row level security;
alter table public.kb_revisions enable row level security;
alter table public.kb_grants enable row level security;
alter table public.kb_reads enable row level security;

drop policy if exists "kb_bases read" on public.kb_bases;
create policy "kb_bases read" on public.kb_bases
  for select to authenticated
  using (id = any ((select public.auth_kb_view_base_ids())::uuid[]));

drop policy if exists "kb_bases admin write" on public.kb_bases;
create policy "kb_bases admin write" on public.kb_bases
  for all to authenticated
  using ((select public.kb_is_admin(auth.uid())))
  with check ((select public.kb_is_admin(auth.uid())));

drop policy if exists "kb_nodes read" on public.kb_nodes;
create policy "kb_nodes read" on public.kb_nodes
  for select to authenticated
  using (
    base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
    or (reader_visible and base_id = any ((select public.auth_kb_view_base_ids())::uuid[]))
  );

drop policy if exists "kb_nodes editor write" on public.kb_nodes;
create policy "kb_nodes editor write" on public.kb_nodes
  for all to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]))
  with check (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

drop policy if exists "kb_drafts editor" on public.kb_drafts;
create policy "kb_drafts editor" on public.kb_drafts
  for all to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]))
  with check (
    exists (
      select 1 from public.kb_nodes n
       where n.id = node_id
         and n.base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
    )
  );

drop policy if exists "kb_revisions editor read" on public.kb_revisions;
create policy "kb_revisions editor read" on public.kb_revisions
  for select to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

-- Свои доступы — чтобы показать рейку; все — владельцу. Пишет сервер
-- «Доступов» сервис-ключом и владелец.
drop policy if exists "kb_grants read" on public.kb_grants;
create policy "kb_grants read" on public.kb_grants
  for select to authenticated
  using (
    (subject_type = 'user' and subject_id = (select auth.uid()))
    or (select public.kb_is_admin(auth.uid()))
  );

drop policy if exists "kb_grants admin write" on public.kb_grants;
create policy "kb_grants admin write" on public.kb_grants
  for all to authenticated
  using ((select public.kb_is_admin(auth.uid())))
  with check ((select public.kb_is_admin(auth.uid())));

drop policy if exists "kb_reads read" on public.kb_reads;
create policy "kb_reads read" on public.kb_reads
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
  );

-- 5) RPC -------------------------------------------------------------------------
-- Автосохранение черновика. p_expected — updated_at черновика, с которым
-- работает редактор (null — черновика не было); не совпал — кто-то сохранил
-- (или опубликовал) раньше: kb_draft_conflict, затирать нельзя.
create or replace function public.kb_save_draft(p_node uuid, p_content jsonb, p_expected timestamptz)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  cur timestamptz;
  res timestamptz;
begin
  -- Блокировка статьи: два первых сохранения подряд не создадут черновик дважды.
  perform 1 from public.kb_nodes
   where id = p_node and base_id = any (public.auth_kb_edit_base_ids())
   for update;
  if not found then
    raise exception 'kb_forbidden';
  end if;
  select updated_at into cur from public.kb_drafts where node_id = p_node;
  if cur is distinct from p_expected then
    raise exception 'kb_draft_conflict';
  end if;
  insert into public.kb_drafts (node_id, base_id, content)
  values (p_node, (select base_id from public.kb_nodes where id = p_node), p_content)
  on conflict (node_id) do update set content = excluded.content
  returning updated_at into res;
  return res;
end;
$$;

-- Публикация: черновик → опубликованный текст, снимок в историю (историю
-- напрямую не пишет никто — поэтому definer; право редактора проверено ниже).
create or replace function public.kb_publish(p_node uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  d public.kb_drafts;
begin
  select * into n from public.kb_nodes
   where id = p_node and base_id = any (public.auth_kb_edit_base_ids())
   for update;
  if not found then
    raise exception 'kb_forbidden';
  end if;
  if n.kind <> 'article' then
    raise exception 'kb_not_article';
  end if;
  select * into d from public.kb_drafts where node_id = p_node;
  update public.kb_nodes
     set content = case when d.node_id is null then content else d.content end,
         status = 'published',
         published_by = auth.uid(),
         published_at = now()
   where id = p_node
  returning * into n;
  insert into public.kb_revisions (node_id, base_id, title, content, published_by, published_at)
  values (n.id, n.base_id, n.title, n.content, auth.uid(), n.published_at);
  delete from public.kb_drafts where node_id = p_node;
  return n.published_at;
end;
$$;

-- Перенос и порядок: узел встаёт в папку p_parent (null — верхний уровень)
-- на место p_index (с 0) среди её содержимого.
create or replace function public.kb_move_node(p_node uuid, p_parent uuid, p_index integer)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  n public.kb_nodes;
  ids uuid[];
  i integer := greatest(coalesce(p_index, 0), 0);
begin
  select * into n from public.kb_nodes
   where id = p_node and base_id = any (public.auth_kb_edit_base_ids());
  if not found then
    raise exception 'kb_forbidden';
  end if;
  select coalesce(array_agg(id order by sort_order, created_at), '{}') into ids
    from public.kb_nodes
   where base_id = n.base_id and parent_id is not distinct from p_parent and id <> p_node;
  ids := ids[1:i] || p_node || ids[i + 1:];
  update public.kb_nodes k
     set parent_id = p_parent, sort_order = x.ord
    from unnest(ids) with ordinality as x(id, ord)
   where k.id = x.id
     and (k.sort_order is distinct from x.ord::integer or k.parent_id is distinct from p_parent);
end;
$$;

-- Порядок баз в рейке и списке — одной командой (владелец; RLS).
create or replace function public.kb_reorder_bases(p_ids uuid[])
returns void
language sql
security invoker
set search_path = public
as $$
  update public.kb_bases b set sort_order = x.ord
    from unnest(p_ids) with ordinality as x(id, ord)
   where b.id = x.id and b.sort_order is distinct from x.ord::integer
$$;

-- Копия статьи — черновиком сразу под ней (текст — черновик правок или
-- опубликованный). Файлы остаются по прежним путям.
create or replace function public.kb_copy_node(p_node uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  n public.kb_nodes;
  doc jsonb;
  new_id uuid;
begin
  select * into n from public.kb_nodes
   where id = p_node and base_id = any (public.auth_kb_edit_base_ids());
  if not found then
    raise exception 'kb_forbidden';
  end if;
  if n.kind <> 'article' then
    raise exception 'kb_not_article';
  end if;
  select coalesce((select content from public.kb_drafts where node_id = p_node), n.content) into doc;
  update public.kb_nodes set sort_order = sort_order + 1
   where base_id = n.base_id and parent_id is not distinct from n.parent_id
     and sort_order > n.sort_order;
  insert into public.kb_nodes (base_id, parent_id, kind, title, sort_order, status)
  values (n.base_id, n.parent_id, 'article', left(n.title || ' (копия)', 200), n.sort_order + 1, 'draft')
  returning id into new_id;
  if doc is not null then
    insert into public.kb_drafts (node_id, base_id, content) values (new_id, n.base_id, doc);
  end if;
  return new_id;
end;
$$;

-- Отметка «открыл статью»: повторное открытие считается не чаще раза в 30 минут.
create or replace function public.kb_mark_read(p_node uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  lvl text;
begin
  if auth.uid() is null then
    return;
  end if;
  select * into n from public.kb_nodes where id = p_node;
  if not found or n.kind <> 'article' then
    return;
  end if;
  lvl := public.kb_base_level(auth.uid(), n.base_id);
  if lvl is null or (lvl = 'view' and not n.reader_visible) then
    return;
  end if;
  insert into public.kb_reads as r (node_id, user_id, base_id)
  values (p_node, auth.uid(), n.base_id)
  on conflict (node_id, user_id) do update
     set read_count = r.read_count + case when r.last_read_at < now() - interval '30 minutes' then 1 else 0 end,
         last_read_at = now();
end;
$$;

-- Поиск начала слов с русской морфологией: «админ» найдёт «администратор»,
-- «администраторы» — «администратора». В запрос идут только буквы и цифры.
create or replace function public.kb_prefix_tsquery(p_query text)
returns tsquery
language sql
immutable
as $$
  select case when count(*) = 0 then null
    else to_tsquery('russian'::regconfig, string_agg(w || ':*', ' & ')) end
    from regexp_split_to_table(lower(coalesce(p_query, '')), '[^0-9a-zа-яё]+') w
   where w <> ''
$$;

-- Поиск по базе (или внутри папки): RLS отдаёт только доступное. Фрагмент —
-- с найденным между ⟦ и ⟧.
create or replace function public.kb_search(
  p_query text,
  p_base uuid,
  p_folder uuid default null,
  p_limit integer default 30
)
returns table (
  id uuid,
  parent_id uuid,
  kind text,
  title text,
  status text,
  snippet text,
  rank real
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (
    select public.kb_prefix_tsquery(p_query) as tsq,
           '%' || replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  hits as (
    select n.id, n.parent_id, n.kind, n.title, n.status, n.content_text,
           (case when q.tsq is null then 0 else ts_rank(n.search, q.tsq) end
             + case when n.title ilike q.pat then 1 else 0 end)::real as rank
      from public.kb_nodes n, q
     where n.base_id = p_base
       and (p_folder is null or n.path @> array[p_folder])
       and btrim(coalesce(p_query, '')) <> ''
       and ((q.tsq is not null and n.search @@ q.tsq) or n.title ilike q.pat)
     order by rank desc, n.title
     limit least(greatest(coalesce(p_limit, 30), 1), 100)
  )
  select h.id, h.parent_id, h.kind, h.title, h.status,
         case when q.tsq is null or h.content_text = '' then ''
           else ts_headline('russian'::regconfig, h.content_text, q.tsq,
             'StartSel=⟦, StopSel=⟧, MaxWords=24, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "')
         end as snippet,
         h.rank
    from hits h, q
   order by h.rank desc, h.title
$$;

-- Имена авторов и редакторов статей базы — для «Обновлено · Имя» и
-- «Правит …»: профили сотрудников других клубов RLS не отдаёт.
create or replace function public.kb_authors(p_base uuid)
returns table (user_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.kb_base_level(auth.uid(), p_base) is null then
    raise exception 'kb_forbidden';
  end if;
  return query
  select p.id, p.full_name
    from public.profiles p
   where p.id in (
     select unnest(array[n.created_by, n.updated_by, n.published_by])
       from public.kb_nodes n where n.base_id = p_base
     union
     select d.updated_by from public.kb_drafts d where d.base_id = p_base
   );
end;
$$;

-- Кто «имеет доступ» к базе: владельцы и сотрудники с доступом из «Доступов».
create or replace function public.kb_base_audience(p_base uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct user_id from public.user_roles where role = 'owner'
  union
  select g.subject_id from public.kb_grants g
   where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
     and public.is_staff(g.subject_id)
$$;
revoke all on function public.kb_base_audience(uuid) from public, anon, authenticated;

-- Отчёт по базе (редактору и владельцу): статьи без папок.
create or replace function public.kb_report(p_base uuid)
returns table (
  id uuid,
  parent_id uuid,
  title text,
  status text,
  created_at timestamptz,
  created_by_name text,
  updated_at timestamptz,
  updated_by_name text,
  published_at timestamptz,
  published_by_name text,
  has_draft boolean,
  access_count integer,
  readers_count integer,
  last_read_at timestamptz
)
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
  with aud as (select a.user_id from public.kb_base_audience(p_base) a)
  select n.id, n.parent_id, n.title, n.status, n.created_at, pc.full_name,
         greatest(n.updated_at, d.updated_at),
         coalesce(case when d.updated_at > n.updated_at then pd.full_name end, pu.full_name),
         n.published_at, pp.full_name,
         d.node_id is not null,
         (select count(*) from aud)::integer,
         (select count(*) from public.kb_reads r where r.node_id = n.id and r.user_id in (select user_id from aud))::integer,
         (select max(r.last_read_at) from public.kb_reads r where r.node_id = n.id)
    from public.kb_nodes n
    left join public.kb_drafts d on d.node_id = n.id
    left join public.profiles pc on pc.id = n.created_by
    left join public.profiles pu on pu.id = n.updated_by
    left join public.profiles pd on pd.id = d.updated_by
    left join public.profiles pp on pp.id = n.published_by
   where n.base_id = p_base and n.kind = 'article';
end;
$$;

-- Кто из имеющих доступ открыл статью (и кто нет — read_count 0).
create or replace function public.kb_article_readers(p_node uuid)
returns table (
  user_id uuid,
  full_name text,
  avatar_url text,
  first_read_at timestamptz,
  last_read_at timestamptz,
  read_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b uuid;
begin
  select base_id into b from public.kb_nodes where id = p_node;
  if b is null or coalesce(public.kb_base_level(auth.uid(), b), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  return query
  select a.user_id, p.full_name, p.avatar_url, r.first_read_at, r.last_read_at,
         coalesce(r.read_count, 0)
    from public.kb_base_audience(b) a
    left join public.profiles p on p.id = a.user_id
    left join public.kb_reads r on r.node_id = p_node and r.user_id = a.user_id
   order by r.last_read_at desc nulls last, p.full_name;
end;
$$;

revoke all on function public.kb_save_draft(uuid, jsonb, timestamptz), public.kb_publish(uuid),
  public.kb_authors(uuid),
  public.kb_move_node(uuid, uuid, integer), public.kb_reorder_bases(uuid[]), public.kb_copy_node(uuid), public.kb_mark_read(uuid),
  public.kb_search(text, uuid, uuid, integer), public.kb_report(uuid),
  public.kb_article_readers(uuid) from public, anon;
grant execute on function public.kb_save_draft(uuid, jsonb, timestamptz), public.kb_publish(uuid),
  public.kb_authors(uuid),
  public.kb_move_node(uuid, uuid, integer), public.kb_reorder_bases(uuid[]), public.kb_copy_node(uuid), public.kb_mark_read(uuid),
  public.kb_search(text, uuid, uuid, integer), public.kb_report(uuid),
  public.kb_article_readers(uuid) to authenticated, service_role;

-- 6) Файлы -----------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('kb-media', 'kb-media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "kb-media read" on storage.objects;
create policy "kb-media read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = any ((select public.auth_kb_view_base_ids())::text[])
  );

drop policy if exists "kb-media editor insert" on storage.objects;
create policy "kb-media editor insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = any ((select public.auth_kb_edit_base_ids())::text[])
  );

drop policy if exists "kb-media editor update" on storage.objects;
create policy "kb-media editor update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = any ((select public.auth_kb_edit_base_ids())::text[])
  )
  with check (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = any ((select public.auth_kb_edit_base_ids())::text[])
  );

drop policy if exists "kb-media editor delete" on storage.objects;
create policy "kb-media editor delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = any ((select public.auth_kb_edit_base_ids())::text[])
  );

notify pgrst, 'reload schema';
