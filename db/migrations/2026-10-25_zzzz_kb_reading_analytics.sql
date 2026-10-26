-- База знаний: учёт чтения и аналитика (решение владельца 2026-10-25:
-- «фиксировать, кто что прочитал и когда последний раз, и прочее полезное;
-- красивая аналитика в разделе базы знаний»).
--
-- Что копится:
-- 1) kb_reads (строка на сотрудника × статью) — ещё и какую версию читал
--    последней (read_published_at: published_at статьи в момент чтения —
--    вышла новая версия, он её не открывал → «читал прежнюю версию»),
--    сколько секунд читал (seconds: только пока вкладка видна и человек
--    что-то делает — считает браузер, база режет не больше 60 с за раз),
--    докуда прокрутил (max_scroll, 0–100 %) и когда дочитал до конца
--    (completed_at, ≥ 90 %). Новая версия статьи начинает прокрутку и
--    «дочитал» заново: дочитал — значит актуальную.
-- 2) kb_read_days — день по Тбилиси × сотрудник × статья: открытия
--    (views — как read_count, повтор не чаще раза в 30 минут) и секунды.
--    Отсюда графики по дням и «активные читатели».
-- 3) kb_search_log — что ищут в базе: запрос, сколько нашлось, перешёл ли
--    по результату. Запросы без результатов — темы, о которых стоит
--    написать. Набор по буквам («адм», «админ», «администр») пишется одной
--    строкой: следующий запрос того же человека в течение 2 минут, который
--    продолжает предыдущий, заменяет его.
--
-- Пишут только RPC: kb_mark_read (переопределена), kb_track_reading,
-- kb_log_search, kb_log_search_click. Читают — редакторы базы и владельцы
-- (как отчёт по чтению): kb_analytics_overview, kb_analytics_people,
-- kb_analytics_person, kb_report и kb_article_readers (пересозданы — новые
-- колонки). Кого считают: сотрудники, которым база выдана в «Доступах»,
-- без владельцев (kb_base_people); у статьи — ещё и без её авторов
-- (kb_article_audience, как раньше). Удалённая в корзину статья теряет
-- дни чтения (kb_read_days), возвращённая — снова копит с нуля.

-- 1) Колонки и таблицы ------------------------------------------------------------
alter table public.kb_reads add column if not exists read_published_at timestamptz;
alter table public.kb_reads add column if not exists seconds integer not null default 0;
alter table public.kb_reads add column if not exists max_scroll smallint not null default 0;
alter table public.kb_reads add column if not exists completed_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kb_reads_max_scroll_check') then
    alter table public.kb_reads
      add constraint kb_reads_max_scroll_check check (max_scroll between 0 and 100);
  end if;
end;
$$;
create index if not exists kb_reads_user_idx on public.kb_reads (user_id, last_read_at desc);

create table if not exists public.kb_read_days (
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  day date not null,
  views integer not null default 0,
  seconds integer not null default 0,
  primary key (node_id, user_id, day)
);
create index if not exists kb_read_days_base_day_idx on public.kb_read_days (base_id, day);
create index if not exists kb_read_days_user_idx on public.kb_read_days (user_id, day);

create table if not exists public.kb_search_log (
  id bigserial primary key,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  query text not null check (char_length(query) between 1 and 200),
  in_folder boolean not null default false,
  results integer not null default 0,
  clicked_node_id uuid references public.kb_nodes(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists kb_search_log_base_idx on public.kb_search_log (base_id, created_at);

revoke all on public.kb_read_days, public.kb_search_log from anon, authenticated;
grant select on public.kb_read_days, public.kb_search_log to authenticated;
grant all on public.kb_read_days, public.kb_search_log to service_role;
grant usage, select on sequence public.kb_search_log_id_seq to service_role;

alter table public.kb_read_days enable row level security;
alter table public.kb_search_log enable row level security;

drop policy if exists "kb_read_days read" on public.kb_read_days;
create policy "kb_read_days read" on public.kb_read_days
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
  );

drop policy if exists "kb_search_log read" on public.kb_search_log;
create policy "kb_search_log read" on public.kb_search_log
  for select to authenticated
  using (base_id = any ((select public.auth_kb_edit_base_ids())::uuid[]));

-- 2) Хелперы ------------------------------------------------------------------------
-- Сегодня по Тбилиси: дни графиков — местные.
create or replace function public.kb_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Tbilisi')::date
$$;

-- Читатели базы для аналитики: кому она выдана в «Доступах», без владельцев.
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
     and public.is_staff(g.subject_id)
     and not exists (
       select 1 from public.user_roles r where r.user_id = g.subject_id and r.role = 'owner'
     )
   group by g.subject_id
$$;

-- Пары «опубликованная статья × кто должен её прочитать» (аудитория статьи).
create or replace function public.kb_base_pairs(p_base uuid)
returns table (node_id uuid, user_id uuid, published_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, a.user_id, n.published_at
    from public.kb_nodes n
    cross join lateral public.kb_article_audience(n.id) a
   where n.base_id = p_base and n.kind = 'article'
     and n.status = 'published' and n.reader_visible
$$;

revoke all on function public.kb_today(), public.kb_base_people(uuid), public.kb_base_pairs(uuid)
  from public, anon, authenticated;
grant execute on function public.kb_today() to authenticated, service_role;

-- Состояние чтения пары: прочитал актуальную / читал прежнюю / не открывал.
create or replace function public.kb_read_state(r public.kb_reads, p_published timestamptz)
returns text
language sql
immutable
as $$
  select case
    when r.node_id is null then 'unread'
    when p_published is null or r.read_published_at >= p_published then 'current'
    else 'outdated'
  end
$$;

-- 3) Запись -------------------------------------------------------------------------
-- Открыл статью: открытие считается не чаще раза в 30 минут (и в днях);
-- запоминается версия. Новая версия — прокрутка и «дочитал» заново.
create or replace function public.kb_mark_read(p_node uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  lvl text;
  prev public.kb_reads;
  counted boolean;
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
  select * into prev from public.kb_reads where node_id = p_node and user_id = auth.uid();
  counted := prev.node_id is null or prev.last_read_at < now() - interval '30 minutes';

  insert into public.kb_reads as r (node_id, user_id, base_id, read_published_at)
  values (p_node, auth.uid(), n.base_id, n.published_at)
  on conflict (node_id, user_id) do update
     set read_count = r.read_count + case when counted then 1 else 0 end,
         last_read_at = now(),
         max_scroll = case when r.read_published_at is distinct from excluded.read_published_at
                           then 0 else r.max_scroll end,
         completed_at = case when r.read_published_at is distinct from excluded.read_published_at
                             then null else r.completed_at end,
         read_published_at = excluded.read_published_at;

  insert into public.kb_read_days as d (node_id, user_id, base_id, day, views)
  values (p_node, auth.uid(), n.base_id, public.kb_today(), case when counted then 1 else 0 end)
  on conflict (node_id, user_id, day) do update
     set views = d.views + case when counted then 1 else 0 end;
end;
$$;

-- Читает: секунды активного чтения (не больше 60 за вызов) и докуда
-- прокрутил (0–100). Браузер шлёт раз в ~30 секунд и при уходе со статьи.
create or replace function public.kb_track_reading(p_node uuid, p_seconds integer, p_scroll integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  lvl text;
  s integer := least(greatest(coalesce(p_seconds, 0), 0), 60);
  sc integer := least(greatest(coalesce(p_scroll, 0), 0), 100);
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
  if not exists (select 1 from public.kb_reads where node_id = p_node and user_id = auth.uid()) then
    perform public.kb_mark_read(p_node);
  end if;
  update public.kb_reads
     set seconds = seconds + s,
         max_scroll = greatest(max_scroll, sc),
         completed_at = coalesce(completed_at, case when greatest(max_scroll, sc) >= 90 then now() end),
         last_read_at = case when s > 0 then now() else last_read_at end
   where node_id = p_node and user_id = auth.uid();
  if s > 0 then
    insert into public.kb_read_days as d (node_id, user_id, base_id, day, seconds)
    values (p_node, auth.uid(), n.base_id, public.kb_today(), s)
    on conflict (node_id, user_id, day) do update set seconds = d.seconds + excluded.seconds;
  end if;
end;
$$;

-- Поиск: строка журнала; набор по буквам — та же строка (см. шапку).
create or replace function public.kb_log_search(
  p_base uuid, p_query text, p_results integer, p_in_folder boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  q text := left(regexp_replace(lower(btrim(coalesce(p_query, ''))), '\s+', ' ', 'g'), 200);
  last public.kb_search_log;
  new_id bigint;
begin
  if auth.uid() is null or char_length(q) < 2
     or public.kb_base_level(auth.uid(), p_base) is null then
    return null;
  end if;
  select * into last from public.kb_search_log
   where base_id = p_base and user_id = auth.uid()
   order by id desc limit 1;
  if last.id is not null and last.created_at > now() - interval '2 minutes'
     and last.clicked_node_id is null
     and (starts_with(q, last.query) or starts_with(last.query, q)) then
    update public.kb_search_log
       set query = q, results = greatest(coalesce(p_results, 0), 0),
           in_folder = coalesce(p_in_folder, false), created_at = now()
     where id = last.id;
    return last.id;
  end if;
  insert into public.kb_search_log (base_id, user_id, query, in_folder, results)
  values (p_base, auth.uid(), q, coalesce(p_in_folder, false), greatest(coalesce(p_results, 0), 0))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.kb_log_search_click(p_id bigint, p_node uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.kb_search_log
     set clicked_node_id = p_node
   where id = p_id and user_id = auth.uid()
     and exists (select 1 from public.kb_nodes n where n.id = p_node and n.base_id = kb_search_log.base_id)
$$;

-- 4) Аналитика (редакторам базы и владельцам) -------------------------------------
create or replace function public.kb_analytics_guard(p_base uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(public.kb_base_level(auth.uid(), p_base), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
end;
$$;
revoke all on function public.kb_analytics_guard(uuid) from public, anon, authenticated;

-- Обзор базы за последние p_days дней (и столько же до них — для сравнения).
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
  st as materialized (
    select pr.node_id, pr.user_id, public.kb_read_state(r, pr.published_at) as state,
           coalesce(r.max_scroll, 0) >= 90 and public.kb_read_state(r, pr.published_at) = 'current' as done
      from kb_an_pairs pr
      left join public.kb_reads r on r.node_id = pr.node_id and r.user_id = pr.user_id
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
    'pairs', (select count(*) from st),
    'read_current', (select count(*) from st where state = 'current'),
    'read_outdated', (select count(*) from st where state = 'outdated'),
    'completed', (select count(*) from st where done),
    'never_read', (
      select count(*) from articles a
       where exists (select 1 from kb_an_pairs p where p.node_id = a.id)
         and not exists (
           select 1 from public.kb_reads r join kb_an_pairs p on p.node_id = r.node_id and p.user_id = r.user_id
            where r.node_id = a.id)
    ),
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
        select a.id, a.title, a.published_at,
               count(*)::integer as audience,
               count(*) filter (where st.state = 'current')::integer as read_current,
               count(*) filter (where st.state = 'outdated')::integer as read_outdated,
               (count(*) filter (where st.state = 'current'))::numeric / count(*) as share
          from st join articles a on a.id = st.node_id
         group by a.id, a.title, a.published_at
        having count(*) filter (where st.state = 'current') < count(*)
         order by (count(*) filter (where st.state = 'current'))::numeric / count(*), a.published_at desc
         limit 8
      ) t
    ),
    'sections', (
      select coalesce(jsonb_agg(t order by t.sort_order nulls last, t.title), '[]') from (
        select f.id, f.title, f.icon, f.sort_order,
               count(distinct a.id)::integer as articles,
               count(st.node_id)::integer as pairs,
               count(st.node_id) filter (where st.state = 'current')::integer as read_current,
               count(st.node_id) filter (where st.state = 'outdated')::integer as read_outdated
          from public.kb_nodes f
          join articles a on a.path[1] = f.id
          left join st on st.node_id = a.id
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

-- Сотрудники базы: сколько им положено прочитать и сколько прочитали,
-- время, последнее чтение, последний вход в админку.
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
declare
  d_from date := public.kb_today() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
begin
  perform public.kb_analytics_guard(p_base);
  return query
  with people as (select * from public.kb_base_people(p_base)),
  pairs as (select * from public.kb_base_pairs(p_base)),
  st as (
    select pr.user_id, public.kb_read_state(r, pr.published_at) as state,
           coalesce(r.max_scroll, 0) >= 90 as scrolled
      from pairs pr
      left join public.kb_reads r on r.node_id = pr.node_id and r.user_id = pr.user_id
  )
  select pe.user_id, p.full_name, p.avatar_url, pe.level,
         (select count(*) from st where st.user_id = pe.user_id)::integer,
         (select count(*) from st where st.user_id = pe.user_id and st.state = 'current')::integer,
         (select count(*) from st where st.user_id = pe.user_id and st.state = 'outdated')::integer,
         (select count(*) from st where st.user_id = pe.user_id and st.state = 'current' and st.scrolled)::integer,
         (select coalesce(sum(r.seconds), 0) from public.kb_reads r
           where r.base_id = p_base and r.user_id = pe.user_id)::integer,
         (select coalesce(sum(d.seconds), 0) from public.kb_read_days d
           where d.base_id = p_base and d.user_id = pe.user_id and d.day >= d_from)::integer,
         (select coalesce(sum(d.views), 0) from public.kb_read_days d
           where d.base_id = p_base and d.user_id = pe.user_id and d.day >= d_from)::integer,
         (select count(distinct d.day) from public.kb_read_days d
           where d.base_id = p_base and d.user_id = pe.user_id and d.day >= d_from)::integer,
         (select min(r.first_read_at) from public.kb_reads r
           where r.base_id = p_base and r.user_id = pe.user_id),
         lr.last_read_at, lr.node_id, lr.title,
         u.last_sign_in_at
    from people pe
    left join public.profiles p on p.id = pe.user_id
    left join auth.users u on u.id = pe.user_id
    left join lateral (
      select r.last_read_at, r.node_id, n.title
        from public.kb_reads r join public.kb_nodes n on n.id = r.node_id
       where r.base_id = p_base and r.user_id = pe.user_id
       order by r.last_read_at desc limit 1
    ) lr on true;
end;
$$;

-- Один сотрудник: что ему положено и что он читал (и вне положенного —
-- например, свои статьи), активность по дням за 30 дней.
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
    select pr.node_id, pr.published_at from public.kb_base_pairs(p_base) pr where pr.user_id = p_user
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

-- 5) Отчёт по статьям и «кто прочитал» — с новыми колонками ---------------------------
drop function if exists public.kb_report(uuid);
create function public.kb_report(p_base uuid)
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
begin
  perform public.kb_analytics_guard(p_base);
  return query
  select n.id, n.parent_id, n.title, n.status, n.created_at, pc.full_name,
         greatest(n.updated_at, d.updated_at),
         coalesce(case when d.updated_at > n.updated_at then pd.full_name end, pu.full_name),
         n.published_at, pp.full_name,
         d.node_id is not null,
         a.total, a.readers, a.outdated, a.completed, a.avg_seconds,
         (select coalesce(sum(x.views), 0) from public.kb_read_days x
           where x.node_id = n.id and x.day > public.kb_today() - 30
             and x.user_id in (select au.user_id from public.kb_article_audience(n.id) au))::integer,
         a.last_read
    from public.kb_nodes n
    left join public.kb_drafts d on d.node_id = n.id
    left join public.profiles pc on pc.id = n.created_by
    left join public.profiles pu on pu.id = n.updated_by
    left join public.profiles pd on pd.id = d.updated_by
    left join public.profiles pp on pp.id = n.published_by
    cross join lateral (
      select count(*)::integer as total,
             count(*) filter (where public.kb_read_state(r, n.published_at) = 'current')::integer as readers,
             count(*) filter (where public.kb_read_state(r, n.published_at) = 'outdated')::integer as outdated,
             count(*) filter (where public.kb_read_state(r, n.published_at) = 'current'
                                and r.max_scroll >= 90)::integer as completed,
             coalesce(avg(nullif(r.seconds, 0)), 0)::integer as avg_seconds,
             max(r.last_read_at) as last_read
        from public.kb_article_audience(n.id) au
        left join public.kb_reads r on r.node_id = n.id and r.user_id = au.user_id
    ) a
   where n.base_id = p_base and n.kind = 'article';
end;
$$;

drop function if exists public.kb_article_readers(uuid);
create function public.kb_article_readers(p_node uuid)
returns table (
  user_id uuid,
  full_name text,
  avatar_url text,
  state text,
  first_read_at timestamptz,
  last_read_at timestamptz,
  read_count integer,
  seconds integer,
  max_scroll integer,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
begin
  select * into n from public.kb_nodes where id = p_node;
  if n.id is null then
    raise exception 'kb_forbidden';
  end if;
  perform public.kb_analytics_guard(n.base_id);
  return query
  select a.user_id, p.full_name, p.avatar_url, public.kb_read_state(r, n.published_at),
         r.first_read_at, r.last_read_at, coalesce(r.read_count, 0),
         coalesce(r.seconds, 0), coalesce(r.max_scroll, 0)::integer, r.completed_at
    from public.kb_article_audience(p_node) a
    left join public.profiles p on p.id = a.user_id
    left join public.kb_reads r on r.node_id = p_node and r.user_id = a.user_id
   order by r.last_read_at desc nulls last, p.full_name;
end;
$$;

revoke all on function public.kb_track_reading(uuid, integer, integer),
  public.kb_log_search(uuid, text, integer, boolean), public.kb_log_search_click(bigint, uuid),
  public.kb_analytics_overview(uuid, integer), public.kb_analytics_people(uuid, integer),
  public.kb_analytics_person(uuid, uuid), public.kb_report(uuid), public.kb_article_readers(uuid)
  from public, anon;
grant execute on function public.kb_track_reading(uuid, integer, integer),
  public.kb_log_search(uuid, text, integer, boolean), public.kb_log_search_click(bigint, uuid),
  public.kb_analytics_overview(uuid, integer), public.kb_analytics_people(uuid, integer),
  public.kb_analytics_person(uuid, uuid), public.kb_report(uuid), public.kb_article_readers(uuid)
  to authenticated, service_role;
