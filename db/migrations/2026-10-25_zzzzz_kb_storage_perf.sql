-- База знаний: скорость аналитики на сотнях сотрудников, чистка файлов,
-- сроки хранения журналов, занятое место (решение владельца 2026-10-25
-- после разбора нагрузки: 500 сотрудников, 300 статей, год чтения).
--
-- 1) Аудитория статей — одним набором (kb_audience_pairs): «статьи × кому
--    выдана база (без владельцев)» минус авторы статьи. Раньше
--    kb_article_audience считалась по каждой статье отдельно, а вкладка
--    «Сотрудники» ещё и перебирала пары по каждому человеку: на 500
--    сотрудниках «Сотрудники» шли 16 с (предел запроса Supabase — 8 с),
--    «Обзор» — 4 с. kb_base_pairs, kb_analytics_people, kb_report,
--    kb_analytics_person, kb_analytics_overview переписаны на неё
--    (актуальные определения — здесь).
--    Смысл аудитории прежний (kb_article_audience остаётся для одной
--    статьи — kb_article_readers).
-- 2) Файлы, на которые ничего не ссылается (картинку убрали из статьи,
--    загрузили и не сохранили), раньше лежали вечно. kb_file_gc_candidates
--    (только service_role) отдаёт такие файлы бакета kb-media старше
--    p_grace_days дней: ссылки ищутся во всём, что может вернуться, —
--    статьи, черновики, версии, шаблоны, корзина. Удаляет сервер админки
--    раз в сутки через Storage API (lib/kb/trash-purge.server.ts).
-- 3) kb_housekeeping (только service_role, раз в сутки): журнал поиска
--    хранится год, дни чтения — 400 дней (аналитика смотрит не дальше 90 +
--    90 дней). Итоговое «кто что прочитал» (kb_reads) не стирается.
-- 4) kb_storage_usage — владельцу: файлы по базам и шаблонам (число и
--    объём из storage.objects.metadata.size), место таблиц базы знаний в
--    базе данных, число версий («Управление» → «Знания»).

-- 1) Аудитория одним набором -------------------------------------------------------
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
    select n.id, n.published_at, n.created_by, n.updated_by, n.published_by
      from public.kb_nodes n
     where n.base_id = p_base and n.kind = 'article'
       and (p_all or (n.status = 'published' and n.reader_visible))
  ),
  authors as (
    select a.id as node_id, x.uid as user_id
      from arts a
      cross join lateral (values (a.created_by), (a.updated_by), (a.published_by)) x(uid)
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

create or replace function public.kb_base_pairs(p_base uuid)
returns table (node_id uuid, user_id uuid, published_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.kb_audience_pairs(p_base, false)
$$;

create or replace function public.kb_analytics_people(p_base uuid, p_days integer default 30)
returns table (
  user_id uuid,
  full_name text,
  avatar_url text,
  level text,
  required integer,
  read_current integer,
  read_outdated integer,
  completed integer,
  seconds_total integer,
  seconds_period integer,
  views_period integer,
  active_days integer,
  first_read_at timestamptz,
  last_read_at timestamptz,
  last_node_id uuid,
  last_node_title text,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  d_from date := public.kb_today() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
begin
  perform public.kb_analytics_guard(p_base);
  return query
  with people as (select bp.user_id as uid, bp.level as lvl from public.kb_base_people(p_base) bp),
  st as (
    select pr.user_id as uid, public.kb_read_state(r, pr.published_at) as state,
           coalesce(r.max_scroll, 0) >= 90 as scrolled
      from public.kb_audience_pairs(p_base, false) pr
      left join public.kb_reads r on r.node_id = pr.node_id and r.user_id = pr.user_id
  ),
  agg as (
    select st.uid,
           count(*)::integer as req,
           (count(*) filter (where st.state = 'current'))::integer as cur,
           (count(*) filter (where st.state = 'outdated'))::integer as old,
           (count(*) filter (where st.state = 'current' and st.scrolled))::integer as done
      from st group by st.uid
  ),
  tot as (
    select r.user_id as uid, sum(r.seconds)::integer as secs, min(r.first_read_at) as first_at
      from public.kb_reads r where r.base_id = p_base group by r.user_id
  ),
  per as (
    select d.user_id as uid, sum(d.seconds)::integer as secs, sum(d.views)::integer as views,
           count(distinct d.day)::integer as days
      from public.kb_read_days d
     where d.base_id = p_base and d.day >= d_from
     group by d.user_id
  ),
  lst as (
    select distinct on (r.user_id) r.user_id as uid, r.last_read_at as at, r.node_id as nid, n.title
      from public.kb_reads r join public.kb_nodes n on n.id = r.node_id
     where r.base_id = p_base
     order by r.user_id, r.last_read_at desc
  )
  select pe.uid, p.full_name, p.avatar_url, pe.lvl,
         coalesce(agg.req, 0), coalesce(agg.cur, 0), coalesce(agg.old, 0), coalesce(agg.done, 0),
         coalesce(tot.secs, 0), coalesce(per.secs, 0), coalesce(per.views, 0), coalesce(per.days, 0),
         tot.first_at, lst.at, lst.nid, lst.title, u.last_sign_in_at
    from people pe
    left join agg on agg.uid = pe.uid
    left join tot on tot.uid = pe.uid
    left join per on per.uid = pe.uid
    left join lst on lst.uid = pe.uid
    left join public.profiles p on p.id = pe.uid
    left join auth.users u on u.id = pe.uid;
end;
$$;

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
  outdated_count integer,
  completed_count integer,
  avg_seconds integer,
  views_30d integer,
  last_read_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.kb_analytics_guard(p_base);
  return query
  with pairs as materialized (select * from public.kb_audience_pairs(p_base, true)),
  st as (
    select pr.node_id as nid, public.kb_read_state(r, pr.published_at) as state,
           coalesce(r.max_scroll, 0) as scroll, coalesce(r.seconds, 0) as secs, r.last_read_at as at
      from pairs pr
      left join public.kb_reads r on r.node_id = pr.node_id and r.user_id = pr.user_id
  ),
  agg as (
    select st.nid,
           count(*)::integer as total,
           (count(*) filter (where st.state = 'current'))::integer as readers,
           (count(*) filter (where st.state = 'outdated'))::integer as outdated,
           (count(*) filter (where st.state = 'current' and st.scroll >= 90))::integer as completed,
           coalesce(avg(nullif(st.secs, 0)), 0)::integer as avg_secs,
           max(st.at) as last_at
      from st group by st.nid
  ),
  views as (
    select d.node_id as nid, sum(d.views)::integer as v
      from public.kb_read_days d
      join pairs pr on pr.node_id = d.node_id and pr.user_id = d.user_id
     where d.base_id = p_base and d.day > public.kb_today() - 30
     group by d.node_id
  )
  select n.id, n.parent_id, n.title, n.status, n.created_at, pc.full_name,
         greatest(n.updated_at, d.updated_at),
         coalesce(case when d.updated_at > n.updated_at then pd.full_name end, pu.full_name),
         n.published_at, pp.full_name,
         d.node_id is not null,
         coalesce(agg.total, 0), coalesce(agg.readers, 0), coalesce(agg.outdated, 0),
         coalesce(agg.completed, 0), coalesce(agg.avg_secs, 0), coalesce(views.v, 0),
         agg.last_at
    from public.kb_nodes n
    left join public.kb_drafts d on d.node_id = n.id
    left join public.profiles pc on pc.id = n.created_by
    left join public.profiles pu on pu.id = n.updated_by
    left join public.profiles pd on pd.id = d.updated_by
    left join public.profiles pp on pp.id = n.published_by
    left join agg on agg.nid = n.id
    left join views on views.nid = n.id
   where n.base_id = p_base and n.kind = 'article';
end;
$$;

create or replace function public.kb_analytics_person(p_base uuid, p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform public.kb_analytics_guard(p_base);
  with req as (
    select pr.node_id, pr.published_at from public.kb_audience_pairs(p_base, false, p_user) pr
  ),
  arts as (
    select n.id, n.title, n.parent_id, n.published_at,
           req.node_id is not null as required,
           public.kb_read_state(r, n.published_at) as state,
           r.first_read_at, r.last_read_at, coalesce(r.read_count, 0) as read_count,
           coalesce(r.seconds, 0) as seconds, coalesce(r.max_scroll, 0) as max_scroll,
           r.completed_at, r.read_published_at
      from public.kb_nodes n
      left join req on req.node_id = n.id
      left join public.kb_reads r on r.node_id = n.id and r.user_id = p_user
     where n.base_id = p_base and n.kind = 'article'
       and (req.node_id is not null or r.node_id is not null)
  )
  select jsonb_build_object(
    'articles', coalesce((select jsonb_agg(to_jsonb(arts) order by arts.last_read_at desc nulls last, arts.title) from arts), '[]'),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', g.day::date, 'views', coalesce(x.views, 0), 'seconds', coalesce(x.seconds, 0))
               order by g.day), '[]')
        from generate_series(public.kb_today() - 29, public.kb_today(), interval '1 day') g(day)
        left join (
          select d.day, sum(d.views)::integer as views, sum(d.seconds)::integer as seconds
            from public.kb_read_days d
           where d.base_id = p_base and d.user_id = p_user
           group by d.day
        ) x on x.day = g.day::date
    ),
    'searches', (
      select coalesce(jsonb_agg(t order by t.created_at desc), '[]') from (
        select s.query, s.results, s.clicked_node_id, s.created_at
          from public.kb_search_log s
         where s.base_id = p_base and s.user_id = p_user
         order by s.created_at desc limit 10
      ) t
    )
  ) into result;
  return result;
end;
$$;

-- Обзор базы за последние p_days дней (и столько же до них — для сравнения).
-- Пары «сотрудник × статья» сводятся по статьям один раз (было: многократный
-- перебор всех пар — на 500 × 300 около секунды).
create or replace function public.kb_analytics_overview(p_base uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  d_to date := public.kb_today();
  d_from date := public.kb_today() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
  p_from date := d_from - days;
  t_from timestamptz := (d_from::timestamp at time zone 'Asia/Tbilisi');
  t_prev timestamptz := (p_from::timestamp at time zone 'Asia/Tbilisi');
  result jsonb;
begin
  perform public.kb_analytics_guard(p_base);

  with kb_an_people as materialized (select * from public.kb_base_people(p_base)),
  kb_an_pairs as materialized (select * from public.kb_base_pairs(p_base)),
  -- Пары сводятся по статьям сразу (300 строк вместо 150 000 на 500 × 300):
  -- итоги, «Прочитали не все» и разделы считаются из сводки.
  per_art as materialized (
    select x.node_id,
           count(*)::integer as audience,
           (count(*) filter (where x.state = 'current'))::integer as cur,
           (count(*) filter (where x.state = 'outdated'))::integer as old,
           (count(*) filter (where x.state = 'current' and x.scrolled))::integer as done
      from (
        select pr.node_id, public.kb_read_state(r, pr.published_at) as state,
               coalesce(r.max_scroll, 0) >= 90 as scrolled
          from kb_an_pairs pr
          left join public.kb_reads r on r.node_id = pr.node_id and r.user_id = pr.user_id
      ) x
     group by x.node_id
  ),
  days_cur as materialized (
    select d.* from public.kb_read_days d
     where d.base_id = p_base and d.day between d_from and d_to
       and d.user_id in (select user_id from kb_an_people)
  ),
  days_prev as (
    select d.* from public.kb_read_days d
     where d.base_id = p_base and d.day between p_from and d_from - 1
       and d.user_id in (select user_id from kb_an_people)
  ),
  srch as (
    select * from public.kb_search_log s
     where s.base_id = p_base and s.created_at >= t_prev
       and s.user_id in (select user_id from kb_an_people)
  ),
  articles as (
    select n.id, n.parent_id, n.title, n.published_at, n.path
      from public.kb_nodes n
     where n.base_id = p_base and n.kind = 'article' and n.status = 'published' and n.reader_visible
  )
  select jsonb_build_object(
    'from', d_from, 'to', d_to, 'days', days,
    'people', (select count(*) from kb_an_people),
    'articles', (select count(*) from articles),
    'pairs', (select coalesce(sum(audience), 0) from per_art),
    'read_current', (select coalesce(sum(cur), 0) from per_art),
    'read_outdated', (select coalesce(sum(old), 0) from per_art),
    'completed', (select coalesce(sum(done), 0) from per_art),
    'never_read', (select count(*) from per_art where cur = 0 and old = 0),
    'current', jsonb_build_object(
      'views', (select coalesce(sum(views), 0) from days_cur),
      'readers', (select count(distinct user_id) from days_cur where views > 0 or seconds > 0),
      'seconds', (select coalesce(sum(seconds), 0) from days_cur),
      'searches', (select count(*) from srch where created_at >= t_from),
      'zero_searches', (select count(*) from srch where created_at >= t_from and results = 0)
    ),
    'previous', jsonb_build_object(
      'views', (select coalesce(sum(views), 0) from days_prev),
      'readers', (select count(distinct user_id) from days_prev where views > 0 or seconds > 0),
      'seconds', (select coalesce(sum(seconds), 0) from days_prev),
      'searches', (select count(*) from srch where created_at < t_from),
      'zero_searches', (select count(*) from srch where created_at < t_from and results = 0)
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', g.day::date,
               'views', coalesce(x.views, 0),
               'readers', coalesce(x.readers, 0),
               'seconds', coalesce(x.seconds, 0)) order by g.day), '[]')
        from generate_series(d_from, d_to, interval '1 day') g(day)
        left join (
          select day, sum(views)::integer as views, sum(seconds)::integer as seconds,
                 count(distinct user_id) filter (where views > 0 or seconds > 0)::integer as readers
            from days_cur group by day
        ) x on x.day = g.day::date
    ),
    'top_articles', (
      select coalesce(jsonb_agg(t order by t.views desc, t.seconds desc), '[]') from (
        select a.id, a.title, sum(dc.views)::integer as views,
               count(distinct dc.user_id)::integer as readers, sum(dc.seconds)::integer as seconds
          from days_cur dc join articles a on a.id = dc.node_id
         group by a.id, a.title
         having sum(dc.views) > 0 or sum(dc.seconds) > 0
         order by sum(dc.views) desc, sum(dc.seconds) desc
         limit 10
      ) t
    ),
    'attention', (
      select coalesce(jsonb_agg(t order by t.share, t.published_at desc), '[]') from (
        select a.id, a.title, a.published_at, pa.audience,
               pa.cur as read_current, pa.old as read_outdated,
               pa.cur::numeric / pa.audience as share
          from per_art pa join articles a on a.id = pa.node_id
         where pa.cur < pa.audience
         order by pa.cur::numeric / pa.audience, a.published_at desc
         limit 8
      ) t
    ),
    'sections', (
      select coalesce(jsonb_agg(t order by t.sort_order nulls last, t.title), '[]') from (
        select f.id, f.title, f.icon, f.sort_order,
               count(a.id)::integer as articles,
               coalesce(sum(pa.audience), 0)::integer as pairs,
               coalesce(sum(pa.cur), 0)::integer as read_current,
               coalesce(sum(pa.old), 0)::integer as read_outdated
          from public.kb_nodes f
          join articles a on a.path[1] = f.id
          left join per_art pa on pa.node_id = a.id
         where f.base_id = p_base and f.kind = 'folder' and f.parent_id is null and f.reader_visible
         group by f.id, f.title, f.icon, f.sort_order
      ) t
    ),
    'top_queries', (
      select coalesce(jsonb_agg(t order by t.count desc, t.query), '[]') from (
        select query, count(*)::integer as count, count(distinct user_id)::integer as users,
               max(results)::integer as results, count(clicked_node_id)::integer as clicks
          from srch where created_at >= t_from
         group by query order by count(*) desc, query limit 15
      ) t
    ),
    'zero_queries', (
      select coalesce(jsonb_agg(t order by t.count desc, t.last_at desc), '[]') from (
        select query, count(*)::integer as count, count(distinct user_id)::integer as users,
               max(created_at) as last_at
          from srch where created_at >= t_from
         group by query having max(results) = 0
         order by count(*) desc, max(created_at) desc limit 15
      ) t
    )
  ) into result;
  return result;
end;
$$;

-- 2) Файлы без ссылок ------------------------------------------------------------------
create or replace function public.kb_file_gc_candidates(
  p_grace_days integer default 7, p_limit integer default 500
)
returns table (name text)
language sql
stable
security definer
set search_path = public, storage
as $$
  with docs as (
    select n.content::text as t from public.kb_nodes n where n.content is not null
    union all select d.content::text from public.kb_drafts d
    union all select v.content::text from public.kb_revisions v
    union all select tp.content::text from public.kb_templates tp
    union all select tr.payload::text from public.kb_trash tr
  ),
  refs as (
    select distinct m[1] as path
      from docs, regexp_matches(docs.t, 'kbfile:([A-Za-z0-9._/-]+)', 'g') m
  )
  select o.name
    from storage.objects o
   where o.bucket_id = 'kb-media'
     and o.created_at < now() - make_interval(days => greatest(coalesce(p_grace_days, 7), 1))
     and not exists (select 1 from refs where refs.path = o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;

-- 3) Сроки хранения журналов ---------------------------------------------------------
create or replace function public.kb_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  searches integer;
  days integer;
begin
  delete from public.kb_search_log where created_at < now() - interval '365 days';
  get diagnostics searches = row_count;
  delete from public.kb_read_days where day < public.kb_today() - 400;
  get diagnostics days = row_count;
  return jsonb_build_object('search_log', searches, 'read_days', days);
end;
$$;

revoke all on function public.kb_file_gc_candidates(integer, integer), public.kb_housekeeping()
  from public, anon, authenticated;
grant execute on function public.kb_file_gc_candidates(integer, integer), public.kb_housekeeping()
  to service_role;

-- 4) Занятое место -----------------------------------------------------------------------
create or replace function public.kb_storage_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  result jsonb;
begin
  if not public.kb_is_admin(auth.uid()) then
    raise exception 'kb_forbidden';
  end if;
  with files as (
    select split_part(o.name, '/', 1) as folder,
           coalesce((o.metadata ->> 'size')::bigint, 0) as size
      from storage.objects o
     where o.bucket_id = 'kb-media'
  )
  select jsonb_build_object(
    'bases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'title', b.title,
               'files', (select count(*) from files f where f.folder = b.id::text),
               'bytes', (select coalesce(sum(f.size), 0) from files f where f.folder = b.id::text),
               'articles', (select count(*) from public.kb_nodes n where n.base_id = b.id and n.kind = 'article'),
               'revisions', (select count(*) from public.kb_revisions v where v.base_id = b.id))
             order by b.sort_order, b.created_at)
        from public.kb_bases b), '[]'),
    'templates', jsonb_build_object(
      'files', (select count(*) from files f where f.folder = 'templates'),
      'bytes', (select coalesce(sum(f.size), 0) from files f where f.folder = 'templates')),
    'files_total', (select count(*) from files),
    'bytes_total', (select coalesce(sum(size), 0) from files),
    'db_bytes', (
      select coalesce(sum(pg_total_relation_size(c.oid)), 0)
        from pg_class c join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'kb\_%'
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.kb_storage_usage() from public, anon;
grant execute on function public.kb_storage_usage() to authenticated, service_role;
