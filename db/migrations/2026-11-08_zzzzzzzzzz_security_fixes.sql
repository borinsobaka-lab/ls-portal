-- Исправления безопасности по код-ревью 2026-11-08 (решение владельца —
-- исправить сразу). Каждый пункт — актуальное определение здесь.
--
--  1. access_can_manage: «кого завёл» больше не даёт доступа к учётной записи
--     в обход прав; войти в чужую учётную запись (пароль, почта, аватарка)
--     можно, только если её права не шире ваших, а партнёру — только без
--     сотрудников и клиентов чужих клубов (раньше: создатель мог в любой
--     момент поставить пароль хоть суперадминистратору).
--  2. chat_member_set_role: не участник чата больше не меняет роли
--     (`NULL <> 'owner'` пропускал проверку).
--  3. Проекты задач: не участник больше не удаляет проект, не меняет роли и
--     не убирает людей (та же ошибка с NULL); задачу переносит в проект
--     только постановщик, «Администратор задач» или тот, кто ведёт прежний
--     проект задачи (иначе чужую задачу можно было перенести в свой проект и
--     удалить вместе с ним) — триггер tasks_project_move_guard_bu.
--  4. profiles: ФИО и почту меняют только сервер и функции базы, не браузер
--     (ФИО — ключ таргетолога в «Аналитике»: сменив своё, можно было
--     получить чужие города).
--  5. «Аналитика»: заблокированный или убранный из портала человек больше не
--     видит «Мой город» (1С и FitBase) по оставшимся строкам партнёра.
--  6. Чаты: заблокированный или убранный из портала человек больше не читает
--     свои чаты, файлы и «печатает…» (chat_role вызывающего,
--     chat_file_allowed, chat_topic_member).
--  7. Оргструктура: правка структуры (подразделения, состав, собственники,
--     бренды клубов), от которой у людей прибавились права, — только тому, кто
--     сам мог бы их выдать; себе через структуру прав не прибавить
--     (access_guard → access_structure_guard). Суперадминистратору — как раньше.
--  8. Обратная связь и NPS: сотрудник видит и правит только свои клубы
--     (было — все клубы сети); строки без клуба — суперадминистратору.
--  9. Сотрудники: реквизиты, ставки и выплаты — только «своего» сотрудника
--     (все его клубы — ваши, или у него ещё нет клубов); чужого сотрудника не
--     привязать к своему клубу и не изменить в справочнике.

-- 1) Управление учётной записью ---------------------------------------------------
create or replace function public.access_can_manage(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me public.access_user_rights;
  v_rights text[];
begin
  select * into me from public.access_user_rights where user_id = auth.uid() and portal;
  if not found or p_user is null then
    return false;
  end if;
  if not public.access_can_manage_user(me, p_user) then
    return false;
  end if;
  if 'portal.admin' = any (me.rights) then
    return true;
  end if;
  -- Вход в учётную запись даёт все её права — не больше своих.
  select r.rights into v_rights from public.access_user_rights r where r.user_id = p_user;
  if v_rights is not null and not (v_rights <@ me.rights) then
    return false;
  end if;
  -- Сотрудник или клиент чужого клуба — дело администратора всех пользователей.
  if not me.manage_all and (
       exists (select 1 from public.user_roles ur
                where ur.user_id = p_user and not (ur.studio_id = any (me.manage_studio_ids)))
       or exists (select 1 from public.clients c
                   where c.user_id = p_user and not (c.studio_id = any (me.manage_studio_ids)))
       or exists (select 1 from public.schedule_bookings b
                   where b.user_id = p_user and not (b.studio_id = any (me.manage_studio_ids)))) then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.access_can_manage(uuid) from public, anon;
grant execute on function public.access_can_manage(uuid) to authenticated, service_role;

-- 2) Роль в чате — только владелец группы ----------------------------------------
create or replace function public.chat_member_set_role(p_chat uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if public.chat_role(p_chat, v_uid) is distinct from 'owner'
     or (select kind from public.chat_chats where id = p_chat) is distinct from 'group' then
    raise exception 'chat_owner_only' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'member')
     or public.chat_role(p_chat, p_user) is null
     or public.chat_role(p_chat, p_user) = 'owner' then
    raise exception 'chat_role_invalid' using errcode = '22023';
  end if;
  update public.chat_members set role = p_role where chat_id = p_chat and user_id = p_user;
  perform public.chat_broadcast(p_chat, jsonb_build_object('type', 'members'));
end;
$$;

-- 3) Проекты задач ----------------------------------------------------------------
create or replace function public.task_project_delete(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_chat uuid;
  r record;
begin
  if not (coalesce(public.task_project_role(p_project, v_uid) = 'owner', false)
          or public.access_has_right(v_uid, 'tasks.admin')) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  select chat_id into v_chat from public.task_projects where id = p_project for update;
  for r in select id from public.tasks where project_id = p_project loop
    perform public.task_broadcast(r.id);
  end loop;
  delete from public.tasks where project_id = p_project;
  if v_chat is not null then
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'));
    delete from public.chat_chats where id = v_chat;
  end if;
  delete from public.task_projects where id = p_project;
end;
$$;

create or replace function public.task_project_member_set_role(p_project uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_me text := public.task_project_role(p_project, v_uid);
  v_target text := public.task_project_role(p_project, p_user);
  v_admin boolean := public.access_has_right(v_uid, 'tasks.admin');
begin
  if v_target is null or p_role is null or p_role not in ('owner', 'moderator', 'member') then
    raise exception 'project_bad_role' using errcode = '22023';
  end if;
  if not (v_admin or coalesce(v_me = 'owner', false)
          or coalesce(v_me = 'moderator' and v_target <> 'owner' and p_role <> 'owner', false)) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if v_target = 'owner' and p_role <> 'owner'
     and (select count(*) from public.task_project_members
           where project_id = p_project and role = 'owner') = 1 then
    raise exception 'project_last_owner' using errcode = '22023';
  end if;
  update public.task_project_members set role = p_role where project_id = p_project and user_id = p_user;
end;
$$;

create or replace function public.task_project_member_remove(p_project uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_me text := public.task_project_role(p_project, v_uid);
  m public.task_project_members;
begin
  select * into m from public.task_project_members where project_id = p_project and user_id = p_user;
  if not found then
    return;
  end if;
  if p_user is distinct from v_uid and not (public.access_has_right(v_uid, 'tasks.admin')
     or coalesce(v_me = 'owner', false)
     or coalesce(v_me = 'moderator' and m.role <> 'owner', false)) then
    raise exception 'project_forbidden' using errcode = '42501';
  end if;
  if m.source = 'unit' then
    raise exception 'project_unit_member' using errcode = '22023';
  end if;
  if m.role = 'owner' and (select count(*) from public.task_project_members
                            where project_id = p_project and role = 'owner') = 1 then
    raise exception 'project_last_owner' using errcode = '22023';
  end if;
  delete from public.task_project_members where project_id = p_project and user_id = p_user;
  perform public.task_project_chat_sync(p_project);
end;
$$;

-- Перенос задачи в проект: удаление проекта уносит его задачи, поэтому
-- чужую задачу в свой проект не перенести. Можно постановщику, «Администратору
-- задач» и тому, кто ведёт прежний проект задачи. Сервер (без auth.uid()) и
-- вынос из проекта — как раньше.
create or replace function public.tasks_project_move_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or new.project_id is null
     or new.project_id is not distinct from old.project_id then
    return new;
  end if;
  if public.access_has_right(v_uid, 'tasks.admin')
     or exists (select 1 from public.task_members m
                 where m.task_id = new.id and m.user_id = v_uid and m.role = 'creator')
     or (old.project_id is not null and public.task_project_manages(old.project_id, v_uid)) then
    return new;
  end if;
  raise exception 'task_project_move_forbidden' using errcode = '42501';
end;
$$;
revoke all on function public.tasks_project_move_guard() from public, anon, authenticated;
drop trigger if exists tasks_project_move_guard_bu on public.tasks;
create trigger tasks_project_move_guard_bu
  before update of project_id on public.tasks
  for each row execute function public.tasks_project_move_guard();

-- 4) ФИО и почта профиля — не из браузера ---------------------------------------
-- security invoker: current_user — роль запроса (authenticated / anon из
-- браузера; владелец функции внутри security definer; service_role у сервера).
create or replace function public.profiles_lock_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.full_name := old.full_name;
    new.email := old.email;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_lock_identity() from public, anon;
grant execute on function public.profiles_lock_identity() to authenticated, service_role;
drop trigger if exists profiles_lock_identity_bu on public.profiles;
create trigger profiles_lock_identity_bu
  before update on public.profiles
  for each row execute function public.profiles_lock_identity();

-- 5) «Аналитика» — только людям портала ------------------------------------------
create or replace function public.an_fb_mycity_ids(_user_id uuid)
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.id order by c.id), '{}')
    from public.an_fb_connections c
   where c.club_id <> ''
     and (select public.is_portal_user(_user_id))
     and (public.an_is_admin(_user_id)
          or exists (select 1 from public.an_fb_user_studios g
                      where g.user_id = _user_id and g.connection_id = c.id
                        and g.domain = c.domain and g.club_id = c.club_id));
$$;
revoke all on function public.an_fb_mycity_ids(uuid) from public, anon, authenticated;

create or replace function public.an_me_for(_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_all text[] := array['onec.revenue', 'onec.sales', 'onec.classes', 'onec.trials', 'onec.zero',
    'onec.mycity', 'fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity',
    'mkt.ls', 'mkt.lj', 'vk.register', 'avito.register', 'reviews'];
  v_fb text[] := array['fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity'];
  v_rights text[];
  v_admin boolean;
  v_granted text[];
  v_cities text[];
  v_partner boolean;
  v_target text;
  v_reports text[];
  v_inbox boolean;
begin
  if _user_id is null then
    return null;
  end if;
  -- Заблокирован, истёк доступ или убран из портала — «Аналитики» нет, даже
  -- если остались строки партнёра или назначенные студии FitBase.
  if not public.is_portal_user(_user_id) then
    return jsonb_build_object('visible', false, 'admin', false, 'reports', '[]'::jsonb,
      'partner_cities', null, 'targetologist', null, 'inbox', false);
  end if;
  select coalesce(r.rights, '{}') into v_rights
    from public.access_user_rights r where r.user_id = _user_id and r.portal;
  v_rights := coalesce(v_rights, '{}');
  v_admin := 'an.admin' = any (v_rights) or 'portal.admin' = any (v_rights);
  v_granted := array(select substr(x, 4) from unnest(v_rights) x
                      where x like 'an.%' and substr(x, 4) = any (v_all));
  select array_agg(city order by city) into v_cities
    from public.an_partner_cities where user_id = _user_id;
  v_partner := not v_admin and ('an.partner' = any (v_rights) or v_cities is not null);
  if not v_admin and 'an.targetologist' = any (v_rights) then
    -- ФИО — ключ назначений таргетологов (как у них).
    select nullif(btrim(full_name), '') into v_target from public.profiles where id = _user_id;
    v_target := coalesce(v_target, '');
  end if;

  if v_admin then
    v_reports := v_all;
  elsif v_target is not null then
    -- Таргетолог: реестр таргета и маркетинг всегда + всё выданное.
    v_reports := array(select distinct x from unnest(array['vk.register', 'mkt.ls', 'mkt.lj'] || v_granted) x);
  elsif v_partner then
    -- Партнёр: «Мой город» + маркетинг и отзывы + отчёты FitBase из выданного.
    v_reports := array(select distinct x from unnest(
      array['onec.mycity']
      || array(select g from unnest(v_granted) g
                where g = any (array['mkt.ls', 'mkt.lj', 'reviews'] || v_fb))) x);
  else
    v_reports := v_granted;
  end if;
  -- Их «Мой город · FitBase»: открыт тем, кому назначены студии (их
  -- user_fitbase_connections), независимо от прав 1С.
  if not v_admin and not ('fb.mycity' = any (v_reports))
     and cardinality(public.an_fb_mycity_ids(_user_id)) > 0 then
    v_reports := v_reports || 'fb.mycity'::text;
  end if;
  v_inbox := v_admin or 'an.inbox' = any (v_rights);

  return jsonb_build_object(
    'visible', v_admin or cardinality(v_reports) > 0 or v_inbox,
    'admin', v_admin,
    'reports', to_jsonb(v_reports),
    'partner_cities', case when v_partner then to_jsonb(coalesce(v_cities, '{}')) end,
    'targetologist', v_target,
    'inbox', v_inbox
  );
end;
$function$;
revoke all on function public.an_me_for(uuid) from public, anon, authenticated;
grant execute on function public.an_me_for(uuid) to service_role;

-- 6) Чаты — только людям портала ---------------------------------------------------
-- Своя роль в чате есть, только пока вы человек портала: на этом стоят все
-- функции чтения и записи чатов (роль другого человека — как раньше).
create or replace function public.chat_role(p_chat uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.chat_members
   where chat_id = p_chat and user_id = p_user
     and (p_user is distinct from auth.uid() or public.is_portal_user(p_user))
$$;

create or replace function public.chat_file_allowed(p_name text, p_write boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_folder text := split_part(coalesce(p_name, ''), '/', 1);
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    return false;
  end if;
  if v_folder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and exists (select 1 from public.chat_members
                  where chat_id = v_folder::uuid and user_id = v_uid) then
    return true;
  end if;
  if p_write then
    return false;
  end if;
  return exists (
    select 1
      from public.chat_messages m
      join public.chat_members cm on cm.chat_id = m.chat_id and cm.user_id = v_uid
     where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_name))
       and m.deleted_at is null
  );
end;
$$;

create or replace function public.chat_topic_member(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_topic is null or p_topic !~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or auth.uid() is null or not public.is_portal_user(auth.uid()) then
    return false;
  end if;
  return exists (select 1 from public.chat_members
                  where chat_id = substr(p_topic, 6)::uuid and user_id = auth.uid());
end;
$$;

-- 7) Оргструктура: права людей — не больше своих ---------------------------------
-- Пересчёт прав пишет в access_log строку «effective» (было / стало) с
-- автором и временем транзакции. Если в этой транзакции автор правил
-- структуру (unit.*, member.set, studio.*, brand.*, position.*; кроме
-- создания клуба — у «Создаёт клубы» своё право) и у кого-то права
-- прибавились, этого человека автор должен уметь вести сам
-- (access_can_manage_user) и выдать ему новые сетевые права (они есть у
-- автора). Себе — нельзя. Суперадминистратору — без ограничений.
create or replace function public.access_structure_guard()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  me public.access_user_rights;
  r record;
begin
  if v_uid is null or not exists (
       select 1 from public.access_log l
        where l.at = now() and l.actor_id = v_uid
          and (l.action in ('member.set', 'studio.owners', 'studio.update', 'studio.delete')
               or l.action like 'unit.%' or l.action like 'brand.%' or l.action like 'position.%')) then
    return;
  end if;
  select * into me from public.access_user_rights where user_id = v_uid;
  if found and 'portal.admin' = any (me.rights) then
    return;
  end if;
  for r in
    select l.target_user, l.details from public.access_log l
     where l.at = now() and l.actor_id = v_uid and l.action = 'effective'
       and l.target_user is not null
  loop
    if coalesce(r.details->'before', '{}'::jsonb) @> coalesce(r.details->'after', '{}'::jsonb) then
      continue;  -- права не прибавились
    end if;
    if r.target_user = v_uid then
      raise exception 'access_structure_self' using errcode = '42501';
    end if;
    if me.user_id is null or not public.access_can_manage_user(me, r.target_user)
       or exists (select 1 from jsonb_array_elements_text(coalesce(r.details->'after'->'rights', '[]'::jsonb)) x
                   where not (x = any (me.rights))
                     and not (coalesce(r.details->'before'->'rights', '[]'::jsonb) ? x)) then
      raise exception 'access_structure_grant' using errcode = '42501';
    end if;
  end loop;
end;
$$;
revoke all on function public.access_structure_guard() from public, anon, authenticated;

create or replace function public.access_guard(_before integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_flush();
  if _before > 0 and public.access_superadmin_count() = 0 then
    raise exception 'access_last_superadmin' using errcode = '42501';
  end if;
  perform public.access_structure_guard();
end;
$$;

-- Собственники клубов: та же проверка после пересчёта (access_guard эти
-- функции не зовут). Тела — как в 2026-10-27_zz_studio_owners.sql /
-- 2026-10-27_zzz_access_owned_scope.sql, в конце — access_structure_guard.
create or replace function public.org_studio_owners_set(p_studio uuid, p_users uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_name text;
begin
  select name into v_name from public.studios where id = p_studio;
  if v_name is null then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  perform public.org_studio_owners_write(p_studio, p_users);
  perform public.access_log_add('studio.owners',
    format('Собственники клуба «%s»: %s', v_name, public.org_owner_names(p_users)),
    null, null, jsonb_build_object('studio_id', p_studio, 'owner_ids', to_jsonb(p_users)));
  perform public.access_structure_guard();
end;
$function$;
create or replace function public.org_user_studios_set(p_user uuid, p_studios uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_studios uuid[] := coalesce(p_studios, '{}'::uuid[]);
begin
  if not exists (select 1 from public.portal_users where user_id = p_user) then
    raise exception 'Собственник должен быть пользователем портала' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_studios) s
              where not exists (select 1 from public.studios t where t.id = s)) then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  delete from public.studio_owners where user_id = p_user and not (studio_id = any (v_studios));
  insert into public.studio_owners (studio_id, user_id, created_by)
  select s, p_user, auth.uid() from unnest(v_studios) s
  on conflict do nothing;
  perform public.access_flush();
  perform public.access_log_add('studio.owners',
    format('Клубы собственника: %s', coalesce(
      (select string_agg(name, ', ' order by name) from public.studios where id = any (v_studios)), 'нет')),
    p_user, null, jsonb_build_object('studio_ids', to_jsonb(v_studios)));
  perform public.access_structure_guard();
end;
$function$;

-- 8) Обратная связь и NPS — по клубам ---------------------------------------------
drop policy if exists "feedback staff select" on public.feedback;
create policy "feedback staff select" on public.feedback
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "feedback staff insert" on public.feedback;
create policy "feedback staff insert" on public.feedback
  for insert to authenticated
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "feedback staff update" on public.feedback;
create policy "feedback staff update" on public.feedback
  for update to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "feedback staff delete" on public.feedback;
create policy "feedback staff delete" on public.feedback
  for delete to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));

drop policy if exists "nps staff select" on public.nps_responses;
create policy "nps staff select" on public.nps_responses
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "nps staff insert" on public.nps_responses;
create policy "nps staff insert" on public.nps_responses
  for insert to authenticated
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "nps staff update" on public.nps_responses;
create policy "nps staff update" on public.nps_responses
  for update to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));
drop policy if exists "nps staff delete" on public.nps_responses;
create policy "nps staff delete" on public.nps_responses
  for delete to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));

drop policy if exists "nps prompts staff select" on public.nps_survey_prompts;
create policy "nps prompts staff select" on public.nps_survey_prompts
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         or (studio_id is null and (select public.auth_access_rights()) @> array['portal.admin']));

-- 9) Сотрудники — только свои -----------------------------------------------------
-- Свой сотрудник: все его клубы — ваши (роль сотрудника в них) или у него ещё
-- нет клубов (только что заведён). Суперадминистратору — все.
create or replace function public.can_manage_employee(_user_id uuid, _trainer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_admin_section(_user_id, 'staff')
     and (public.access_has_right(_user_id, 'portal.admin')
          or not exists (
            select 1 from public.trainer_studios ts
             where ts.trainer_id = _trainer_id
               and not public.is_trainer(_user_id, ts.studio_id)))
$$;
revoke all on function public.can_manage_employee(uuid, uuid) from public, anon;
grant execute on function public.can_manage_employee(uuid, uuid) to authenticated, service_role;

drop policy if exists "trainers staff write" on public.trainers;
drop policy if exists "trainers staff insert" on public.trainers;
create policy "trainers staff insert" on public.trainers
  for insert to authenticated
  with check ((select public.has_admin_section(auth.uid(), 'staff')));
drop policy if exists "trainers staff update" on public.trainers;
create policy "trainers staff update" on public.trainers
  for update to authenticated
  using (public.can_manage_employee((select auth.uid()), id))
  with check (public.can_manage_employee((select auth.uid()), id));
drop policy if exists "trainers staff delete" on public.trainers;
create policy "trainers staff delete" on public.trainers
  for delete to authenticated
  using (public.can_manage_employee((select auth.uid()), id));

drop policy if exists "trainer_studios staff write" on public.trainer_studios;
drop policy if exists "trainer_studios staff insert" on public.trainer_studios;
create policy "trainer_studios staff insert" on public.trainer_studios
  for insert to authenticated
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              and public.can_manage_employee((select auth.uid()), trainer_id));
drop policy if exists "trainer_studios staff update" on public.trainer_studios;
create policy "trainer_studios staff update" on public.trainer_studios
  for update to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         and public.can_manage_employee((select auth.uid()), trainer_id))
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
              and public.can_manage_employee((select auth.uid()), trainer_id));
drop policy if exists "trainer_studios staff delete" on public.trainer_studios;
create policy "trainer_studios staff delete" on public.trainer_studios
  for delete to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         and (select public.has_admin_section(auth.uid(), 'staff')));

notify pgrst, 'reload schema';
