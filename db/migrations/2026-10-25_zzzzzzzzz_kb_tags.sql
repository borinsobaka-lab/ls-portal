-- Теги статей базы знаний (решение владельца 2026-10-25).
--
-- 1) kb_tags — теги базы: свой список у каждой базы, имя без регистра
--    уникально в базе («Касса» и «касса» — один тег), до 40 знаков,
--    пробелы по краям и «#» в начале срезаются. Видят все, у кого есть
--    доступ к базе; заводят, переименовывают и удаляют — редакторы базы.
-- 2) kb_node_tags — теги статьи (только статьи, не папки; до 10 на статью),
--    ставят и снимают редакторы. Читатель видит теги только видимых ему
--    статей (через RLS kb_nodes).
-- 3) kb_search — находит и статьи с тегом, совпавшим с запросом («#касса»
--    или «касса»): точное имя тега поднимает статью выше. Тип ответа прежний.
-- 4) Корзина: теги удалённых статей уходят в снимок (триггер на вставку в
--    kb_trash), «Вернуть» ставит их обратно (триггер на удаление строки
--    корзины: статьи уже на месте). Удалено навсегда — статей нет, нечего
--    ставить. kb_trash_node / kb_trash_restore не переписаны.

-- 1) Теги ---------------------------------------------------------------------------

create table if not exists public.kb_tags (
  id uuid primary key default gen_random_uuid(),
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists kb_tags_base_name_key on public.kb_tags (base_id, lower(name));

create or replace function public.kb_tags_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- «  #Касса   смены » → «Касса смены».
  new.name := regexp_replace(btrim(regexp_replace(coalesce(new.name, ''), '^\s*#+', '')), '\s+', ' ', 'g');
  if new.name = '' then
    raise exception 'kb_tag_empty';
  end if;
  if tg_op = 'UPDATE' then
    new.base_id := old.base_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists kb_tags_biu on public.kb_tags;
create trigger kb_tags_biu
  before insert or update on public.kb_tags
  for each row execute function public.kb_tags_biu();

-- 2) Теги статьи ----------------------------------------------------------------------

create table if not exists public.kb_node_tags (
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  tag_id uuid not null references public.kb_tags(id) on delete cascade,
  -- База статьи — ставит триггер (для политик массивом).
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (node_id, tag_id)
);
create index if not exists kb_node_tags_tag_idx on public.kb_node_tags (tag_id);
create index if not exists kb_node_tags_base_idx on public.kb_node_tags (base_id);

create or replace function public.kb_node_tags_bi()
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
    raise exception 'kb_tag_not_article';
  end if;
  if not exists (select 1 from public.kb_tags where id = new.tag_id and base_id = n.base_id) then
    raise exception 'kb_tag_other_base';
  end if;
  if (select count(*) from public.kb_node_tags where node_id = new.node_id) >= 10 then
    raise exception 'kb_too_many_tags';
  end if;
  new.base_id := n.base_id;
  return new;
end;
$$;

drop trigger if exists kb_node_tags_bi on public.kb_node_tags;
create trigger kb_node_tags_bi
  before insert on public.kb_node_tags
  for each row execute function public.kb_node_tags_bi();

alter table public.kb_tags enable row level security;
alter table public.kb_node_tags enable row level security;

revoke all on public.kb_tags, public.kb_node_tags from anon, authenticated;
grant select, insert, update, delete on public.kb_tags to authenticated;
grant select, insert, delete on public.kb_node_tags to authenticated;
grant all on public.kb_tags, public.kb_node_tags to service_role;

drop policy if exists "kb_tags read" on public.kb_tags;
create policy "kb_tags read" on public.kb_tags
  for select to authenticated
  using (base_id = any ((select public.auth_kb_view_base_ids())::uuid[]));

drop policy if exists "kb_tags editor write" on public.kb_tags;
create policy "kb_tags editor write" on public.kb_tags
  for all to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]))
  with check (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

-- Читатель — теги только тех статей, что видит (RLS kb_nodes в exists).
drop policy if exists "kb_node_tags read" on public.kb_node_tags;
create policy "kb_node_tags read" on public.kb_node_tags
  for select to authenticated
  using (
    base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
    or (
      base_id = any ((select public.auth_kb_view_base_ids())::uuid[])
      and exists (select 1 from public.kb_nodes n where n.id = node_id)
    )
  );

drop policy if exists "kb_node_tags editor write" on public.kb_node_tags;
create policy "kb_node_tags editor write" on public.kb_node_tags
  for all to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]))
  with check (
    exists (
      select 1 from public.kb_nodes n
       where n.id = node_id and n.base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
    )
  );

-- 3) Поиск: и по тегу ---------------------------------------------------------------------

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
           '%' || replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           -- Тег ищется без «#» и лишних пробелов: «#касса» = «касса».
           lower(regexp_replace(btrim(regexp_replace(coalesce(p_query, ''), '^\s*#+', '')), '\s+', ' ', 'g')) as tag
  ),
  tagged as (
    select nt.node_id, bool_or(lower(t.name) = q.tag) as exact
      from public.kb_node_tags nt
      join public.kb_tags t on t.id = nt.tag_id, q
     where nt.base_id = p_base
       and q.tag <> ''
       and lower(t.name) like '%' || replace(replace(replace(q.tag, '\', '\\'), '%', '\%'), '_', '\_') || '%'
     group by nt.node_id
  ),
  hits as (
    select n.id, n.parent_id, n.kind, n.title, n.status, n.content_text,
           (case when q.tsq is null then 0 else ts_rank(n.search, q.tsq) end
             + case when n.title ilike q.pat then 1 else 0 end
             + case when tg.exact then 2 when tg.node_id is not null then 1 else 0 end)::real as rank
      from public.kb_nodes n
      cross join q
      left join tagged tg on tg.node_id = n.id
     where n.base_id = p_base
       and (p_folder is null or n.path @> array[p_folder])
       and btrim(coalesce(p_query, '')) <> ''
       and ((q.tsq is not null and n.search @@ q.tsq) or n.title ilike q.pat or tg.node_id is not null)
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

-- 4) Корзина ---------------------------------------------------------------------------

create or replace function public.kb_trash_tags_bi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('tags', coalesce((
    select jsonb_agg(jsonb_build_object('node_id', nt.node_id, 'tag_id', nt.tag_id))
      from public.kb_node_tags nt
     where nt.node_id in (
       select (e ->> 'id')::uuid from jsonb_array_elements(coalesce(new.payload -> 'nodes', '[]')) e
     )
  ), '[]'::jsonb));
  return new;
end;
$$;

drop trigger if exists kb_trash_tags_bi on public.kb_trash;
create trigger kb_trash_tags_bi
  before insert on public.kb_trash
  for each row execute function public.kb_trash_tags_bi();

-- Строка корзины ушла: после «Вернуть» статьи на месте — теги обратно (тег,
-- удалённый за это время, не возвращается). Удалено навсегда — статей нет.
create or replace function public.kb_trash_tags_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kb_node_tags (node_id, tag_id, base_id)
  select x.node_id, x.tag_id, old.base_id
    from jsonb_to_recordset(coalesce(old.payload -> 'tags', '[]')) as x(node_id uuid, tag_id uuid)
   where exists (select 1 from public.kb_nodes n where n.id = x.node_id and n.kind = 'article')
     and exists (select 1 from public.kb_tags t where t.id = x.tag_id)
  on conflict do nothing;
  return old;
end;
$$;

drop trigger if exists kb_trash_tags_ad on public.kb_trash;
create trigger kb_trash_tags_ad
  after delete on public.kb_trash
  for each row execute function public.kb_trash_tags_ad();

revoke all on function public.kb_tags_biu(), public.kb_node_tags_bi(), public.kb_trash_tags_bi(),
  public.kb_trash_tags_ad() from public, anon, authenticated;
