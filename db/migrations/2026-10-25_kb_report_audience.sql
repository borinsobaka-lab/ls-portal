-- База знаний: кого считать в отчёте по чтению (замечание тестирования
-- 2026-10-25: у каждой статьи было «1 из 2 · 50%» — владелец и автор сами
-- открывали статью и попадали в прочитавших).
--
-- Аудитория статьи теперь — сотрудники, которым база выдана в «Доступах»
-- («Просмотр» или «Правка»), кроме:
--   * владельцев (owner хоть в одной студии) — они видят все базы и пишут
--     их сами, это не те, кого проверяют;
--   * авторов этой статьи — кто её создал, правил, публиковал или держит
--     черновик правок.
-- Отчёт и список «кто прочитал» считают только эту аудиторию, «последнее
-- чтение» — тоже по ней. kb_base_audience больше не используется.

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
     and public.is_staff(g.subject_id)
     and not exists (
       select 1 from public.user_roles r where r.user_id = g.subject_id and r.role = 'owner'
     )
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
revoke all on function public.kb_article_audience(uuid) from public, anon, authenticated;

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
  select n.id, n.parent_id, n.title, n.status, n.created_at, pc.full_name,
         greatest(n.updated_at, d.updated_at),
         coalesce(case when d.updated_at > n.updated_at then pd.full_name end, pu.full_name),
         n.published_at, pp.full_name,
         d.node_id is not null,
         a.total,
         a.readers,
         a.last_read
    from public.kb_nodes n
    left join public.kb_drafts d on d.node_id = n.id
    left join public.profiles pc on pc.id = n.created_by
    left join public.profiles pu on pu.id = n.updated_by
    left join public.profiles pd on pd.id = d.updated_by
    left join public.profiles pp on pp.id = n.published_by
    cross join lateral (
      select count(*)::integer as total,
             count(r.user_id)::integer as readers,
             max(r.last_read_at) as last_read
        from public.kb_article_audience(n.id) au
        left join public.kb_reads r on r.node_id = n.id and r.user_id = au.user_id
    ) a
   where n.base_id = p_base and n.kind = 'article';
end;
$$;

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
    from public.kb_article_audience(p_node) a
    left join public.profiles p on p.id = a.user_id
    left join public.kb_reads r on r.node_id = p_node and r.user_id = a.user_id
   order by r.last_read_at desc nulls last, p.full_name;
end;
$$;
