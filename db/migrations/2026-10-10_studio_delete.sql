-- ============================================================================
-- Удаление студии (2026-10-10, решение владельца). Раньше удаления не было
-- намеренно (2026-10-09_studio_formats.sql): каскадом уходят все данные
-- студии. Теперь — RPC delete_studio, только владелец (owner) этой студии,
-- с подтверждением названием студии.
--
-- Что происходит:
-- 1) Удаляются студия и всё, что к ней привязано каскадом: карточки клиентов,
--    абонементы, продажи, касса, расписание, записи, номенклатура, промокоды,
--    роли и права сотрудников в этой студии (user_roles, admin_studio_permissions),
--    привязки сотрудников (trainer_studios — сами сотрудники остаются).
-- 2) Общий контент мобильного приложения (news/services/push_notifications,
--    club_settings) не удаляется: у старых строк ещё есть studio_id с
--    каскадом — отвязываем их от студии (studio_id = null; где колонка
--    обязательна — переносим на другую студию).
-- 3) Учётные записи не удаляются. profiles.studio_id (on delete restrict)
--    переносится: сотруднику — в другую его студию, остальным (клиентам) — в
--    самую старую студию, как у handle_new_user; там же им выдаётся роль
--    member, если ролей в новой студии нет.
-- 4) Последнюю студию удалить нельзя: регистрации нужна хотя бы одна.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

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
    raise exception 'Удалять студию может только её владелец' using errcode = '42501';
  end if;

  select name into _name from public.studios where id = _studio_id for update;
  if not found then
    raise exception 'Студия не найдена' using errcode = 'P0002';
  end if;
  if trim(coalesce(_confirm_name, '')) <> trim(_name) then
    raise exception 'Название студии введено неверно' using errcode = '22023';
  end if;

  select id into _fallback from public.studios
   where id <> _studio_id order by created_at asc, id limit 1;
  if _fallback is null then
    raise exception 'Нельзя удалить последнюю студию' using errcode = '22023';
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
    raise exception 'Студию не удалось удалить: на неё ссылаются данные (%)', sqlerrm
      using errcode = '23503';
  end;
end;
$$;

revoke all on function public.delete_studio(uuid, text) from public, anon;
grant execute on function public.delete_studio(uuid, text) to authenticated;
