-- ============================================================================
-- Клубы — в одном месте: «Оргструктура» → «Сеть клубов» (решение владельца
-- 2026-10-27). Пункт «Управление» → «Клубы» на первом этапе скрыт: клуб
-- заводят, правят и удаляют рядом с брендами.
--
--   * studio_owners — собственники клуба (один или несколько пользователей
--     портала). Связь двусторонняя: в клубе меняют собственников, в карточке
--     пользователя — его клубы. Пишут только RPC ниже (право
--     structure.manage), читают все пользователи портала, как бренды;
--   * org_studio_create — новый клуб: название, бренд, свой / франшиза,
--     город, тип (подписочный / пакетный; по умолчанию пакетный — Lady
--     Stretch), собственники. Право — «Создаёт клубы» (studios.create) и
--     «Оргструктура» (structure.manage);
--   * org_studio_save — и название, и собственники (p.owner_ids);
--   * org_studio_owners_set / org_user_studios_set — собственники клуба /
--     клубы собственника целиком;
--   * delete_studio — удалить клуб может и тот, у кого «Создаёт клубы»
--     (раньше — только владелец этого клуба в user_roles; суперадминистратор
--     портала без ролей в клубах удалить его не мог);
--   * an_club_ids: у кого есть «Аналитика сети: свои клубы», тому к клубам
--     назначения добавляются клубы, где он собственник.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- 1) Собственники ---------------------------------------------------------------
create table if not exists public.studio_owners (
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references public.portal_users(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (studio_id, user_id)
);
create index if not exists studio_owners_user_idx on public.studio_owners (user_id);

alter table public.studio_owners enable row level security;
drop policy if exists "studio_owners read" on public.studio_owners;
create policy "studio_owners read" on public.studio_owners
  for select to authenticated using ((select public.is_portal_user(auth.uid())));
revoke insert, update, delete on public.studio_owners from anon, authenticated;
grant select on public.studio_owners to authenticated;

-- Внутренняя: заменить собственников клуба (без проверки прав).
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
end;
$$;
revoke all on function public.org_studio_owners_write(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.org_owner_names(p_users uuid[])
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(string_agg(public.access_user_name(u), ', ' order by public.access_user_name(u)), ''),
                  'нет')
    from unnest(coalesce(p_users, '{}'::uuid[])) u
$$;
revoke all on function public.org_owner_names(uuid[]) from public, anon, authenticated;

-- 2) Новый клуб ------------------------------------------------------------------
create or replace function public.org_studio_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_name text := btrim(coalesce(p->>'name', ''));
  v_format text := coalesce(nullif(p->>'format', ''), 'packages');
  v_id uuid;
  v_owners uuid[];
begin
  perform public.access_require('studios.create');
  if v_name = '' then
    raise exception 'Укажите название клуба' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Название клуба — до 120 знаков' using errcode = '22023';
  end if;
  insert into public.studios (name, format, brand_id, ownership, city)
  values (v_name, v_format, nullif(p->>'brand_id', '')::uuid,
          coalesce(nullif(p->>'ownership', ''), 'own'),
          nullif(btrim(coalesce(p->>'city', '')), ''))
  returning id into v_id;
  if p ? 'owner_ids' then
    v_owners := array(select jsonb_array_elements_text(p->'owner_ids')::uuid);
    perform public.org_studio_owners_write(v_id, v_owners);
  end if;
  perform public.access_log_add('studio.create', format('Создан клуб «%s»', v_name),
    null, null, jsonb_build_object('studio_id', v_id, 'fields', p));
  perform public.access_flush();
  return v_id;
end;
$$;

-- 3) Клуб: название, бренд, свой / франшиза, город, собственники ------------------
create or replace function public.org_studio_save(p_studio uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.access_user_rights := public.access_require('structure.manage');
  v_before integer := public.access_superadmin_count();
  v_name text := nullif(btrim(coalesce(p->>'name', '')), '');
begin
  if not exists (select 1 from public.studios where id = p_studio) then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Название клуба — до 120 знаков' using errcode = '22023';
  end if;
  update public.studios
     set name = coalesce(v_name, name),
         brand_id = case when p ? 'brand_id' then nullif(p->>'brand_id', '')::uuid else brand_id end,
         ownership = coalesce(nullif(p->>'ownership', ''), ownership),
         city = case when p ? 'city' then nullif(btrim(coalesce(p->>'city', '')), '') else city end
   where id = p_studio;
  if p ? 'owner_ids' then
    perform public.org_studio_owners_write(p_studio,
      array(select jsonb_array_elements_text(p->'owner_ids')::uuid));
  end if;
  perform public.access_log_add('studio.update',
    format('Клуб «%s»', (select name from public.studios where id = p_studio)),
    null, null, jsonb_build_object('studio_id', p_studio, 'fields', p));
  perform public.access_guard(v_before);
end;
$$;

create or replace function public.org_studio_owners_set(p_studio uuid, p_users uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
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
end;
$$;

-- Клубы собственника целиком (карточка пользователя).
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
  perform public.access_log_add('studio.owners',
    format('Клубы собственника: %s', coalesce(
      (select string_agg(name, ', ' order by name) from public.studios where id = any (v_studios)), 'нет')),
    p_user, null, jsonb_build_object('studio_ids', to_jsonb(v_studios)));
end;
$$;

revoke all on function
  public.org_studio_create(jsonb), public.org_studio_save(uuid, jsonb),
  public.org_studio_owners_set(uuid, uuid[]), public.org_user_studios_set(uuid, uuid[])
  from public, anon;
grant execute on function
  public.org_studio_create(jsonb), public.org_studio_save(uuid, jsonb),
  public.org_studio_owners_set(uuid, uuid[]), public.org_user_studios_set(uuid, uuid[])
  to authenticated, service_role;

-- 4) Удаление клуба: и с правом «Создаёт клубы» ------------------------------------
create or replace function public.delete_studio(_studio_id uuid, _confirm_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _name text;
  _fallback uuid;
  _t text;
  _nullable text;
begin
  if auth.uid() is null or not (
    public.has_role(auth.uid(), _studio_id, 'owner')
    or public.access_has_right(auth.uid(), 'studios.create')
  ) then
    raise exception 'Удалять клуб может только его владелец или тот, у кого есть право «Создаёт клубы»'
      using errcode = '42501';
  end if;

  select name into _name from public.studios where id = _studio_id for update;
  if not found then
    raise exception 'Клуб не найден' using errcode = 'P0002';
  end if;
  if trim(coalesce(_confirm_name, '')) <> trim(_name) then
    raise exception 'Название клуба введено неверно' using errcode = '22023';
  end if;

  select id into _fallback from public.studios
   where id <> _studio_id order by created_at asc, id limit 1;
  if _fallback is null then
    raise exception 'Нельзя удалить последний клуб' using errcode = '22023';
  end if;

  -- Общий контент приложения отвязываем от студии.
  foreach _t in array array['news', 'services', 'push_notifications', 'club_settings'] loop
    select c.is_nullable into _nullable
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = _t and c.column_name = 'studio_id';
    if _nullable = 'YES' then
      execute format('update public.%I set studio_id = null where studio_id = $1', _t)
        using _studio_id;
    elsif _nullable = 'NO' then
      execute format('update public.%I set studio_id = $2 where studio_id = $1', _t)
        using _studio_id, _fallback;
    end if;
    _nullable := null;
  end loop;

  -- Профили переносим до удаления (restrict): сотруднику — студия, где у
  -- него есть роль сотрудника (самая старая), иначе любая его роль, иначе
  -- самая старая студия.
  with moved as (
    update public.profiles p
       set studio_id = coalesce(
         (select ur.studio_id
            from public.user_roles ur
            join public.studios s on s.id = ur.studio_id
           where ur.user_id = p.id and ur.studio_id <> _studio_id
           order by (ur.role = 'member'), s.created_at, s.id
           limit 1),
         _fallback)
     where p.studio_id = _studio_id
    returning p.id, p.studio_id
  )
  insert into public.user_roles (user_id, studio_id, role)
  select m.id, m.studio_id, 'member'
    from moved m
   where not exists (
     select 1 from public.user_roles ur
      where ur.user_id = m.id and ur.studio_id = m.studio_id
   )
  on conflict (user_id, studio_id, role) do nothing;

  begin
    delete from public.studios where id = _studio_id;
  exception when foreign_key_violation then
    raise exception 'Клуб не удалось удалить: на него ссылаются данные (%)', sqlerrm
      using errcode = '23503';
  end;

  if public.access_is_managed(auth.uid()) then
    perform public.access_log_add('studio.delete', format('Удалён клуб «%s»', _name),
      null, null, jsonb_build_object('studio_id', _studio_id));
  end if;
end;
$$;
revoke all on function public.delete_studio(uuid, text) from public, anon;
grant execute on function public.delete_studio(uuid, text) to authenticated;

-- 5) Аналитика: клубы собственника — «свои клубы» --------------------------------
create or replace function public.an_club_ids(_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with rights as (
    select a.scope_type, a.scope_ids
      from public.access_applicable(_user_id) a
      join public.access_role_permissions rp
        on rp.role_id = a.role_id and rp.perm_key = 'analytics.clubs'
     where exists (select 1 from public.access_user_rights r
                    where r.user_id = _user_id and r.portal)
  )
  select coalesce(array_agg(distinct x.sid), '{}'::uuid[])
    from (
      select s.sid
        from rights a
       cross join lateral unnest(public.access_scope_studios(a.scope_type, a.scope_ids)) s(sid)
      union
      select o.studio_id
        from public.studio_owners o
       where o.user_id = _user_id and exists (select 1 from rights)
    ) x
$$;
revoke all on function public.an_club_ids(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
