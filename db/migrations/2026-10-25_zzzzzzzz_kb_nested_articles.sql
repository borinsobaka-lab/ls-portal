-- ============================================================================
-- База знаний: многоуровневая вложенность статей (решение владельца
-- 2026-10-25; бриф №2 — «статья работает как раздел и показывает вложенные
-- статьи, вложенность многоуровневая»).
--
-- Раньше родителем могла быть только папка — у статьи не было вложенных
-- статей. Теперь у статьи могут быть вложенные статьи на любую глубину
-- (папки в статье — нет: kb_folder_in_article); папки по-прежнему вкладываются
-- в папки. Видимость читателю наследуется как у папок: статья-черновик прячет
-- вложенное (kb_nodes.reader_visible). Корзина забирает статью со всеми
-- вложенными и возвращает её под прежнюю статью-родителя.
--
-- Актуальные определения kb_nodes_biu и kb_trash_restore — здесь.
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1) Триггер дерева: родитель — папка или (для статьи) статья -----------------------
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
    -- В статье — только статьи (вложенные статьи); в папке — что угодно.
    if p.kind = 'article' and new.kind <> 'article' then
      raise exception 'kb_folder_in_article';
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

-- 2) Возврат из корзины: под прежнюю статью-родителя ------------------------------
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
  -- Прежний родитель на месте — туда же (статью — и в статью); иначе — наверх.
  parent := (select id from public.kb_nodes
              where id = t.parent_id and (kind = 'folder' or t.kind = 'article'));

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
      content, created_by, created_at, updated_by, updated_at, published_by, published_at,
      feedback_enabled, pager_enabled
    ) values (
      r.id, r.base_id, case when r.id = t.root_id then parent else r.parent_id end,
      r.kind, r.title, r.description, r.icon, coalesce(r.protect, 'inherit'),
      case when r.id = t.root_id then null else r.sort_order end, r.status,
      r.content, public.kb_existing_user(r.created_by), r.created_at,
      public.kb_existing_user(r.updated_by), r.updated_at,
      public.kb_existing_user(r.published_by), r.published_at,
      coalesce(r.feedback_enabled, true), coalesce(r.pager_enabled, true)
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
  -- Снимки до этой миграции оценок не знают — coalesce.
  insert into public.kb_ratings (node_id, base_id, user_id, score, version_at, created_at, rated_at)
  select x.node_id, x.base_id, x.user_id, x.score, x.version_at, x.created_at, x.rated_at
    from jsonb_populate_recordset(null::public.kb_ratings, coalesce(t.payload -> 'ratings', '[]')) x
   where public.kb_existing_user(x.user_id) is not null;

  delete from public.kb_trash where id = p_id;
  perform set_config('kb.restoring', '', true);
  return t.root_id;
end;
$$;

notify pgrst, 'reload schema';
