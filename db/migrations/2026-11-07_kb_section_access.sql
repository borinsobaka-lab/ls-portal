-- ============================================================================
-- База знаний: кто видит раздел, папку, статью (решение владельца 2026-11-07,
-- «как в Platrum»). До этого доступ выдавался только на базу целиком — после
-- переноса из Platrum (одна база, разделы с разными доступами) администратор
-- клуба видел все разделы базы.
--
-- Как в Platrum:
--   * у папки или статьи может быть свой список «кто видит»
--     (kb_nodes.access_custom + строки kb_node_access): сотрудник, должность,
--     подразделение (все или руководители и заместители, с подразделениями
--     ниже или без), роль портала;
--   * без своей настройки действует настройка ближайшего раздела выше
--     (kb_nodes.access_node_id — узел, чья настройка действует; ставит
--     триггер), а без неё — доступ к базе из ролей (kb_grants, как раньше);
--   * своя настройка заменяет настройку выше, а не дополняет: её список
--     может быть и уже, и шире (статья, открытая должности, которой закрыт
--     раздел, — видна ей; раздел выше она не видит, интерфейс показывает
--     такую статью на верхнем уровне базы);
--   * пустой свой список — видят только редакторы базы и администраторы баз.
-- Редакторы базы («Правка» базы в роли) и администраторы баз знаний видят и
-- правят всё, как раньше; задают доступ разделам тоже они
-- (kb_node_access_save). Правка по разделам — следующим шагом.
--
-- Человек, которому открыт только раздел (без доступа к базе), видит базу во
-- вкладках (auth_kb_view_base_ids, kb_base_level = 'view') и только свои
-- разделы. Читатель по-прежнему видит лишь опубликованное (reader_visible).
--
-- Что поменялось вокруг:
--   * политика «kb_nodes read» и чтение файлов «kb-media read» — по узлу;
--   * kb_mark_read, kb_track_reading, kb_rate, acad_course_sources — уровень
--     узла (kb_node_level), а не базы;
--   * аудитория отчётов чтения (kb_base_people, kb_audience_pairs,
--     kb_article_audience) и «есть доступ» в упоминаниях
--     (kb_mention_candidates) — кто видит статью с учётом разделов;
--   * корзина возвращает настройку доступа (триггеры на kb_trash), копия
--     статьи — копирует её (kb_copy_node).
-- Актуальные определения перечисленных функций и политик — здесь.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Схема --------------------------------------------------------------------
alter table public.kb_nodes add column if not exists access_custom boolean not null default false;
alter table public.kb_nodes add column if not exists access_node_id uuid;
create index if not exists kb_nodes_access_node_idx on public.kb_nodes (access_node_id)
  where access_node_id is not null;

create table if not exists public.kb_node_access (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.kb_nodes(id) on delete cascade,
  base_id uuid not null references public.kb_bases(id) on delete cascade,
  subject_type text not null check (subject_type in ('user', 'position', 'unit', 'role')),
  subject_id uuid not null,
  -- Подразделение: все сотрудники или руководители и заместители; с
  -- подразделениями ниже по дереву (как у назначений ролей).
  unit_members text not null default 'all' check (unit_members in ('all', 'heads')),
  with_subunits boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists kb_node_access_subject_uidx
  on public.kb_node_access (node_id, subject_type, subject_id);
create index if not exists kb_node_access_base_idx on public.kb_node_access (base_id);
create index if not exists kb_node_access_subject_idx on public.kb_node_access (subject_type, subject_id);

-- Таблица закрыта браузеру: читает и пишет только RPC (kb_node_access_get /
-- kb_node_access_save) — список «кто видит» нужен только редакторам.
alter table public.kb_node_access enable row level security;
revoke all on public.kb_node_access from public, anon, authenticated;
grant all on public.kb_node_access to service_role;

-- 2) Чья настройка действует: свой узел или ближайший выше ------------------------
-- Имя с «z»: срабатывает после kb_nodes_biu (он ставит родителя и путь).
create or replace function public.kb_nodes_zaccess_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_custom then
    new.access_node_id := new.id;
  elsif new.parent_id is null then
    new.access_node_id := null;
  else
    select p.access_node_id into new.access_node_id from public.kb_nodes p where p.id = new.parent_id;
  end if;
  return new;
end;
$$;

drop trigger if exists kb_nodes_zaccess_biu on public.kb_nodes;
create trigger kb_nodes_zaccess_biu
  before insert or update on public.kb_nodes
  for each row execute function public.kb_nodes_zaccess_biu();

-- Сменилась действующая настройка — пересчитать вложенное. Если сменился и
-- путь, вложенное пересчитает kb_nodes_au.
create or replace function public.kb_nodes_zaccess_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_node_id is distinct from old.access_node_id
     and new.path is not distinct from old.path
     and new.reader_visible is not distinct from old.reader_visible then
    update public.kb_nodes set path = path where parent_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists kb_nodes_zaccess_au on public.kb_nodes;
create trigger kb_nodes_zaccess_au
  after update on public.kb_nodes
  for each row execute function public.kb_nodes_zaccess_au();

revoke all on function public.kb_nodes_zaccess_biu(), public.kb_nodes_zaccess_au()
  from public, anon, authenticated;

-- 3) Кому открыто ------------------------------------------------------------------
-- Узлы со своей настройкой, в списке которых есть человек (по себе, своей
-- должности, подразделению, роли). Не человек портала — ничего.
create or replace function public.kb_user_access_node_ids(_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _user_id is null or not public.is_portal_user(_user_id) then '{}'::uuid[]
    else coalesce((
      select array_agg(distinct a.node_id)
        from public.kb_node_access a
       where (a.subject_type = 'user' and a.subject_id = _user_id)
          or (a.subject_type = 'position' and a.subject_id = (
                select pu.position_id from public.portal_users pu where pu.user_id = _user_id))
          or (a.subject_type = 'role' and a.subject_id in (
                select x.role_id from public.access_applicable(_user_id) x))
          or (a.subject_type = 'unit' and exists (
                select 1
                  from public.org_unit_members m
                  join public.org_units u on u.id = m.unit_id
                 where m.user_id = _user_id
                   and (a.unit_members = 'all' or m.member_role in ('head', 'deputy'))
                   and (u.id = a.subject_id or (a.with_subunits and a.subject_id = any (u.path)))))
    ), '{}')
  end
$$;

-- Для политик: один раз на запрос.
create or replace function public.auth_kb_access_node_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select public.kb_user_access_node_ids(auth.uid())
$$;

-- Базы, выданные целиком (роль «База знаний»), — прежнее auth_kb_view_base_ids.
create or replace function public.auth_kb_grant_base_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.kb_is_admin(auth.uid()) then coalesce((select array_agg(id) from public.kb_bases), '{}')
    when not public.is_portal_user(auth.uid()) then '{}'::uuid[]
    else coalesce((
      select array_agg(distinct base_id) from public.kb_grants
       where node_id is null and subject_type = 'user' and subject_id = auth.uid()
    ), '{}')
  end
$$;

-- Базы, которые человек видит: выданные целиком и те, где ему открыт раздел.
create or replace function public.auth_kb_view_base_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array(
    select unnest(public.auth_kb_grant_base_ids())
    union
    select a.base_id from public.kb_node_access a
     where a.node_id = any (public.auth_kb_access_node_ids())
  ), '{}')
$$;

-- Уровень в базе: manage / edit / view (выдана целиком или открыт раздел) / null.
create or replace function public.kb_base_level(_user_id uuid, _base_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lvl text;
begin
  if public.kb_is_admin(_user_id) then
    return 'manage';
  end if;
  if not public.is_portal_user(_user_id) then
    return null;
  end if;
  select case when bool_or(level = 'edit') then 'edit' when count(*) > 0 then 'view' end
    into lvl
    from public.kb_grants
   where base_id = _base_id and node_id is null
     and subject_type = 'user' and subject_id = _user_id;
  if lvl is not null then
    return lvl;
  end if;
  if exists (
    select 1 from public.kb_node_access a
     where a.base_id = _base_id
       and a.node_id = any (public.kb_user_access_node_ids(_user_id))
  ) then
    return 'view';
  end if;
  return null;
end;
$$;

-- Уровень на узле: manage / edit / view / null. Опубликован ли узел, смотрит
-- вызывающий (как раньше с kb_base_level).
create or replace function public.kb_node_level(_user_id uuid, _node_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  lvl text;
begin
  if public.kb_is_admin(_user_id) then
    return 'manage';
  end if;
  if not public.is_portal_user(_user_id) then
    return null;
  end if;
  select * into n from public.kb_nodes where id = _node_id;
  if not found then
    return null;
  end if;
  select case when bool_or(level = 'edit') then 'edit' when count(*) > 0 then 'view' end
    into lvl
    from public.kb_grants
   where base_id = n.base_id and node_id is null
     and subject_type = 'user' and subject_id = _user_id;
  if lvl = 'edit' or n.access_node_id is null then
    return lvl;
  end if;
  if n.access_node_id = any (public.kb_user_access_node_ids(_user_id)) then
    return 'view';
  end if;
  return null;
end;
$$;

-- Кому открыты узлы со своей настройкой в базе (узел × человек) — для
-- отчётов. Наружу не выдана.
create or replace function public.kb_node_access_users(p_base uuid)
returns table (access_node_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with rules as (
    select a.*
      from public.kb_node_access a
      join public.kb_nodes n on n.id = a.node_id and n.access_custom
     where a.base_id = p_base
  ),
  pairs as (
    select r.node_id, r.subject_id as uid from rules r where r.subject_type = 'user'
    union
    select r.node_id, pu.user_id
      from rules r join public.portal_users pu on pu.position_id = r.subject_id
     where r.subject_type = 'position'
    union
    select r.node_id, x.uid
      from rules r
      cross join lateral public.access_assignment_user_ids(
        'unit', null, r.subject_id, null, r.unit_members, r.with_subunits) x(uid)
     where r.subject_type = 'unit'
    union
    select r.node_id, x.uid
      from rules r
      join public.access_assignments asg on asg.role_id = r.subject_id
      cross join lateral public.access_assignment_user_ids(
        asg.subject_type, asg.user_id, asg.unit_id, asg.position_id,
        asg.unit_members, asg.with_subunits) x(uid)
     where r.subject_type = 'role'
       and (asg.valid_from is null or asg.valid_from <= now())
       and (asg.valid_until is null or asg.valid_until > now())
  )
  select p.node_id, p.uid from pairs p where public.is_portal_user(p.uid)
$$;

revoke all on function public.kb_user_access_node_ids(uuid), public.kb_node_access_users(uuid)
  from public, anon, authenticated;
grant execute on function public.kb_user_access_node_ids(uuid) to service_role;
revoke all on function public.auth_kb_access_node_ids(), public.auth_kb_grant_base_ids(),
  public.auth_kb_view_base_ids(), public.kb_base_level(uuid, uuid), public.kb_node_level(uuid, uuid)
  from public, anon;
grant execute on function public.auth_kb_access_node_ids(), public.auth_kb_grant_base_ids(),
  public.auth_kb_view_base_ids(), public.kb_base_level(uuid, uuid), public.kb_node_level(uuid, uuid)
  to authenticated, service_role;

-- 4) Политики -------------------------------------------------------------------
-- Редактор базы — всё; читатель — опубликованное: без своей настройки выше —
-- по доступу к базе, с ней — по её списку.
drop policy if exists "kb_nodes read" on public.kb_nodes;
create policy "kb_nodes read" on public.kb_nodes
  for select to authenticated
  using (
    base_id = any ((select public.auth_kb_edit_base_ids())::uuid[])
    or (
      reader_visible
      and (
        (access_node_id is null and base_id = any ((select public.auth_kb_grant_base_ids())::uuid[]))
        or access_node_id = any ((select public.auth_kb_access_node_ids())::uuid[])
      )
    )
  );

-- Файлы статьи ({база}/{статья}/{файл}): редактору базы — все, остальным —
-- файлы статей, которые им видны.
drop policy if exists "kb-media read" on storage.objects;
create policy "kb-media read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-media'
    and (
      (storage.foldername(name))[1] = any ((select public.auth_kb_edit_base_ids())::text[])
      or exists (
        select 1 from public.kb_nodes n
         where n.id::text = (storage.foldername(name))[2]
           and n.base_id::text = (storage.foldername(name))[1]
      )
    )
  );

-- 5) Настройка доступа (редакторам базы и администраторам баз) ------------------
-- Что задано у узла: своя настройка или чья действует, список, сколько людей
-- сейчас видят (без редакторов и администраторов — они видят всё).
create or replace function public.kb_node_access_get(p_node uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  src public.kb_nodes;
  viewers integer;
begin
  select * into n from public.kb_nodes where id = p_node;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), n.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  if n.access_node_id is not null then
    select * into src from public.kb_nodes where id = n.access_node_id;
  end if;
  if n.access_node_id is null then
    select count(*) into viewers from public.kb_grants g
     where g.base_id = n.base_id and g.node_id is null and g.subject_type = 'user'
       and public.is_portal_user(g.subject_id) and not public.kb_is_admin(g.subject_id);
  else
    select count(*) into viewers from (
      select x.user_id from public.kb_node_access_users(n.base_id) x
       where x.access_node_id = n.access_node_id
      union
      select g.subject_id from public.kb_grants g
       where g.base_id = n.base_id and g.node_id is null and g.subject_type = 'user'
         and g.level = 'edit' and public.is_portal_user(g.subject_id)
    ) v
     where not public.kb_is_admin(v.user_id);
  end if;
  return jsonb_build_object(
    'custom', n.access_custom,
    'source_id', n.access_node_id,
    'source_title', src.title,
    'viewers', viewers,
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'subject_type', a.subject_type, 'subject_id', a.subject_id,
               'unit_members', a.unit_members, 'with_subunits', a.with_subunits)
             order by a.created_at)
        from public.kb_node_access a
       where a.node_id = coalesce(n.access_node_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ), '[]'::jsonb)
  );
end;
$$;

-- Задать: p_custom = false — как выше (список удаляется); true — свой
-- список p_rules: [{subject_type, subject_id, unit_members?, with_subunits?}].
create or replace function public.kb_node_access_save(p_node uuid, p_custom boolean, p_rules jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.kb_nodes;
  r record;
  ok boolean;
begin
  select * into n from public.kb_nodes where id = p_node;
  if not found then
    raise exception 'kb_not_found';
  end if;
  if coalesce(public.kb_base_level(auth.uid(), n.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  -- Не список — ошибка, а не «пустой список» (он закрыл бы раздел всем).
  if coalesce(p_custom, false) and jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'kb_access_bad_rules';
  end if;
  if coalesce(p_custom, false) and jsonb_array_length(p_rules) > 200 then
    raise exception 'kb_access_too_many';
  end if;

  delete from public.kb_node_access where node_id = p_node;
  if coalesce(p_custom, false) then
    for r in
      select x.subject_type, x.subject_id,
             coalesce(x.unit_members, 'all') as unit_members,
             coalesce(x.with_subunits, true) as with_subunits
        from jsonb_to_recordset(p_rules)
             as x(subject_type text, subject_id uuid, unit_members text, with_subunits boolean)
    loop
      -- CASE отдельно: plpgsql читает условие IF до первого THEN.
      ok := r.subject_id is not null and case r.subject_type
        when 'user' then public.is_portal_user(r.subject_id)
        when 'position' then exists (select 1 from public.org_positions where id = r.subject_id)
        when 'unit' then exists (select 1 from public.org_units where id = r.subject_id)
        when 'role' then exists (select 1 from public.access_roles
                                  where id = r.subject_id and personal_user_id is null)
        else false
      end;
      if not coalesce(ok, false) then
        raise exception 'kb_access_bad_subject';
      end if;
      insert into public.kb_node_access
        (node_id, base_id, subject_type, subject_id, unit_members, with_subunits, created_by)
      values (p_node, n.base_id, r.subject_type, r.subject_id,
              case when r.subject_type = 'unit' then r.unit_members else 'all' end,
              case when r.subject_type = 'unit' then r.with_subunits else true end,
              auth.uid())
      on conflict (node_id, subject_type, subject_id) do update
        set unit_members = excluded.unit_members, with_subunits = excluded.with_subunits;
    end loop;
  end if;

  if n.access_custom is distinct from coalesce(p_custom, false) then
    update public.kb_nodes set access_custom = coalesce(p_custom, false) where id = p_node;
  end if;
end;
$$;

revoke all on function public.kb_node_access_get(uuid), public.kb_node_access_save(uuid, boolean, jsonb)
  from public, anon;
grant execute on function public.kb_node_access_get(uuid), public.kb_node_access_save(uuid, boolean, jsonb)
  to authenticated, service_role;

-- 6) Чтение, оценка, источник урока — по уровню на узле -----------------------------
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
  lvl := public.kb_node_level(auth.uid(), n.id);
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
  lvl := public.kb_node_level(auth.uid(), n.id);
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
  lvl := public.kb_node_level(auth.uid(), n.id);
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

-- «Урок из статьи»: статья доступна, если открыта самому создателю курса.
create or replace function public.acad_course_sources(p_course uuid)
returns table (step_id uuid, node_id uuid, base_id uuid, node_title text, published_at timestamptz,
               available boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.acad_is_team(auth.uid()) then
    raise exception 'acad_forbidden';
  end if;
  return query
  select s.id, n.id, n.base_id, n.title, n.published_at,
         n.status = 'published'
           and coalesce(public.kb_node_level(auth.uid(), n.id) in ('edit', 'manage')
                        or (public.kb_node_level(auth.uid(), n.id) = 'view' and n.reader_visible), false)
    from public.acad_steps s
    join public.kb_nodes n on n.id = s.source_node_id
   where s.course_id = p_course;
end;
$$;

-- 7) Аудитория отчётов чтения и упоминаний ------------------------------------------
-- Люди базы: выдана целиком (уровень роли) или открыт хоть один раздел
-- («view»). Без администраторов баз.
create or replace function public.kb_base_people(p_base uuid)
returns table (user_id uuid, level text)
language sql
stable
security definer
set search_path = public
as $$
  with granted as (
    select g.subject_id as uid, case when bool_or(g.level = 'edit') then 'edit' else 'view' end as lvl
      from public.kb_grants g
     where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
       and public.is_portal_user(g.subject_id)
     group by g.subject_id
  ),
  sections as (
    select distinct x.user_id as uid from public.kb_node_access_users(p_base) x
  )
  select g.uid, g.lvl from granted g where not public.kb_is_admin(g.uid)
  union all
  select s.uid, 'view' from sections s
   where not exists (select 1 from granted g where g.uid = s.uid)
     and not public.kb_is_admin(s.uid)
$$;

-- Статья × кто её видит (без авторов статьи): без своей настройки выше —
-- кому выдана база, с ней — её список и редакторы базы.
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
    select bp.user_id, bp.level from public.kb_base_people(p_base) bp
     where p_user is null or bp.user_id = p_user
  ),
  granted as (
    select p.user_id, p.level from people p
     where exists (select 1 from public.kb_grants g
                    where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
                      and g.subject_id = p.user_id)
  ),
  section_people as (
    select x.access_node_id, x.user_id from public.kb_node_access_users(p_base) x
     where x.user_id in (select p.user_id from people p)
  ),
  arts as (
    select n.id, n.published_at, n.created_by, n.updated_by, n.published_by, n.author_id,
           n.access_node_id
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
  ),
  pairs as (
    select a.id, g.user_id, a.published_at
      from arts a
      join granted g on a.access_node_id is null or g.level = 'edit'
    union
    select a.id, s.user_id, a.published_at
      from arts a
      join section_people s on s.access_node_id = a.access_node_id
  )
  select p.id, p.user_id, p.published_at
    from pairs p
   where not exists (
     select 1 from authors au where au.node_id = p.id and au.user_id = p.user_id
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
  with n as (select * from public.kb_nodes where id = p_node),
  viewers as (
    select g.subject_id as uid
      from n
      join public.kb_grants g
        on g.base_id = n.base_id and g.node_id is null and g.subject_type = 'user'
     where (n.access_node_id is null or g.level = 'edit')
       and public.is_portal_user(g.subject_id)
    union
    select x.user_id
      from n
      cross join lateral public.kb_node_access_users(n.base_id) x
     where x.access_node_id = n.access_node_id
  )
  select v.uid
    from viewers v, n
   where not public.kb_is_admin(v.uid)
     and v.uid is distinct from n.created_by
     and v.uid is distinct from n.updated_by
     and v.uid is distinct from n.published_by
     and v.uid is distinct from n.author_id
     and not exists (select 1 from public.kb_drafts d where d.node_id = n.id and d.updated_by = v.uid)
     and not exists (select 1 from public.kb_revisions r where r.node_id = n.id and r.published_by = v.uid)
$$;
revoke all on function public.kb_article_audience(uuid) from public, anon, authenticated;

-- Упоминания: «есть доступ» — администраторы баз и люди базы (и по разделам).
create or replace function public.kb_mention_candidates(p_base uuid)
returns table (user_id uuid, full_name text, avatar_url text, position_name text, has_access boolean)
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
  with access as (
    select a as id from public.kb_admin_user_ids() a
    union
    select bp.user_id from public.kb_base_people(p_base) bp
  )
  select u.id,
         coalesce(nullif(btrim(p.full_name), ''), u.email::text),
         p.avatar_url,
         pos.name,
         exists (select 1 from access a where a.id = u.id)
    from auth.users u
    join (select public.portal_people_ids() as id) pp on pp.id = u.id
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
   order by 5 desc, 2;
end;
$$;

-- 8) Корзина и копия -------------------------------------------------------------
-- В корзину — и список доступа поддерева (флаг access_custom уже в снимке узла).
create or replace function public.kb_trash_access_bi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('access', coalesce((
    select jsonb_agg(jsonb_build_object(
             'node_id', a.node_id, 'subject_type', a.subject_type, 'subject_id', a.subject_id,
             'unit_members', a.unit_members, 'with_subunits', a.with_subunits,
             'created_by', a.created_by, 'created_at', a.created_at))
      from public.kb_node_access a
     where a.node_id in (
       select (e ->> 'id')::uuid from jsonb_array_elements(coalesce(new.payload -> 'nodes', '[]')) e
     )
  ), '[]'::jsonb));
  return new;
end;
$$;

drop trigger if exists kb_trash_access_bi on public.kb_trash;
create trigger kb_trash_access_bi
  before insert on public.kb_trash
  for each row execute function public.kb_trash_access_bi();

-- Строка корзины ушла: если узлы вернулись («Вернуть») — их настройка тоже.
create or replace function public.kb_trash_access_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kb_node_access
    (node_id, base_id, subject_type, subject_id, unit_members, with_subunits, created_by, created_at)
  select x.node_id, old.base_id, x.subject_type, x.subject_id,
         coalesce(x.unit_members, 'all'), coalesce(x.with_subunits, true),
         public.kb_existing_user(x.created_by), coalesce(x.created_at, now())
    from jsonb_to_recordset(coalesce(old.payload -> 'access', '[]'))
         as x(node_id uuid, subject_type text, subject_id uuid, unit_members text,
              with_subunits boolean, created_by uuid, created_at timestamptz)
   where exists (select 1 from public.kb_nodes n where n.id = x.node_id)
  on conflict do nothing;

  -- Сверху вниз: вложенное берёт настройку у родителя.
  update public.kb_nodes n
     set access_custom = true
    from (
      select (e ->> 'id')::uuid as id, ord
        from jsonb_array_elements(coalesce(old.payload -> 'nodes', '[]')) with ordinality as t(e, ord)
       where coalesce((e ->> 'access_custom')::boolean, false)
    ) c
   where n.id = c.id and not n.access_custom;
  return old;
end;
$$;

drop trigger if exists kb_trash_access_ad on public.kb_trash;
create trigger kb_trash_access_ad
  after delete on public.kb_trash
  for each row execute function public.kb_trash_access_ad();

revoke all on function public.kb_trash_access_bi(), public.kb_trash_access_ad()
  from public, anon, authenticated;

-- Копия статьи — с её настройками (оценка, переход, доступ), оценки не копируются.
-- Список доступа копирует kb_node_access_copy: kb_copy_node работает от имени
-- вызывающего, а таблица списков браузеру закрыта.
create or replace function public.kb_node_access_copy(p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.kb_nodes;
  b public.kb_nodes;
begin
  select * into a from public.kb_nodes where id = p_from;
  select * into b from public.kb_nodes where id = p_to;
  if a.id is null or b.id is null or a.base_id <> b.base_id
     or coalesce(public.kb_base_level(auth.uid(), a.base_id), 'view') = 'view' then
    raise exception 'kb_forbidden';
  end if;
  insert into public.kb_node_access
    (node_id, base_id, subject_type, subject_id, unit_members, with_subunits, created_by)
  select p_to, b.base_id, x.subject_type, x.subject_id, x.unit_members, x.with_subunits, auth.uid()
    from public.kb_node_access x where x.node_id = p_from
  on conflict do nothing;
  update public.kb_nodes set access_custom = a.access_custom
   where id = p_to and access_custom is distinct from a.access_custom;
end;
$$;
revoke all on function public.kb_node_access_copy(uuid, uuid) from public, anon;
grant execute on function public.kb_node_access_copy(uuid, uuid) to authenticated, service_role;

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
  if n.access_custom then
    perform public.kb_node_access_copy(p_node, new_id);
  end if;
  return new_id;
end;
$$;
