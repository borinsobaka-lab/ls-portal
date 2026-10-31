-- ============================================================================
-- «Аналитика» → «Контент» (ANALYTICS.md, «Контент-план»; ANALYTICS_PLAN.md,
-- §8.10): контент-план — посты по локальному времени групп VK, подстановка
-- ссылок, картинки, публикация по расписанию — их content.py
-- (save_community, set_community_active, delete_community, create_post,
-- add_media, delete_post, list_posts, publish_target, publish_due_posts,
-- save_media_upload_token, verify_media_upload_access) и страницы
-- /admin/content, /admin/content/communities (app.py).
--
-- Их content_communities → an_content_communities (токен сообщества —
-- an_secrets kind 'vk_content', ref = id; технический токен пользователя VK
-- для картинок — kind 'vk_content', ref 'media'), content_posts,
-- content_post_targets (время — timestamptz), content_post_media (картинки
-- — закрытый бакет an-content, а не BLOB в базе; автор — человек портала).
-- Их OAuth-подключение VK для картинок (content_oauth_states, vk_oauth_app_id)
-- на странице не показывается — не переносится; разовая правка города
-- «Казань Стоблова» — данные их базы.
--
-- Только администратору аналитики. Публикует сервер портала (задача
-- «content_publish», внешняя — выключена, пока её не включат: старый портал
-- публикует те же посты). Идемпотентно.
-- ============================================================================

-- 1) Таблицы -------------------------------------------------------------------------

create table if not exists public.an_content_communities (
  id bigint generated always as identity primary key,
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  display_name text not null check (char_length(display_name) between 1 and 1000),
  city text not null check (char_length(city) between 1 and 1000),
  -- Их TEXT: цифры как ввели (до 20).
  vk_community_id text not null unique check (vk_community_id ~ '^[0-9]{1,20}$'),
  timezone text not null default 'Europe/Moscow',
  trial_link text not null default '',
  schedule_link text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists an_content_communities_brand_idx
  on public.an_content_communities (brand, is_active, city);

create table if not exists public.an_content_posts (
  id bigint generated always as identity primary key,
  brand text not null check (brand in ('Lady Stretch', 'Lady Jump')),
  title text not null default '',
  body text not null,
  publish_date text not null default '',
  publish_time text not null default '',
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text not null default '',
  publication_status text not null default 'pending',
  published_count integer not null default 0,
  error_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists an_content_posts_brand_time_idx
  on public.an_content_posts (brand, publish_date desc, publish_time desc);

create table if not exists public.an_content_post_targets (
  post_id bigint not null references public.an_content_posts(id) on delete cascade,
  community_id bigint not null references public.an_content_communities(id) on delete restrict,
  rendered_body text not null,
  scheduled_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'cancelled')),
  publication_status text not null default 'pending',
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  published_at timestamptz,
  vk_post_id text not null default '',
  vk_post_url text not null default '',
  error_text text not null default '',
  primary key (post_id, community_id)
);
create index if not exists an_content_targets_due_idx
  on public.an_content_post_targets (status, publication_status, scheduled_at);

create table if not exists public.an_content_post_media (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.an_content_posts(id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  sort_order integer not null,
  created_at timestamptz not null default now()
);

alter table public.an_content_communities enable row level security;
alter table public.an_content_posts enable row level security;
alter table public.an_content_post_targets enable row level security;
alter table public.an_content_post_media enable row level security;
revoke all on public.an_content_communities, public.an_content_posts, public.an_content_post_targets,
  public.an_content_post_media from public, anon, authenticated;
grant all on public.an_content_communities, public.an_content_posts, public.an_content_post_targets,
  public.an_content_post_media to service_role;

-- Картинки постов: <post-uuid>/<n>.<расширение>; только администратор аналитики.
insert into storage.buckets (id, name, public, file_size_limit)
values ('an-content', 'an-content', false, 25165824)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "an-content admin" on storage.objects;
create policy "an-content admin" on storage.objects
  for all to authenticated
  using (bucket_id = 'an-content' and (select public.an_is_admin(auth.uid())))
  with check (bucket_id = 'an-content' and (select public.an_is_admin(auth.uid())));

-- 2) Справочники ----------------------------------------------------------------------

-- Их TIMEZONES.
create or replace function public.an_content_timezones()
returns text[]
language sql
immutable
as $$
  select array['Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg',
               'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Barnaul', 'Asia/Krasnoyarsk',
               'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Kamchatka']
$$;

-- Их strip(): пробельные по краям.
create or replace function public.an_content_strip(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g')
$$;

-- Их порядок COLLATE NOCASE: латиница без регистра, остальное — по кодам.
create or replace function public.an_content_nocase(p text)
returns text
language sql
immutable
as $$
  select translate(p, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') collate "C"
$$;

-- 3) Группы и ссылки (администратор аналитики) ---------------------------------------

create or replace function public.an_content_communities()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return jsonb_build_object(
    'communities', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'brand', c.brand, 'display_name', c.display_name, 'city', c.city,
               'vk_community_id', c.vk_community_id, 'timezone', c.timezone,
               'trial_link', c.trial_link, 'schedule_link', c.schedule_link,
               'is_active', c.is_active,
               'has_token', exists (select 1 from public.an_secrets s
                                     where s.kind = 'vk_content' and s.ref = c.id::text and s.name = 'token'),
               'used', exists (select 1 from public.an_content_post_targets t where t.community_id = c.id))
             order by c.brand, public.an_content_nocase(c.city), public.an_content_nocase(c.display_name)), '[]')
        from public.an_content_communities c),
    'media_token', exists (select 1 from public.an_secrets s
                            where s.kind = 'vk_content' and s.ref = 'media' and s.name = 'user_token'));
end;
$$;
revoke all on function public.an_content_communities() from public, anon;
grant execute on function public.an_content_communities() to authenticated;

-- Их save_community: тот же ID VK — обновление; пустой токен — прежний.
create or replace function public.an_content_community_save(
  p_brand text, p_display_name text, p_city text, p_vk_community_id text, p_timezone text,
  p_trial_link text, p_schedule_link text, p_token_cipher text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := public.an_content_strip(p_display_name);
  v_city text := public.an_content_strip(p_city);
  v_vk text := regexp_replace(public.an_content_strip(p_vk_community_id), '^-+', '');
  v_trial text := public.an_content_strip(p_trial_link);
  v_schedule text := public.an_content_strip(p_schedule_link);
  v_m text[];
  v_id bigint;
begin
  perform public.an_require_admin();
  if coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Выберите направление Lady Stretch или Lady Jump.' using errcode = '22023';
  end if;
  if not (coalesce(p_timezone, '') = any (public.an_content_timezones())) then
    raise exception 'Выберите часовой пояс из списка.' using errcode = '22023';
  end if;
  v_m := regexp_match(v_vk, '(?:public|club)(\d+)(?:$|[/?#])', 'i');
  if v_m is not null then
    v_vk := v_m[1];
  end if;
  if v_vk !~ '^[0-9]{1,20}$' then
    raise exception 'Укажите числовой ID группы VK или ссылку вида vk.ru/public123456.' using errcode = '22023';
  end if;
  if v_name = '' or v_city = '' then
    raise exception 'Заполните название группы и город или студию.' using errcode = '22023';
  end if;
  if v_trial <> '' and v_trial !~* '^(https?://|vk\.cc/|vk\.me/)' then
    raise exception 'Ссылка на пробное должна начинаться с https://, vk.cc/ или vk.me/.' using errcode = '22023';
  end if;
  if v_schedule <> '' and v_schedule !~* '^(https?://|vk\.cc/|vk\.me/)' then
    raise exception 'Ссылка на расписание должна начинаться с https://, vk.cc/ или vk.me/.' using errcode = '22023';
  end if;
  if coalesce(p_token_cipher, '') <> '' and p_token_cipher !~ '^[A-Za-z0-9+/]{38,}={0,2}$' then
    raise exception 'Ключ не зашифрован — сохраните его через портал.' using errcode = '22023';
  end if;
  insert into public.an_content_communities as c
    (brand, display_name, city, vk_community_id, timezone, trial_link, schedule_link)
  values (p_brand, v_name, v_city, v_vk, p_timezone, v_trial, v_schedule)
  on conflict (vk_community_id) do update set
    brand = excluded.brand, display_name = excluded.display_name, city = excluded.city,
    timezone = excluded.timezone, trial_link = excluded.trial_link,
    schedule_link = excluded.schedule_link, updated_at = now()
  returning id into v_id;
  if coalesce(p_token_cipher, '') <> '' then
    insert into public.an_secrets (kind, ref, name, ciphertext, updated_at, updated_by)
    values ('vk_content', v_id::text, 'token', p_token_cipher, now(), auth.uid())
    on conflict (kind, ref, name) do update set
      ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  perform public.an_audit_add(auth.uid(), 'content_community_saved', v_id::text);
  return v_id;
end;
$$;
revoke all on function public.an_content_community_save(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.an_content_community_save(text, text, text, text, text, text, text, text) to authenticated;

-- Их «Отключить / Включить».
create or replace function public.an_content_community_toggle(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  update public.an_content_communities set is_active = not is_active, updated_at = now() where id = p_id;
  if not found then
    raise exception 'Группа не найдена.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'content_community_toggled', p_id::text);
end;
$$;
revoke all on function public.an_content_community_toggle(bigint) from public, anon;
grant execute on function public.an_content_community_toggle(bigint) to authenticated;

-- Их delete_community: группа из контент-плана не удаляется (история постов).
create or replace function public.an_content_community_delete(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if exists (select 1 from public.an_content_post_targets where community_id = p_id) then
    raise exception 'Эта группа уже есть в контент-плане. Отключите её, чтобы сохранить историю постов.'
      using errcode = '23503';
  end if;
  delete from public.an_content_communities where id = p_id;
  if not found then
    raise exception 'Группа не найдена.' using errcode = 'P0002';
  end if;
  delete from public.an_secrets where kind = 'vk_content' and ref = p_id::text;
  perform public.an_audit_add(auth.uid(), 'content_community_deleted', p_id::text);
end;
$$;
revoke all on function public.an_content_community_delete(bigint) from public, anon;
grant execute on function public.an_content_community_delete(bigint) to authenticated;

-- Их save_media_upload_token: технический токен пользователя VK для картинок.
create or replace function public.an_content_media_token_save(p_cipher text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if coalesce(p_cipher, '') !~ '^[A-Za-z0-9+/]{38,}={0,2}$' then
    raise exception 'Вставьте токен пользователя VK для загрузки картинок.' using errcode = '22023';
  end if;
  insert into public.an_secrets (kind, ref, name, ciphertext, updated_at, updated_by)
  values ('vk_content', 'media', 'user_token', p_cipher, now(), auth.uid())
  on conflict (kind, ref, name) do update set
    ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform public.an_audit_add(auth.uid(), 'content_media_upload_token_saved', 'updated');
end;
$$;
revoke all on function public.an_content_media_token_save(text) from public, anon;
grant execute on function public.an_content_media_token_save(text) to authenticated;

-- 4) Контент-план ------------------------------------------------------------------

-- Их list_posts + post_targets + post_media: лента, новые сверху.
create or replace function public.an_content_posts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id, 'brand', p.brand, 'title', p.title, 'body', p.body,
             'publish_date', p.publish_date, 'publish_time', p.publish_time,
             'publication_status', p.publication_status, 'created_by_name', p.created_by_name,
             'targets', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'community_id', t.community_id, 'display_name', c.display_name, 'city', c.city,
                        'timezone', c.timezone, 'scheduled_at', t.scheduled_at,
                        'publication_status', t.publication_status, 'vk_post_url', t.vk_post_url,
                        'error_text', t.error_text)
                      order by c.city, c.display_name), '[]')
                 from public.an_content_post_targets t
                 join public.an_content_communities c on c.id = t.community_id
                where t.post_id = p.id),
             'media', (
               select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'path', m.storage_path,
                        'name', m.original_name) order by m.sort_order, m.id), '[]')
                 from public.an_content_post_media m where m.post_id = p.id))
           order by p.publish_date desc, p.publish_time desc, p.id desc), '[]')
      from public.an_content_posts p);
end;
$$;
revoke all on function public.an_content_posts() from public, anon;
grant execute on function public.an_content_posts() to authenticated;

-- Их content_multipart_values (картинки) + create_post + add_media: картинки
-- уже в бакете (браузер загрузил), здесь — их проверки по метаданным файла,
-- затем пост и время публикации в каждой группе по её часовому поясу.
-- p_media — [{path, name}] по порядку.
create or replace function public.an_content_post_create(
  p_brand text, p_title text, p_body text, p_publish_date text, p_publish_time text,
  p_targets bigint[], p_media jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := public.an_content_strip(p_body);
  v_title text := public.an_content_strip(p_title);
  v_media jsonb := case when jsonb_typeof(p_media) = 'array' then p_media else '[]'::jsonb end;
  v_targets bigint[] := array(select distinct x from unnest(coalesce(p_targets, '{}')) x where x is not null order by x);
  v_local timestamp;
  v_missing text;
  v_post bigint;
  v_files record;
begin
  perform public.an_require_admin();
  -- Картинки: их проверки формы.
  if jsonb_array_length(v_media) > 10 then
    raise exception 'К одному посту можно прикрепить не больше 10 изображений.' using errcode = '22023';
  end if;
  select count(*) as n,
         count(o.id) as found,
         coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0) as total,
         bool_and(o.id is null or (
           coalesce(o.metadata->>'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
           and lower(substring(m.v->>'name' from '(\.[^./\\]*)$')) = any (
             case o.metadata->>'mimetype'
               when 'image/jpeg' then array['.jpg', '.jpeg']
               when 'image/png' then array['.png']
               when 'image/webp' then array['.webp']
               else array['.gif'] end))) as types_ok,
         bool_and(o.id is null or coalesce((o.metadata->>'size')::bigint, 0) > 0) as sizes_ok
    into v_files
    from jsonb_array_elements(v_media) m(v)
    left join storage.objects o on o.bucket_id = 'an-content' and o.name = m.v->>'path';
  if v_files.n > v_files.found then
    raise exception 'Не удалось прочитать форму или изображения. Максимальный общий размер — 24 МБ.'
      using errcode = '22023';
  end if;
  if v_files.total > 24 * 1024 * 1024 then
    raise exception 'Общий размер изображений не должен превышать 24 МБ.' using errcode = '22023';
  end if;
  if not coalesce(v_files.types_ok, true) then
    raise exception 'Можно прикрепить только изображения JPG, PNG, WEBP или GIF.' using errcode = '22023';
  end if;
  if not coalesce(v_files.sizes_ok, true) then
    raise exception 'Одно из изображений оказалось пустым.' using errcode = '22023';
  end if;
  -- Их create_post.
  if coalesce(p_brand, '') not in ('Lady Stretch', 'Lady Jump') then
    raise exception 'Выберите направление Lady Stretch или Lady Jump.' using errcode = '22023';
  end if;
  if v_body = '' then
    raise exception 'Введите текст поста.' using errcode = '22023';
  end if;
  if char_length(v_body) > 12000 then
    raise exception 'Текст поста слишком длинный.' using errcode = '22023';
  end if;
  if coalesce(p_publish_date, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_publish_time, '') !~ '^\d{2}:\d{2}$' then
    raise exception 'Укажите дату и время публикации.' using errcode = '22023';
  end if;
  begin
    v_local := to_timestamp(p_publish_date || ' ' || p_publish_time, 'YYYY-MM-DD HH24:MI')::timestamp;
    if to_char(v_local, 'YYYY-MM-DD HH24:MI') <> p_publish_date || ' ' || p_publish_time then
      raise exception 'bad';
    end if;
  exception when others then
    raise exception 'Дата или время публикации указаны неверно.' using errcode = '22023';
  end;
  if cardinality(v_targets) = 0 then
    raise exception 'Выберите хотя бы одну активную группу.' using errcode = '22023';
  end if;
  if (select count(*) from public.an_content_communities c
       where c.id = any (v_targets) and c.brand = p_brand and c.is_active) <> cardinality(v_targets) then
    raise exception 'Выберите только активные группы данного направления.' using errcode = '22023';
  end if;
  if position('{ссылка_на_пробное}' in v_body) > 0 then
    select string_agg(c.display_name, ', ' order by c.id) into v_missing
      from public.an_content_communities c where c.id = any (v_targets) and c.trial_link = '';
    if v_missing is not null then
      raise exception 'У групп не заполнена ссылка на пробное: %', v_missing using errcode = '22023';
    end if;
  end if;
  if position('{ссылка_на_расписание}' in v_body) > 0 then
    select string_agg(c.display_name, ', ' order by c.id) into v_missing
      from public.an_content_communities c where c.id = any (v_targets) and c.schedule_link = '';
    if v_missing is not null then
      raise exception 'У групп не заполнена ссылка на расписание: %', v_missing using errcode = '22023';
    end if;
  end if;
  insert into public.an_content_posts
    (brand, title, body, publish_date, publish_time, status, created_by, created_by_name)
  values (p_brand, v_title, v_body, p_publish_date, p_publish_time, 'scheduled', v_uid,
          coalesce((select nullif(btrim(full_name), '') from public.profiles where id = v_uid), ''))
  returning id into v_post;
  insert into public.an_content_post_targets (post_id, community_id, rendered_body, scheduled_at, status)
  select v_post, c.id,
         replace(replace(v_body, '{ссылка_на_пробное}', c.trial_link), '{ссылка_на_расписание}', c.schedule_link),
         v_local at time zone c.timezone, 'scheduled'
    from public.an_content_communities c where c.id = any (v_targets);
  insert into public.an_content_post_media (post_id, storage_path, original_name, mime_type, size_bytes, sort_order)
  select v_post, m.v->>'path', coalesce(m.v->>'name', ''), coalesce(o.metadata->>'mimetype', ''),
         coalesce((o.metadata->>'size')::bigint, 0), (m.o - 1)::integer
    from jsonb_array_elements(v_media) with ordinality m(v, o)
    join storage.objects o on o.bucket_id = 'an-content' and o.name = m.v->>'path';
  perform public.an_audit_add(v_uid, 'content_post_created', v_post::text);
  return v_post;
end;
$$;
revoke all on function public.an_content_post_create(text, text, text, text, text, bigint[], jsonb) from public, anon;
grant execute on function public.an_content_post_create(text, text, text, text, text, bigint[], jsonb) to authenticated;

-- Их delete_post: пост уходит из очереди (опубликованное в VK остаётся);
-- возвращает пути картинок — их стирает браузер.
create or replace function public.an_content_post_delete(p_id bigint)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paths text[];
begin
  perform public.an_require_admin();
  v_paths := array(select storage_path from public.an_content_post_media where post_id = p_id);
  delete from public.an_content_posts where id = p_id;
  if not found then
    raise exception 'Пост в контент-плане не найден.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'content_post_deleted', p_id::text);
  return v_paths;
end;
$$;
revoke all on function public.an_content_post_delete(bigint) from public, anon;
grant execute on function public.an_content_post_delete(bigint) to authenticated;

-- 5) Публикация (сервер портала, service_role) -------------------------------------

-- Их publish_due_posts (выборка): пора, не опубликовано, не чаще раза в 5
-- минут, до 5 попыток.
create or replace function public.an_content_due()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('post_id', t.post_id, 'community_id', t.community_id)
           order by t.scheduled_at, t.post_id, t.community_id), '[]')
    from public.an_content_post_targets t
   where t.status = 'scheduled' and t.publication_status in ('pending', 'error')
     and t.scheduled_at <= now()
     and (t.last_attempt_at is null or t.last_attempt_at < now() - interval '300 seconds')
     and t.attempt_count < 5
$$;
revoke all on function public.an_content_due() from public, anon, authenticated;
grant execute on function public.an_content_due() to service_role;

-- Их publish_target (чтение): публикация группы с картинками поста.
create or replace function public.an_content_target(p_post bigint, p_community bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'post_id', t.post_id, 'community_id', t.community_id, 'rendered_body', t.rendered_body,
    'scheduled_at', extract(epoch from t.scheduled_at), 'status', t.status,
    'publication_status', t.publication_status, 'vk_post_url', t.vk_post_url,
    'vk_community_id', c.vk_community_id, 'display_name', c.display_name,
    'media', (select coalesce(jsonb_agg(jsonb_build_object('path', m.storage_path, 'name', m.original_name,
                                 'mime', m.mime_type) order by m.sort_order, m.id), '[]')
                from public.an_content_post_media m where m.post_id = t.post_id))
    from public.an_content_post_targets t
    join public.an_content_communities c on c.id = t.community_id
   where t.post_id = p_post and t.community_id = p_community
$$;
revoke all on function public.an_content_target(bigint, bigint) from public, anon, authenticated;
grant execute on function public.an_content_target(bigint, bigint) to service_role;

-- Их итог publish_target и _refresh_post_status.
create or replace function public.an_content_target_result(
  p_post bigint, p_community bigint, p_ok boolean, p_vk_post_id text, p_url text, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_published integer;
  v_errors integer;
  v_total integer;
begin
  if p_ok then
    update public.an_content_post_targets
       set publication_status = 'published', published_at = now(), vk_post_id = p_vk_post_id,
           vk_post_url = p_url, error_text = '', last_attempt_at = now(), attempt_count = attempt_count + 1
     where post_id = p_post and community_id = p_community;
  else
    update public.an_content_post_targets
       set publication_status = 'error', error_text = left(coalesce(p_error, ''), 1000),
           last_attempt_at = now(), attempt_count = attempt_count + 1
     where post_id = p_post and community_id = p_community;
  end if;
  select count(*), count(*) filter (where publication_status = 'published'),
         count(*) filter (where publication_status = 'error')
    into v_total, v_published, v_errors
    from public.an_content_post_targets where post_id = p_post;
  update public.an_content_posts
     set publication_status = case when v_total > 0 and v_published = v_total then 'published'
                                   when v_published > 0 then 'partial'
                                   when v_errors > 0 then 'error' else 'pending' end,
         published_count = v_published, error_count = v_errors, updated_at = now()
   where id = p_post;
end;
$$;
revoke all on function public.an_content_target_result(bigint, bigint, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.an_content_target_result(bigint, bigint, boolean, text, text, text) to service_role;
