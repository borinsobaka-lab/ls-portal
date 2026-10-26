-- ============================================================================
-- Область назначения «Клубы, где он собственник» (решение владельца
-- 2026-10-27): роль «Владелец клуба — аналитика» выдаётся сразу всем
-- партнёрам (человеку, должности или подразделению), а клубы у каждого —
-- свои, из «Сети клубов» (studio_owners). Раньше при выдаче надо было
-- выбрать конкретные клубы: «Все клубы» открыли бы партнёрам всю сеть.
--
--   * access_assignments.scope_type = 'owned' (scope_ids пустой);
--   * access_applicable отдаёт такое назначение как «выбранные клубы» —
--     клубы, где человек собственник сейчас. Поэтому пересчёт прав,
--     «Откуда права» и «Аналитика сети: свои клубы» (an_club_ids) видят
--     настоящие клубы без своих правок;
--   * смена собственников клуба пересчитывает права затронутых людей
--     (триггер на studio_owners; RPC собственников — сразу, access_flush);
--   * an_club_ids — снова только клубы назначений: клубы собственника
--     добавляются не сами, а областью «Клубы собственника» (иначе роль на
--     выбранные клубы открывала бы и чужие для этой роли клубы);
--   * выдать «Клубы собственника» с правами «в клубе» может только
--     администратор всех пользователей (как «Все клубы»).
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

alter table public.access_assignments drop constraint if exists access_assignments_scope_type_check;
alter table public.access_assignments
  add constraint access_assignments_scope_type_check
  check (scope_type in ('all', 'brands', 'studios', 'owned'));

-- Действующие назначения: «Клубы собственника» — клубы человека сейчас.
create or replace function public.access_applicable(_user_id uuid, _at timestamptz default now())
returns setof public.access_assignments
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.role_id, a.subject_type, a.user_id, a.unit_id, a.position_id, a.unit_members,
         a.with_subunits,
         case when a.scope_type = 'owned' then 'studios' else a.scope_type end,
         case when a.scope_type = 'owned'
              then coalesce((select array_agg(o.studio_id) from public.studio_owners o
                              where o.user_id = _user_id), '{}'::uuid[])
              else a.scope_ids end,
         a.valid_from, a.valid_until, a.note, a.created_at, a.created_by
    from public.access_assignments a
   where (a.valid_from is null or a.valid_from <= _at)
     and (a.valid_until is null or a.valid_until > _at)
     and (
       (a.subject_type = 'user' and a.user_id = _user_id)
       or (a.subject_type = 'position'
           and a.position_id = (select pu.position_id from public.portal_users pu
                                 where pu.user_id = _user_id))
       or (a.subject_type = 'unit' and exists (
             select 1
               from public.org_unit_members m
               join public.org_units u on u.id = m.unit_id
              where m.user_id = _user_id
                and (a.unit_members = 'all' or m.member_role in ('head', 'deputy'))
                and (u.id = a.unit_id or (a.with_subunits and a.unit_id = any (u.path)))))
     )
$$;
revoke all on function public.access_applicable(uuid, timestamptz) from public, anon, authenticated;

-- Собственники поменялись — права затронутых людей пересчитываются.
create or replace function public.studio_owners_access_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.access_mark(array[coalesce(new.user_id, old.user_id)]);
  return null;
end;
$$;
drop trigger if exists studio_owners_access_mark_aiud on public.studio_owners;
create trigger studio_owners_access_mark_aiud
  after insert or delete on public.studio_owners
  for each row execute function public.studio_owners_access_mark();

-- RPC собственников пересчитывают права сразу, в той же транзакции.
create or replace function public.org_studio_owners_write(p_studio uuid, p_users uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_users uuid[] := coalesce(p_users, '{}'::uuid[]);
begin
  if exists (select 1 from unnest(v_users) u
              where not exists (select 1 from public.portal_users pu where pu.user_id = u)) then
    raise exception 'Собственник должен быть пользователем портала' using errcode = '22023';
  end if;
  delete from public.studio_owners where studio_id = p_studio and not (user_id = any (v_users));
  insert into public.studio_owners (studio_id, user_id, created_by)
  select p_studio, u, auth.uid() from unnest(v_users) u
  on conflict do nothing;
  perform public.access_flush();
end;
$$;
revoke all on function public.org_studio_owners_write(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.org_user_studios_set(p_user uuid, p_studios uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
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
end;
$$;

-- «Аналитика сети: свои клубы» — клубы назначений (и «Клубы собственника»).
create or replace function public.an_club_ids(_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct s.sid), '{}'::uuid[])
    from public.access_applicable(_user_id) a
    join public.access_role_permissions rp
      on rp.role_id = a.role_id and rp.perm_key = 'analytics.clubs'
   cross join lateral unnest(public.access_scope_studios(a.scope_type, a.scope_ids)) s(sid)
   where exists (select 1 from public.access_user_rights r
                  where r.user_id = _user_id and r.portal)
$$;
revoke all on function public.an_club_ids(uuid) from public, anon, authenticated;

-- Выдача роли: «Клубы собственника» — без списка клубов, как «Все клубы»
-- (остальное — как в 2026-10-25_zzzzzzzzzzzz_access_roles.sql).
create or replace function public.access_assignment_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_actor();
  v_before integer := public.access_superadmin_count();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_old public.access_assignments;
  v_new public.access_assignments;
  v_problem text;
  v_scope_type text := coalesce(p->>'scope_type', 'all');
  v_scope uuid[] := coalesce(array(select jsonb_array_elements_text(coalesce(p->'scope_ids', '[]')))::uuid[], '{}');
  v_subject text := coalesce(p->>'subject_type', 'user');
  v_role public.access_roles;
begin
  if v_id is not null then
    select * into v_old from public.access_assignments where id = v_id;
    if not found then
      raise exception 'access_assignment_not_found' using errcode = 'P0002';
    end if;
    v_problem := public.access_grant_problem(me, v_old.role_id, v_old.subject_type, v_old.scope_type, v_old.scope_ids);
    if v_problem is not null then
      raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
    end if;
  end if;
  select * into v_role from public.access_roles where id = (p->>'role_id')::uuid;
  if not found or v_role.personal_user_id is not null then
    raise exception 'access_role_not_found' using errcode = 'P0002';
  end if;
  if v_scope_type in ('all', 'owned') then
    v_scope := '{}';
  elsif cardinality(v_scope) = 0 then
    raise exception 'access_scope_empty' using errcode = '22023';
  end if;
  v_problem := public.access_grant_problem(me, v_role.id, v_subject, v_scope_type, v_scope);
  if v_problem is not null then
    raise exception 'access_grant_denied' using errcode = '42501', detail = v_problem;
  end if;
  if v_subject = 'user' and nullif(p->>'user_id', '')::uuid is distinct from me.user_id
     and not public.access_can_manage_user(me, (p->>'user_id')::uuid)
     and not exists (select 1 from public.portal_users where user_id = (p->>'user_id')::uuid
                                                          and created_by = me.user_id) then
    raise exception 'access_forbidden' using errcode = '42501';
  end if;
  -- Себе роль выдаёт только суперадминистратор.
  if v_subject = 'user' and (p->>'user_id')::uuid = me.user_id and not ('portal.admin' = any (me.rights)) then
    raise exception 'access_self' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.access_assignments (role_id, subject_type, user_id, unit_id, position_id, unit_members,
      with_subunits, scope_type, scope_ids, valid_from, valid_until, note, created_by)
    values (v_role.id, v_subject,
            case when v_subject = 'user' then (p->>'user_id')::uuid end,
            case when v_subject = 'unit' then (p->>'unit_id')::uuid end,
            case when v_subject = 'position' then (p->>'position_id')::uuid end,
            coalesce(p->>'unit_members', 'all'), coalesce((p->>'with_subunits')::boolean, true),
            v_scope_type, v_scope,
            nullif(p->>'valid_from', '')::timestamptz, nullif(p->>'valid_until', '')::timestamptz,
            nullif(btrim(coalesce(p->>'note', '')), ''), auth.uid())
    returning * into v_new;
  else
    update public.access_assignments
       set role_id = v_role.id, unit_members = coalesce(p->>'unit_members', 'all'),
           with_subunits = coalesce((p->>'with_subunits')::boolean, true),
           scope_type = v_scope_type, scope_ids = v_scope,
           valid_from = nullif(p->>'valid_from', '')::timestamptz,
           valid_until = nullif(p->>'valid_until', '')::timestamptz,
           note = nullif(btrim(coalesce(p->>'note', '')), '')
     where id = v_id
    returning * into v_new;
  end if;

  perform public.access_log_add(
    case when v_id is null then 'assign' else 'assign.update' end,
    format('Роль «%s» — %s', v_role.name,
           case v_subject
             when 'user' then public.access_user_name(v_new.user_id)
             when 'unit' then 'подразделение «' || (select name from public.org_units where id = v_new.unit_id) || '»'
             else 'должность «' || (select name from public.org_positions where id = v_new.position_id) || '»'
           end),
    v_new.user_id, v_role.id,
    jsonb_build_object('before', case when v_id is null then null else to_jsonb(v_old) end,
                       'after', to_jsonb(v_new)));
  perform public.access_guard(v_before);
  return v_new.id;
end;
$$;

notify pgrst, 'reload schema';
