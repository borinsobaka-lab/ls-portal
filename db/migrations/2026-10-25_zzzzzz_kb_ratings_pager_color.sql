-- База знаний: оценка статей, «Предыдущая / Следующая» и цвет базы
-- (решения владельца 2026-10-25).
--
-- 1) Оценка в конце статьи — три смайлика (плохо / нормально / хорошо).
--    kb_nodes.feedback_enabled (по умолчанию включено, выключается в
--    настройках статьи). Оценки — kb_ratings: строка на сотрудника × статью
--    × опубликованную версию (повторная оценка той же версии меняет строку,
--    новая версия — новая строка: видно, как оценивали и прежний текст).
--    Пишет только RPC kb_rate (видимая сотруднику опубликованная статья с
--    включённой оценкой). Свои строки читает сам сотрудник, все — редакторы
--    базы и владельцы; сводка и хронология — kb_ratings_report (аналитика,
--    вкладка «Оценки»).
-- 2) kb_nodes.pager_enabled — переход к предыдущей и следующей статье внизу
--    статьи (по умолчанию включено; порядок — дерево базы, считает админка).
-- 3) kb_bases.brand_color — фирменный цвет базы (#rrggbb, null — цвет
--    клуба): внутри базы им красится всё, что красится цветом клуба.
-- 4) Корзина и копия знают о новых колонках и оценках: kb_trash_node /
--    kb_trash_restore (снимок с оценками) и kb_copy_node переопределены
--    (актуальные определения — здесь).

-- 1) Колонки ------------------------------------------------------------------------
alter table public.kb_nodes add column if not exists feedback_enabled boolean not null default true;
alter table public.kb_nodes add column if not exists pager_enabled boolean not null default true;
alter table public.kb_bases add column if not exists brand_color text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'kb_bases_brand_color_check' and conrelid = 'public.kb_bases'::regclass
  ) then
    alter table public.kb_bases
      add constraint kb_bases_brand_color_check check (brand_color ~ '^#[0-9a-f]{6}$');
  end if;
end;
$$;

-- 2) Оценки -------------------------------------------------------------------------
create table if not exists public.kb_ratings (
  id bigserial primary key,
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 1 — плохо, 2 — нормально, 3 — хорошо.
  score smallint not null check (score between 1 and 3),
  -- Какую версию оценил (kb_nodes.published_at на момент оценки; статье,
  -- опубликованной без kb_publish, — её created_at).
  version_at timestamptz not null,
  created_at timestamptz not null default now(),
  rated_at timestamptz not null default now(),
  unique (node_id, user_id, version_at)
);
create index if not exists kb_ratings_base_idx on public.kb_ratings (base_id, rated_at desc);
create index if not exists kb_ratings_user_idx on public.kb_ratings (user_id, node_id);

revoke all on public.kb_ratings from anon, authenticated;
grant select on public.kb_ratings to authenticated;
grant all on public.kb_ratings to service_role;
grant usage, select on sequence public.kb_ratings_id_seq to service_role;
alter table public.kb_ratings enable row level security;

drop policy if exists "kb_ratings read" on public.kb_ratings;
create policy "kb_ratings read" on public.kb_ratings
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
  );

-- Оценить статью (или поменять оценку этой же версии).
create or replace function public.kb_rate(p_node uuid, p_score integer)
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
    raise exception 'kb_forbidden';
  end if;
  if p_score is null or p_score not between 1 and 3 then
    raise exception 'kb_bad_score';
  end if;
  select * into n from public.kb_nodes where id = p_node;
  if not found or n.kind <> 'article' then
    raise exception 'kb_not_found';
  end if;
  lvl := public.kb_base_level(auth.uid(), n.base_id);
  if lvl is null or (lvl = 'view' and not n.reader_visible) then
    raise exception 'kb_not_found';
  end if;
  if n.status <> 'published' or not n.feedback_enabled then
    raise exception 'kb_rating_off';
  end if;
  insert into public.kb_ratings as r (node_id, base_id, user_id, score, version_at)
  values (p_node, n.base_id, auth.uid(), p_score, coalesce(n.published_at, n.created_at))
  on conflict (node_id, user_id, version_at) do update
     set score = excluded.score, rated_at = now();
end;
$$;

-- Оценки базы за последние p_days дней (null — за всё время) и столько же
-- до них: итоги, по статьям и хронология (последние 1000).
create or replace function public.kb_ratings_report(p_base uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  d_to date := public.kb_today();
  d_from date := d_to - (days - 1);
  t_from timestamptz := case when p_days is null then '-infinity'::timestamptz
                             else (d_from::timestamp at time zone 'Asia/Tbilisi') end;
  t_prev timestamptz := case when p_days is null then '-infinity'::timestamptz
                             else ((d_from - days)::timestamp at time zone 'Asia/Tbilisi') end;
  result jsonb;
begin
  perform public.kb_analytics_guard(p_base);

  with rt as materialized (
    select r.* from public.kb_ratings r
     where r.base_id = p_base and r.rated_at >= t_prev
  ),
  cur as (select * from rt where rated_at >= t_from),
  prv as (select * from rt where rated_at < t_from)
  select jsonb_build_object(
    'from', case when p_days is null then null else d_from end,
    'to', d_to,
    'current', (
      select jsonb_build_object(
        'count', count(*), 'people', count(distinct user_id),
        'bad', count(*) filter (where score = 1),
        'ok', count(*) filter (where score = 2),
        'good', count(*) filter (where score = 3))
        from cur
    ),
    'previous', (
      select jsonb_build_object(
        'count', count(*), 'people', count(distinct user_id),
        'bad', count(*) filter (where score = 1),
        'ok', count(*) filter (where score = 2),
        'good', count(*) filter (where score = 3))
        from prv
    ),
    'articles', (
      select coalesce(jsonb_agg(t order by t.count desc, t.last_at desc), '[]') from (
        select n.id, n.title, n.parent_id, n.status, n.feedback_enabled,
               count(*)::integer as count,
               (count(*) filter (where c.score = 1))::integer as bad,
               (count(*) filter (where c.score = 2))::integer as ok,
               (count(*) filter (where c.score = 3))::integer as good,
               max(c.rated_at) as last_at
          from cur c join public.kb_nodes n on n.id = c.node_id
         group by n.id, n.title, n.parent_id, n.status, n.feedback_enabled
      ) t
    ),
    'log', (
      select coalesce(jsonb_agg(t order by t.rated_at desc, t.id desc), '[]') from (
        select c.id, c.node_id, n.title, c.user_id, p.full_name, p.avatar_url, c.score,
               c.created_at, c.rated_at,
               c.version_at < coalesce(n.published_at, n.created_at) as outdated
          from cur c
          join public.kb_nodes n on n.id = c.node_id
          left join public.profiles p on p.id = c.user_id
         order by c.rated_at desc, c.id desc
         limit 1000
      ) t
    )
  ) into result
    from (select 1) one;
  return result;
end;
$$;

revoke all on function public.kb_rate(uuid, integer), public.kb_ratings_report(uuid, integer)
  from public, anon;
grant execute on function public.kb_rate(uuid, integer), public.kb_ratings_report(uuid, integer)
  to authenticated, service_role;

-- 3) Корзина: снимок с оценками, возврат — с настройками статьи ----------------------
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
      'checks', coalesce((select jsonb_agg(to_jsonb(c)) from public.kb_checks c where c.node_id = any(ids)), '[]'),
      'ratings', coalesce((select jsonb_agg(to_jsonb(r)) from public.kb_ratings r where r.node_id = any(ids)), '[]')
    ),
    auth.uid()
  )
  returning id into t_id;

  -- Одной командой: ссылка на родителя (no action) проверяется в её конце.
  delete from public.kb_nodes where id = any(ids);
  return t_id;
end;
$$;

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

-- 4) Копия статьи — с её настройками (оценка, переход), оценки не копируются.
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
  insert into public.kb_nodes (
    base_id, parent_id, kind, title, sort_order, status, protect, feedback_enabled, pager_enabled
  )
  values (
    n.base_id, n.parent_id, 'article', left(n.title || ' (копия)', 200), n.sort_order + 1, 'draft',
    n.protect, n.feedback_enabled, n.pager_enabled
  )
  returning id into new_id;
  if doc is not null then
    insert into public.kb_drafts (node_id, base_id, content) values (new_id, n.base_id, doc);
  end if;
  return new_id;
end;
$$;
