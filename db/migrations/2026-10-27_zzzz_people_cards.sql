-- Люди портала в базе знаний (решение владельца 2026-10-27): упоминание
-- «@» — выбор из списка сотрудников с поиском, в тексте — аватарка и имя;
-- по нажатию на упоминание, автора статьи и других людей портала —
-- карточка сотрудника.
--
--   * kb_mention_candidates — все действующие люди портала (раньше — только
--     с доступом к базе: остальных в списке не было), с должностью и
--     отметкой has_access (видит ли базу; без доступа — ниже в списке).
--     Вызывает редактор базы, как раньше. Тип ответа меняется — функция
--     пересоздаётся (актуальное определение — здесь).
--   * people_cards(ids) — имя, аватарка и должность для упоминаний и
--     списков (не больше 200 человек за вызов), любому человеку портала.
--   * person_card(user) — карточка: имя, аватарка, должность, тип,
--     подразделения с ролью, клубы с ролью, собственник каких клубов,
--     почта и телефон из профиля; любому человеку портала (справочник
--     компании). Нет такого человека — null.

-- Люди портала: сотрудники клубов и люди с ролями портала.
create or replace function public.portal_people_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select x.id
    from (
      select ur.user_id as id from public.user_roles ur where ur.role in ('owner', 'admin', 'trainer')
      union
      select r.user_id from public.access_user_rights r where r.portal
    ) x
   where public.is_portal_user(x.id)
$$;
revoke all on function public.portal_people_ids() from public, anon, authenticated;

drop function if exists public.kb_mention_candidates(uuid);
create function public.kb_mention_candidates(p_base uuid)
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
    select g.subject_id from public.kb_grants g
     where g.base_id = p_base and g.node_id is null and g.subject_type = 'user'
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

create or replace function public.people_cards(p_ids uuid[])
returns table (user_id uuid, full_name text, avatar_url text, position_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_portal_user(auth.uid()) then
    raise exception 'forbidden';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 200 then
    raise exception 'too_many';
  end if;
  return query
  select u.id,
         coalesce(nullif(btrim(p.full_name), ''), u.email::text),
         p.avatar_url,
         pos.name
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
   where u.id = any (p_ids);
end;
$$;

create or replace function public.person_card(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  res jsonb;
  owned jsonb := '[]'::jsonb;
begin
  if not public.is_portal_user(auth.uid()) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    return null;
  end if;
  -- Собственники клубов — с 2026-10-27_zz_studio_owners.sql (в копии
  -- Base40 таблицы может не быть).
  if to_regclass('public.studio_owners') is not null then
    execute $q$
      select coalesce(jsonb_agg(s.name order by s.name), '[]'::jsonb)
        from public.studio_owners so join public.studios s on s.id = so.studio_id
       where so.user_id = $1
    $q$ into owned using p_user;
  end if;
  select jsonb_build_object(
           'user_id', u.id,
           'full_name', coalesce(nullif(btrim(p.full_name), ''), u.email::text),
           'avatar_url', p.avatar_url,
           'email', coalesce(nullif(btrim(p.email), ''), u.email::text),
           'phone', nullif(btrim(p.phone), ''),
           'position_name', pos.name,
           'user_type', pu.user_type,
           'blocked', coalesce(pu.status = 'blocked', false),
           'active', public.is_portal_user(u.id),
           'units', coalesce((
             select jsonb_agg(jsonb_build_object('name', ou.name, 'role', m.member_role)
                              order by m.member_role = 'member', ou.name)
               from public.org_unit_members m join public.org_units ou on ou.id = m.unit_id
              where m.user_id = u.id), '[]'::jsonb),
           'clubs', coalesce((
             select jsonb_agg(jsonb_build_object('name', c.name, 'role', c.role) order by c.name)
               from (select distinct on (s.id) s.id, s.name, ur.role::text as role
                       from public.user_roles ur join public.studios s on s.id = ur.studio_id
                      where ur.user_id = u.id and ur.role in ('owner', 'admin', 'trainer')
                      order by s.id, case ur.role when 'owner' then 0 when 'admin' then 1 else 2 end) c
           ), '[]'::jsonb),
           'owned_clubs', owned
         )
    into res
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
   where u.id = p_user;
  return res;
end;
$$;

revoke all on function public.kb_mention_candidates(uuid), public.people_cards(uuid[]),
  public.person_card(uuid) from public, anon;
grant execute on function public.kb_mention_candidates(uuid), public.people_cards(uuid[]),
  public.person_card(uuid) to authenticated, service_role;
