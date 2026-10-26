-- База знаний, блок 2 «Удобство редакторов», защита содержимого и
-- упоминания (решение владельца 2026-10-25; план — KNOWLEDGE_BASE.md).
--
-- 1) Избранное (kb_favorites) и личные отметки чек-листов (kb_checks) —
--    свои строки читателя; поставить можно только на видимую ему статью.
-- 2) Шаблоны статей базы (kb_templates) — редакторам базы.
-- 3) Корзина (kb_trash): удалённая папка или статья со всем вложенным —
--    снимком (строки дерева, черновики, версии, чтение, избранное,
--    отметки); 30 дней можно вернуть с прежними id и авторством, потом —
--    удаление навсегда. Файлы бакета kb-media стираются только тогда:
--    очередь kb_file_purge разбирает сервер админки сервис-ключом (Storage
--    удаляет файлы только своим API). Туда же — файлы удалённой базы.
-- 4) Защита содержимого: kb_bases.protect_content (по умолчанию для статей
--    базы) и kb_nodes.protect у статьи (inherit / on / off): запрет
--    копирования и печати, водяной знак с почтой читателя и датой — в
--    интерфейсе (браузер — не защита от снимка экрана).
-- 5) Упоминания @сотрудника: кого можно упомянуть — kb_mention_candidates.
-- 6) kb_authors — и авторы версий (окно «Версии»).

-- 1) Избранное и отметки ------------------------------------------------------------
create table if not exists public.kb_favorites (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, node_id)
);
create index if not exists kb_favorites_base_idx on public.kb_favorites (user_id, base_id);

create table if not exists public.kb_checks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  -- id блока «Пункт списка задач» в документе статьи.
  block_id text not null check (char_length(block_id) between 1 and 64),
  checked_at timestamptz not null default now(),
  primary key (user_id, node_id, block_id)
);

-- 2) Шаблоны ---------------------------------------------------------------------
create table if not exists public.kb_templates (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 300),
  content jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists kb_templates_base_idx on public.kb_templates (base_id);

create or replace function public.kb_templates_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  elsif new.base_id <> old.base_id then
    raise exception 'kb_base_immutable';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists kb_templates_biu on public.kb_templates;
create trigger kb_templates_biu
  before insert or update on public.kb_templates
  for each row execute function public.kb_templates_biu();

-- 4) Защита содержимого (колонки — до корзины: её снимок берёт строки целиком)
alter table public.kb_bases add column if not exists protect_content boolean not null default false;
alter table public.kb_nodes add column if not exists protect text not null default 'inherit';
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'kb_nodes_protect_check' and conrelid = 'public.kb_nodes'::regclass
  ) then
    alter table public.kb_nodes
      add constraint kb_nodes_protect_check check (protect in ('inherit', 'on', 'off'));
  end if;
end;
$$;

-- 3) Корзина -----------------------------------------------------------------------
create table if not exists public.kb_trash (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  -- Удалённый узел (верх поддерева) — его id вернётся при восстановлении.
  root_id uuid not null,
  parent_id uuid,
  kind text not null,
  title text not null,
  -- Статей в удалённом (с вложенными).
  articles_count integer not null default 0,
  payload jsonb not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default now() + interval '30 days'
);
create index if not exists kb_trash_base_idx on public.kb_trash (base_id, deleted_at desc);
create index if not exists kb_trash_purge_idx on public.kb_trash (purge_after);

-- Что стереть в бакете: папка статьи {база}/{узел}/ или вся база (node_id null).
create table if not exists public.kb_file_purge (
  id bigserial primary key,
  base_id uuid not null,
  node_id uuid,
  queued_at timestamptz not null default now()
);

-- Пользователь ещё есть — иначе null (снимок мог пережить учётную запись).
create or replace function public.kb_existing_user(_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from auth.users where id = _id
$$;
revoke all on function public.kb_existing_user(uuid) from public, anon, authenticated;

-- Триггер дерева (из 2026-10-24_knowledge_base.sql) + восстановление из
-- корзины: при kb.restoring = '1' авторство и даты — из снимка.
create or replace function public.kb_nodes_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.kb_nodes;
  restoring boolean := coalesce(current_setting('kb.restoring', true), '') = '1';
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
    if restoring then
      new.created_at := coalesce(new.created_at, now());
      new.updated_at := coalesce(new.updated_at, now());
    else
      new.created_by := coalesce(auth.uid(), new.created_by);
      new.created_at := now();
      new.updated_by := new.created_by;
      new.updated_at := now();
    end if;
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

-- В корзину: узел со всем вложенным. Возвращает id строки корзины.
create or replace function public.kb_trash_node(p_node uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  ids uuid[];
  t_id uuid;
begin
  select * into n from public.kb_nodes where id = p_node;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), n.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  select array_agg(id) into ids
    from public.kb_nodes where id = p_node or p_node = any(path);

  insert into public.kb_trash (base_id, root_id, parent_id, kind, title, articles_count, payload, deleted_by)
  values (
    n.base_id, n.id, n.parent_id, n.kind, n.title,
    (select count(*) from public.kb_nodes where id = any(ids) and kind = 'article'),
    jsonb_build_object(
      'nodes', (select jsonb_agg(to_jsonb(x) - 'search' - 'content_text' - 'path' order by cardinality(x.path))
                  from public.kb_nodes x where x.id = any(ids)),
      'drafts', coalesce((select jsonb_agg(to_jsonb(d)) from public.kb_drafts d where d.node_id = any(ids)), '[]'),
      'revisions', coalesce((select jsonb_agg(to_jsonb(r)) from public.kb_revisions r where r.node_id = any(ids)), '[]'),
      'reads', coalesce((select jsonb_agg(to_jsonb(r)) from public.kb_reads r where r.node_id = any(ids)), '[]'),
      'favorites', coalesce((select jsonb_agg(to_jsonb(f)) from public.kb_favorites f where f.node_id = any(ids)), '[]'),
      'checks', coalesce((select jsonb_agg(to_jsonb(c)) from public.kb_checks c where c.node_id = any(ids)), '[]')
    ),
    auth.uid()
  )
  returning id into t_id;

  -- Одной командой: ссылка на родителя (no action) проверяется в её конце.
  delete from public.kb_nodes where id = any(ids);
  return t_id;
end;
$$;

-- Вернуть из корзины. Папки выше уже нет — встаёт на верхний уровень.
create or replace function public.kb_trash_restore(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.kb_trash;
  r record;
  parent uuid;
begin
  select * into t from public.kb_trash where id = p_id;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), t.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  if exists (select 1 from public.kb_nodes where id = t.root_id) then
    raise exception 'kb_already_restored';
  end if;
  parent := (select id from public.kb_nodes where id = t.parent_id and kind = 'folder');

  perform set_config('kb.restoring', '1', true);
  -- По одной строке, сверху вниз: триггер берёт путь и видимость у родителя.
  for r in
    select x.*, ord
      from jsonb_array_elements(t.payload -> 'nodes') with ordinality as e(j, ord),
           jsonb_populate_record(null::public.kb_nodes, e.j) x
     order by ord
  loop
    insert into public.kb_nodes (
      id, base_id, parent_id, kind, title, description, icon, protect, sort_order, status,
      content, created_by, created_at, updated_by, updated_at, published_by, published_at
    ) values (
      r.id, r.base_id, case when r.id = t.root_id then parent else r.parent_id end,
      r.kind, r.title, r.description, r.icon, coalesce(r.protect, 'inherit'),
      case when r.id = t.root_id then null else r.sort_order end, r.status,
      r.content, public.kb_existing_user(r.created_by), r.created_at,
      public.kb_existing_user(r.updated_by), r.updated_at,
      public.kb_existing_user(r.published_by), r.published_at
    );
  end loop;

  insert into public.kb_drafts (node_id, base_id, content, updated_by, updated_at)
  select d.node_id, d.base_id, d.content, public.kb_existing_user(d.updated_by), d.updated_at
    from jsonb_populate_recordset(null::public.kb_drafts, t.payload -> 'drafts') d;
  insert into public.kb_revisions (id, node_id, base_id, title, content, published_by, published_at)
  select r2.id, r2.node_id, r2.base_id, r2.title, r2.content,
         public.kb_existing_user(r2.published_by), r2.published_at
    from jsonb_populate_recordset(null::public.kb_revisions, t.payload -> 'revisions') r2;
  insert into public.kb_reads (node_id, user_id, base_id, first_read_at, last_read_at, read_count)
  select x.node_id, x.user_id, x.base_id, x.first_read_at, x.last_read_at, x.read_count
    from jsonb_populate_recordset(null::public.kb_reads, t.payload -> 'reads') x
   where public.kb_existing_user(x.user_id) is not null;
  insert into public.kb_favorites (user_id, node_id, base_id, created_at)
  select x.user_id, x.node_id, x.base_id, x.created_at
    from jsonb_populate_recordset(null::public.kb_favorites, t.payload -> 'favorites') x
   where public.kb_existing_user(x.user_id) is not null;
  insert into public.kb_checks (user_id, node_id, base_id, block_id, checked_at)
  select x.user_id, x.node_id, x.base_id, x.block_id, x.checked_at
    from jsonb_populate_recordset(null::public.kb_checks, t.payload -> 'checks') x
   where public.kb_existing_user(x.user_id) is not null;

  delete from public.kb_trash where id = p_id;
  perform set_config('kb.restoring', '', true);
  return t.root_id;
end;
$$;

-- Удалить из корзины навсегда (редактор базы).
create or replace function public.kb_trash_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b uuid;
begin
  select base_id into b from public.kb_trash where id = p_id;
  if b is null then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), b), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  delete from public.kb_trash where id = p_id;
end;
$$;

-- Истёкшее — навсегда (сервер админки, сервис-ключ). Сколько удалено.
create or replace function public.kb_trash_purge_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.kb_trash where purge_after < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Удалено навсегда (не восстановлено) — файлы узлов в очередь на стирание.
create or replace function public.kb_trash_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('kb.restoring', true), '') = '1' then
    return old;
  end if;
  insert into public.kb_file_purge (base_id, node_id)
  select old.base_id, (e ->> 'id')::uuid
    from jsonb_array_elements(old.payload -> 'nodes') e
   where e ->> 'kind' = 'article';
  return old;
end;
$$;
drop trigger if exists kb_trash_ad on public.kb_trash;
create trigger kb_trash_ad
  after delete on public.kb_trash
  for each row execute function public.kb_trash_ad();

-- Удалённая база — вся её папка в бакете.
create or replace function public.kb_bases_bd()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kb_file_purge (base_id, node_id) values (old.id, null);
  return old;
end;
$$;
drop trigger if exists kb_bases_bd on public.kb_bases;
create trigger kb_bases_bd
  before delete on public.kb_bases
  for each row execute function public.kb_bases_bd();

-- 5) Упоминания: владельцы и сотрудники с доступом к базе («Доступы»).
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
     select ur.user_id from public.user_roles ur where ur.role = 'owner'
     union
     select g.subject_id from public.kb_grants g
      where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
        and public.is_staff(g.subject_id)
   )
   order by 2;
end;
$$;

-- 6) Имена авторов — и тех, кто публиковал версии.
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
     union
     select r.published_by from public.kb_revisions r where r.base_id = p_base
     union
     select unnest(array[t.created_by, t.updated_by])
       from public.kb_templates t where t.base_id = p_base
     union
     select t.deleted_by from public.kb_trash t where t.base_id = p_base
   );
end;
$$;

-- Права ------------------------------------------------------------------------------
revoke all on public.kb_favorites, public.kb_checks, public.kb_templates, public.kb_trash,
  public.kb_file_purge from anon, authenticated;
grant select, insert, delete on public.kb_favorites, public.kb_checks to authenticated;
grant select, insert, update, delete on public.kb_templates to authenticated;
grant select on public.kb_trash to authenticated;
grant all on public.kb_favorites, public.kb_checks, public.kb_templates, public.kb_trash,
  public.kb_file_purge to service_role;
grant usage, select on sequence public.kb_file_purge_id_seq to service_role;

alter table public.kb_favorites enable row level security;
alter table public.kb_checks enable row level security;
alter table public.kb_templates enable row level security;
alter table public.kb_trash enable row level security;
alter table public.kb_file_purge enable row level security;

-- Свои строки; поставить — только на статью, которую видит (RLS kb_nodes).
drop policy if exists "kb_favorites own" on public.kb_favorites;
create policy "kb_favorites own" on public.kb_favorites
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.kb_nodes n where n.id = node_id and n.base_id = kb_favorites.base_id)
  );

drop policy if exists "kb_checks own" on public.kb_checks;
create policy "kb_checks own" on public.kb_checks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.kb_nodes n
       where n.id = node_id and n.base_id = kb_checks.base_id and n.kind = 'article'
    )
  );

drop policy if exists "kb_templates editor" on public.kb_templates;
create policy "kb_templates editor" on public.kb_templates
  for all to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]))
  with check (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

drop policy if exists "kb_trash editor read" on public.kb_trash;
create policy "kb_trash editor read" on public.kb_trash
  for select to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

revoke all on function public.kb_trash_node(uuid), public.kb_trash_restore(uuid),
  public.kb_trash_delete(uuid), public.kb_trash_purge_due(),
  public.kb_mention_candidates(uuid), public.kb_authors(uuid) from public, anon;
grant execute on function public.kb_trash_node(uuid), public.kb_trash_restore(uuid),
  public.kb_trash_delete(uuid), public.kb_mention_candidates(uuid), public.kb_authors(uuid)
  to authenticated, service_role;
revoke all on function public.kb_trash_purge_due() from authenticated;
grant execute on function public.kb_trash_purge_due() to service_role;

notify pgrst, 'reload schema';
