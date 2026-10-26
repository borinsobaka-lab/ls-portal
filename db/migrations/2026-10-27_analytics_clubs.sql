-- ============================================================================
-- «Аналитика сети» по клубам портала (решение владельца 2026-10-27).
--
-- Клубы заводятся в «Управлении» → «Клубы» и используются в аналитике:
-- доступ к отчётам выдаётся ролью на конкретные клубы, несколько, клубы
-- бренда или все. Владельцу франшизы — все клубы («Аналитика сети:
-- все клубы», analytics.view), собственнику клуба — только свои.
--
--   * право analytics.clubs «Аналитика сети: свои клубы» — с областью
--     клубов (scope 'studio'): клубы выбираются при назначении роли, как у
--     «Управляет пользователями». Пересчёт прав (access_compile) его не
--     сворачивает: клубы берутся из действующих назначений в момент запроса
--     (an_club_ids — access_applicable + access_scope_studios);
--   * an_studios.club_id — какой клуб портала стоит за студией выгрузки
--     (студии называются, как в учётной системе; связь ставят в «Аналитике»
--     → «Студии сети», an_studio_save); удалили клуб — связь снимается;
--   * auth_an_studio_ids: все (view / manage) или студии своих городов
--     (cities) и своих клубов (clubs); an_access отдаёт и клубы;
--   * стартовая роль «Владелец клуба — аналитика» (analytics.clubs).
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Право ---------------------------------------------------------------------
insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('analytics.clubs', 'sections', 'Аналитика сети: свои клубы',
   'Отчёты только по клубам, выбранным при назначении роли (собственник — свои клубы). Студии выгрузок связываются с клубами в «Аналитике» → «Студии сети».',
   'studio', '{on}', null, 131)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;
update public.access_permissions set sort_order = 132 where key = 'analytics.cities';
update public.access_permissions set sort_order = 133 where key = 'analytics.manage';

-- 2) Связь студии выгрузки с клубом портала -------------------------------------
alter table public.an_studios
  add column if not exists club_id uuid references public.studios(id) on delete set null;
create index if not exists an_studios_club_idx on public.an_studios (club_id) where club_id is not null;

-- 3) Клубы аналитики человека ---------------------------------------------------
-- Клубы из действующих назначений ролей с analytics.clubs (сроки, должность,
-- подразделение — как у прочих прав; заблокированному и без доступа к
-- порталу — пусто). Внутренняя.
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

-- 4) Кто что видит ---------------------------------------------------------------
create or replace function public.auth_an_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_clubs uuid[];
  v_cities boolean;
begin
  if public.an_has(auth.uid(), 'analytics.view') or public.an_has(auth.uid(), 'analytics.manage') then
    return (select coalesce(array_agg(id), '{}'::uuid[]) from public.an_studios);
  end if;
  v_cities := public.an_has(auth.uid(), 'analytics.cities');
  v_clubs := public.an_club_ids(auth.uid());
  return (
    select coalesce(array_agg(s.id), '{}'::uuid[])
      from public.an_studios s
     where (v_cities and exists (select 1 from public.an_user_cities c
                                  where c.city = s.city and c.user_id = auth.uid()))
        or s.club_id = any (v_clubs)
  );
end;
$$;
revoke all on function public.auth_an_studio_ids() from public, anon;
grant execute on function public.auth_an_studio_ids() to authenticated, service_role;

create or replace function public.an_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'view', public.an_has(auth.uid(), 'analytics.view'),
    'manage', public.an_has(auth.uid(), 'analytics.manage'),
    'cities', case when public.an_has(auth.uid(), 'analytics.cities')
                   then coalesce((select jsonb_agg(city order by city) from public.an_user_cities
                                   where user_id = auth.uid()), '[]'::jsonb)
                   else '[]'::jsonb end,
    'clubs', to_jsonb(public.an_club_ids(auth.uid())))
$$;
revoke all on function public.an_access() from public, anon;
grant execute on function public.an_access() to authenticated;

-- 5) Справочник студий: клуб портала ---------------------------------------------
drop function if exists public.an_studio_save(uuid, text, text, uuid, date, text);
create or replace function public.an_studio_save(
  p_id uuid, p_city text, p_partner text, p_brand_id uuid, p_closed_on date, p_note text,
  p_club_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.an_can_manage() then
    raise exception 'Нет права менять справочники аналитики' using errcode = '42501';
  end if;
  if p_club_id is not null and not exists (select 1 from public.studios where id = p_club_id) then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  update public.an_studios
     set city = nullif(btrim(p_city), ''), partner = nullif(btrim(p_partner), ''),
         brand_id = p_brand_id, closed_on = p_closed_on, note = nullif(btrim(p_note), ''),
         club_id = p_club_id, needs_review = false, updated_at = now(), updated_by = auth.uid()
   where id = p_id;
  if not found then
    raise exception 'Студия не найдена' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.an_studio_save(uuid, text, text, uuid, date, text, uuid) from public, anon;
grant execute on function public.an_studio_save(uuid, text, text, uuid, date, text, uuid) to authenticated;

create or replace function public.an_studios_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not public.an_can_manage() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.name, 'source', s.source, 'city', s.city, 'partner', s.partner,
             'brand_id', s.brand_id, 'closed_on', s.closed_on, 'needs_review', s.needs_review,
             'note', s.note, 'club_id', s.club_id, 'club_name', c.name,
             'first_day', (select min(day) from public.an_revenue r where r.studio_id = s.id),
             'last_day', (select max(day) from public.an_revenue r where r.studio_id = s.id))
           order by s.needs_review desc, s.city nulls first, s.name)
      from public.an_studios s
      left join public.studios c on c.id = s.club_id), '[]'::jsonb) end
$$;
revoke all on function public.an_studios_list() from public, anon;
grant execute on function public.an_studios_list() to authenticated;

-- 6) Стартовая роль: собственник клуба видит аналитику своих клубов ------------
select public.access_seed_role('club_owner_analytics', 'Владелец клуба — аналитика',
  'Отчёты «Аналитики сети» по своим клубам: клубы выбираются при назначении роли.', '#c026d3', 97, false,
  array['analytics.clubs']);

notify pgrst, 'reload schema';
