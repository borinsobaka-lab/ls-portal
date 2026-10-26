-- ============================================================================
-- Термин «клуб» вместо «студии» в админке (2026-10-11, решение владельца).
-- Тексты ошибок create_studio / delete_studio админка показывает как есть —
-- переписаны на «клуб». Логика функций не меняется: тела скопированы из
-- 2026-10-09_studio_formats.sql и 2026-10-10_studio_delete.sql, отличаются
-- только сообщения. Актуальные определения обеих функций — здесь.
-- В схеме (таблица studios, studio_id, имена функций) остаётся «studio».
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

create or replace function public.create_studio(
  _name text,
  _format text,
  _brand_color text,
  _logo_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _id uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Создавать клубы может только владелец' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(_name, '')), '') is null then
    raise exception 'Укажите название клуба' using errcode = '22023';
  end if;

  insert into public.studios (name, format, brand_color, logo_url)
  values (trim(_name), _format, _brand_color, nullif(trim(coalesce(_logo_url, '')), ''))
  returning id into _id;

  insert into public.user_roles (user_id, studio_id, role)
  values (auth.uid(), _id, 'owner')
  on conflict (user_id, studio_id, role) do nothing;

  return _id;
end;
$$;

revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated;

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
  if auth.uid() is null or not public.has_role(auth.uid(), _studio_id, 'owner') then
    raise exception 'Удалять клуб может только его владелец' using errcode = '42501';
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

  -- 2) Общий контент приложения отвязываем от студии.
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

  -- 3) Профили переносим до удаления (restrict). Сотруднику — студия, где у
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
end;
$$;

revoke all on function public.delete_studio(uuid, text) from public, anon;
grant execute on function public.delete_studio(uuid, text) to authenticated;
