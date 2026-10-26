-- Шаблоны статей — общие для всех баз знаний (решение владельца 2026-10-25).
--
-- 1) kb_templates без base_id: шаблон видят, создают, правят и удаляют
--    редакторы любой базы и владельцы (auth_kb_is_editor). Статья по шаблону
--    создаётся в любой базе.
-- 2) Файлы шаблона — своя папка бакета kb-media: templates/{шаблон}/{файл}
--    (читать и писать — редакторам). Админка копирует туда файлы статьи при
--    «Сохранить как шаблон», а при «Статья по шаблону» — из неё в папку
--    статьи: статья не зависит от шаблона, читателям не нужен доступ к
--    папке шаблонов. Удалённый шаблон — его папка в очередь kb_file_purge
--    (новая колонка folder).
-- 3) kb_authors — авторы всех шаблонов (редактору базы; страница шаблонов
--    показывает, кто правил).

-- Редактор хоть одной базы (или владелец) — для политик, один вызов на запрос.
create or replace function public.auth_kb_is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select cardinality(public.auth_kb_edit_base_ids()) > 0
$$;
revoke all on function public.auth_kb_is_editor() from public, anon;
grant execute on function public.auth_kb_is_editor() to authenticated, service_role;

-- 1) Шаблоны без базы ------------------------------------------------------------
drop policy if exists "kb_templates editor" on public.kb_templates;
drop index if exists public.kb_templates_base_idx;
alter table public.kb_templates drop column if exists base_id;

create or replace function public.kb_templates_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

create policy "kb_templates editor" on public.kb_templates
  for all to authenticated
  using ((select public.auth_kb_is_editor()))
  with check ((select public.auth_kb_is_editor()));

-- 2) Файлы шаблонов ----------------------------------------------------------------
alter table public.kb_file_purge alter column base_id drop not null;
alter table public.kb_file_purge add column if not exists folder text;

create or replace function public.kb_templates_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kb_file_purge (folder) values ('templates/' || old.id);
  return old;
end;
$$;
drop trigger if exists kb_templates_ad on public.kb_templates;
create trigger kb_templates_ad
  after delete on public.kb_templates
  for each row execute function public.kb_templates_ad();

drop policy if exists "kb-media templates read" on storage.objects;
create policy "kb-media templates read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'templates'
    and (select public.auth_kb_is_editor())
  );

drop policy if exists "kb-media templates insert" on storage.objects;
create policy "kb-media templates insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'templates'
    and (select public.auth_kb_is_editor())
  );

drop policy if exists "kb-media templates update" on storage.objects;
create policy "kb-media templates update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'templates'
    and (select public.auth_kb_is_editor())
  )
  with check (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'templates'
    and (select public.auth_kb_is_editor())
  );

drop policy if exists "kb-media templates delete" on storage.objects;
create policy "kb-media templates delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'kb-media'
    and (storage.foldername(name))[1] = 'templates'
    and (select public.auth_kb_is_editor())
  );

-- 3) Имена авторов: шаблоны общие — их авторы видны редактору базы.
create or replace function public.kb_authors(p_base uuid)
returns table (user_id uuid, full_name text)
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
  select p.id, p.full_name
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
