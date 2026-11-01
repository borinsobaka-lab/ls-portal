-- ============================================================================
-- «Сообщить об ошибке» (решение владельца 2026-11-01): плавающая кнопка внизу
-- справа во всех разделах портала. Сотрудник описывает, что не так, портал
-- сам добавляет страницу (путь и заголовок), версию портала, браузер и
-- размер окна. Разбирает суперадминистратор: «Управление» → «Сообщения об
-- ошибках» (право portal.admin), отметка «Исправлено».
--
-- Таблица закрыта браузеру: отправить — RPC portal_bug_report_submit (любой
-- человек портала, is_portal_user; не больше 20 сообщений в час), читать и
-- отмечать — portal_bug_reports_list / portal_bug_report_resolve /
-- portal_bug_report_delete / portal_bug_reports_open_count (portal.admin).
-- Идемпотентно.
-- ============================================================================

create table if not exists public.portal_bug_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  -- Снимок имени и почты: человек может уйти из портала, сообщение остаётся.
  author_name text,
  author_email text,
  page_path text not null,
  page_title text,
  message text not null,
  app_version text,
  user_agent text,
  viewport text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_by_name text,
  constraint portal_bug_reports_lengths_check check (
    char_length(page_path) between 1 and 2000
    and char_length(coalesce(page_title, '')) <= 300
    and char_length(message) between 1 and 5000
    and char_length(coalesce(app_version, '')) <= 40
    and char_length(coalesce(user_agent, '')) <= 1000
    and char_length(coalesce(viewport, '')) <= 40
  )
);

create index if not exists portal_bug_reports_created_idx
  on public.portal_bug_reports (created_at desc);
create index if not exists portal_bug_reports_user_created_idx
  on public.portal_bug_reports (user_id, created_at desc);

alter table public.portal_bug_reports enable row level security;
revoke all on public.portal_bug_reports from anon, authenticated;

-- Отправить сообщение — любой человек портала.
create or replace function public.portal_bug_report_submit(
  p_page_path text,
  p_page_title text,
  p_message text,
  p_app_version text default null,
  p_user_agent text default null,
  p_viewport text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_message text := btrim(coalesce(p_message, ''));
  v_id uuid;
begin
  if v_uid is null or not public.is_portal_user(v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_message = '' then
    raise exception 'bug_report_empty' using errcode = '22023';
  end if;
  if (select count(*) from public.portal_bug_reports
       where user_id = v_uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'bug_report_rate_limit' using errcode = '54000';
  end if;

  insert into public.portal_bug_reports (
    user_id, author_name, author_email, page_path, page_title, message,
    app_version, user_agent, viewport
  )
  select v_uid,
         nullif(btrim(p.full_name), ''),
         nullif(btrim(p.email), ''),
         left(coalesce(nullif(btrim(p_page_path), ''), '/'), 2000),
         left(nullif(btrim(p_page_title), ''), 300),
         left(v_message, 5000),
         left(nullif(btrim(p_app_version), ''), 40),
         left(nullif(btrim(p_user_agent), ''), 1000),
         left(nullif(btrim(p_viewport), ''), 40)
    from (select 1) one
    left join public.profiles p on p.id = v_uid
  returning id into v_id;
  return v_id;
end;
$$;

-- Список для суперадминистратора: p_status — 'open' / 'resolved' / null (все).
create or replace function public.portal_bug_reports_list(p_status text default null)
returns table (
  id uuid,
  user_id uuid,
  author_name text,
  author_email text,
  page_path text,
  page_title text,
  message text,
  app_version text,
  user_agent text,
  viewport text,
  created_at timestamptz,
  resolved_at timestamptz,
  resolved_by_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.access_has_right(auth.uid(), 'portal.admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select r.id, r.user_id, r.author_name, r.author_email, r.page_path, r.page_title,
           r.message, r.app_version, r.user_agent, r.viewport, r.created_at,
           r.resolved_at, r.resolved_by_name
      from public.portal_bug_reports r
     where p_status is null
        or (p_status = 'open' and r.resolved_at is null)
        or (p_status = 'resolved' and r.resolved_at is not null)
     order by (r.resolved_at is null) desc, r.created_at desc
     limit 1000;
end;
$$;

-- «Исправлено» / вернуть в работу.
create or replace function public.portal_bug_report_resolve(p_id uuid, p_resolved boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.access_has_right(v_uid, 'portal.admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.portal_bug_reports r
     set resolved_at = case when p_resolved then now() end,
         resolved_by = case when p_resolved then v_uid end,
         resolved_by_name = case when p_resolved
           then (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_uid)
         end
   where r.id = p_id;
end;
$$;

create or replace function public.portal_bug_report_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.access_has_right(auth.uid(), 'portal.admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.portal_bug_reports where id = p_id;
end;
$$;

-- Счётчик неразобранных у пункта меню; не суперадминистратору — 0.
create or replace function public.portal_bug_reports_open_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case when public.access_has_right(auth.uid(), 'portal.admin')
    then (select count(*)::int from public.portal_bug_reports where resolved_at is null)
    else 0 end
$$;

revoke all on function public.portal_bug_report_submit(text, text, text, text, text, text) from public, anon;
revoke all on function public.portal_bug_reports_list(text) from public, anon;
revoke all on function public.portal_bug_report_resolve(uuid, boolean) from public, anon;
revoke all on function public.portal_bug_report_delete(uuid) from public, anon;
revoke all on function public.portal_bug_reports_open_count() from public, anon;
grant execute on function public.portal_bug_report_submit(text, text, text, text, text, text) to authenticated;
grant execute on function public.portal_bug_reports_list(text) to authenticated;
grant execute on function public.portal_bug_report_resolve(uuid, boolean) to authenticated;
grant execute on function public.portal_bug_report_delete(uuid) to authenticated;
grant execute on function public.portal_bug_reports_open_count() to authenticated;
