-- База знаний: автор статьи меняется редактором (решение владельца 2026-10-28).
--
-- Раньше «Автор» в шапке статьи — кто опубликовал последнюю версию
-- (kb_nodes.published_by): поправил опечатку — стал автором. Теперь у
-- статьи может быть явный автор kb_nodes.author_id: ставят и меняют
-- редакторы базы (прежняя политика правки kb_nodes), null — как раньше,
-- кто опубликовал. Автор — только у статьи и только действующий человек
-- портала (is_portal_user), иначе kb_bad_author; правка автора не меняет
-- «кто и когда правил» (kb_nodes_biu смотрит только название, описание,
-- статус и текст).
--
-- * kb_authors (актуальное определение — здесь) отдаёт и явных авторов:
--   имя и аватарку человека из другого клуба RLS профилей не отдаёт.
-- * Аудитория отчёта по чтению — без явного автора, как без прочих авторов
--   статьи: kb_audience_pairs и kb_article_audience (актуальные
--   определения — здесь).
-- * Корзина: снимок статьи (to_jsonb) уносит author_id сам, kb_trash_restore
--   вставляет колонки поимённо — автора возвращает триггер на строке
--   корзины (как теги, kb_trash_author_ad). «Сделать копию» автора не
--   переносит: копия — новая статья того, кто копировал.

alter table public.kb_nodes
  add column if not exists author_id uuid references auth.users(id) on delete set null;

-- 1) Проверка автора -----------------------------------------------------------------
create or replace function public.kb_nodes_author_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_id is not null
     and (tg_op = 'INSERT' or new.author_id is distinct from old.author_id) then
    if new.kind <> 'article' then
      raise exception 'kb_not_article';
    end if;
    if not public.is_portal_user(new.author_id) then
      raise exception 'kb_bad_author';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists kb_nodes_author_biu on public.kb_nodes;
create trigger kb_nodes_author_biu
  before insert or update of author_id on public.kb_nodes
  for each row execute function public.kb_nodes_author_biu();

-- 2) Корзина: «Вернуть» возвращает автора --------------------------------------------
create or replace function public.kb_trash_author_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.kb_nodes n
     set author_id = x.author_id
    from jsonb_to_recordset(coalesce(old.payload -> 'nodes', '[]')) as x(id uuid, author_id uuid)
   where n.id = x.id
     and n.kind = 'article'
     and x.author_id is not null
     and n.author_id is null
     and public.is_portal_user(x.author_id);
  return old;
end;
$$;

drop trigger if exists kb_trash_author_ad on public.kb_trash;
create trigger kb_trash_author_ad
  after delete on public.kb_trash
  for each row execute function public.kb_trash_author_ad();

revoke all on function public.kb_nodes_author_biu(), public.kb_trash_author_ad()
  from public, anon, authenticated;

-- 3) Имена и аватарки авторов ---------------------------------------------------------
create or replace function public.kb_authors(p_base uuid)
returns table (user_id uuid, full_name text, avatar_url text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lvl text := public.kb_base_level(auth.uid(), p_base);
begin
  if lvl is null then
    raise exception 'kb_forbidden';
  end if;
  return query
  select p.id, p.full_name, p.avatar_url
    from public.profiles p
   where p.id in (
     select unnest(array[n.created_by, n.updated_by, n.published_by, n.author_id])
       from public.kb_nodes n where n.base_id = p_base
     union
     select d.updated_by from public.kb_drafts d where d.base_id = p_base
     union
     select r.published_by from public.kb_revisions r where r.base_id = p_base
     union
     select unnest(array[t.created_by, t.updated_by])
       from public.kb_templates t where lvl in ('edit', 'manage')
     union
     select t.deleted_by from public.kb_trash t where t.base_id = p_base
   );
end;
$$;
revoke all on function public.kb_authors(uuid) from public, anon;
grant execute on function public.kb_authors(uuid) to authenticated, service_role;

-- 4) Аудитория отчёта — без явного автора --------------------------------------------
create or replace function public.kb_audience_pairs(
  p_base uuid, p_all boolean default false, p_user uuid default null
)
returns table (node_id uuid, user_id uuid, published_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select bp.user_id from public.kb_base_people(p_base) bp
     where p_user is null or bp.user_id = p_user
  ),
  arts as (
    select n.id, n.published_at, n.created_by, n.updated_by, n.published_by, n.author_id
      from public.kb_nodes n
     where n.base_id = p_base and n.kind = 'article'
       and (p_all or (n.status = 'published' and n.reader_visible))
  ),
  authors as (
    select a.id as node_id, x.uid as user_id
      from arts a
      cross join lateral (values (a.created_by), (a.updated_by), (a.published_by), (a.author_id)) x(uid)
     where x.uid is not null
    union
    select d.node_id, d.updated_by from public.kb_drafts d
     where d.base_id = p_base and d.updated_by is not null
    union
    select v.node_id, v.published_by from public.kb_revisions v
     where v.base_id = p_base and v.published_by is not null
  )
  select a.id, p.user_id, a.published_at
    from arts a
    cross join people p
   where not exists (
     select 1 from authors au where au.node_id = a.id and au.user_id = p.user_id
   )
$$;
revoke all on function public.kb_audience_pairs(uuid, boolean, uuid) from public, anon, authenticated;

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
     and g.subject_id is distinct from n.author_id
     and not exists (
       select 1 from public.kb_drafts d where d.node_id = n.id and d.updated_by = g.subject_id
     )
     and not exists (
       select 1 from public.kb_revisions v where v.node_id = n.id and v.published_by = g.subject_id
     )
$$;
