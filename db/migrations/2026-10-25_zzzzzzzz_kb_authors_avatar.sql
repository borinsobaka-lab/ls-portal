-- База знаний: автор статьи с аватаркой (решение владельца 2026-10-25) —
-- в шапке статьи аватарка, «Автор: Имя» и ниже «Обновлено …». kb_authors
-- отдаёт и аватарку сотрудника (profiles.avatar_url, бакет avatars); смысл
-- и права прежние. Тип ответа меняется — функция пересоздаётся (актуальное
-- определение — здесь).
drop function if exists public.kb_authors(uuid);
create function public.kb_authors(p_base uuid)
returns table (user_id uuid, full_name text, avatar_url text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lvl text := public.kb_base_level(auth.uid(), p_base);
begin
  if lvl is null then
    raise exception 'kb_forbidden';
  end if;
  return query
  select p.id, p.full_name, p.avatar_url
    from public.profiles p
   where p.id in (
     select unnest(array[n.created_by, n.updated_by, n.published_by])
       from public.kb_nodes n where n.base_id = p_base
     union
     select d.updated_by from public.kb_drafts d where d.base_id = p_base
     union
     select r.published_by from public.kb_revisions r where r.base_id = p_base
     union
     select unnest(array[t.created_by, t.updated_by])
       from public.kb_templates t where lvl in ('edit', 'manage')
     union
     select t.deleted_by from public.kb_trash t where t.base_id = p_base
   );
end;
$$;
revoke all on function public.kb_authors(uuid) from public, anon;
grant execute on function public.kb_authors(uuid) to authenticated, service_role;
