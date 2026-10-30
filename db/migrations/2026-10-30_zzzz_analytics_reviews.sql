-- «Аналитика» → «Отзывы» (2026-10-30, ANALYTICS.md): их reviews.py и
-- страницы /reviews/* — оценки занятий из выгрузки 1С (загрузка, статистика
-- клиентов по городу и периоду) и отзывы партнёров о сотрудниках по
-- постоянным ссылкам (публичная форма /analytics-feedback/<токен>,
-- статистика сотрудников). Их особенности — как есть: удаление загрузки не
-- удаляет её строки (у них ON DELETE CASCADE не срабатывал — внешние ключи
-- SQLite выключены), сотрудник с правом «Отзывы» без городов партнёра видит
-- пустую страницу, колонка «NPS» статистики сотрудников — средняя из 5.
-- Город строки — по студии: её ключ (без регистра, знаков и пробелов, ё = е)
-- ищется среди открытых студий справочника «Студии» «Обработки 1С» (их
-- studios_reference.json собирал sync_dashboards.py из studios_unique.xlsx:
-- статус «Открыта», город и студия непустые).
-- Таблицы закрыты браузеру, всё — через RPC.

-- 1) Оценки занятий ------------------------------------------------------------

create table if not exists public.an_rv_uploads (
  id bigint generated always as identity primary key,
  filename text not null check (char_length(filename) <= 300),
  imported_by uuid references auth.users(id) on delete set null,
  imported_by_name text not null default '',
  imported_at timestamptz not null default now(),
  row_count integer not null default 0,
  period_from text not null default '',
  period_to text not null default ''
);

-- Их review_rows. upload_id — без внешнего ключа: строки остаются и после
-- удаления загрузки. Даты — текстом, как у них (ISO, если 1С дала дату в
-- известном виде, иначе как есть).
create table if not exists public.an_rv_rows (
  id bigint generated always as identity primary key,
  upload_id bigint not null,
  client_name text not null,
  studio text not null,
  studio_key text not null,
  client_group text not null default '',
  age text not null default '',
  gender text not null default '',
  service text not null default '',
  class_date text not null,
  class_time text not null default '',
  trainer text not null default '',
  rating_date text not null,
  rating double precision not null check (rating >= 0 and rating <= 5),
  comment text not null default '',
  source_hash text not null unique
);
create index if not exists an_rv_rows_rating_date on public.an_rv_rows (rating_date);
create index if not exists an_rv_rows_studio_key on public.an_rv_rows (studio_key);

-- 2) Отзывы партнёров о сотрудниках ---------------------------------------------

create table if not exists public.an_rv_staff_links (
  id bigint generated always as identity primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  token text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.an_rv_staff_responses (
  id bigint generated always as identity primary key,
  link_id bigint not null references public.an_rv_staff_links(id) on delete cascade,
  rating integer not null check (rating between 1 and 10),
  comment text not null default '',
  partner_name text not null default '',
  partner_city text not null default '',
  professionalism_rating integer not null default 0 check (professionalism_rating between 0 and 5),
  professionalism_comment text not null default '',
  next_steps_rating integer not null default 0 check (next_steps_rating between 0 and 5),
  next_steps_comment text not null default '',
  submitted_at timestamptz not null default now()
);
create index if not exists an_rv_staff_responses_link_date
  on public.an_rv_staff_responses (link_id, submitted_at);

alter table public.an_rv_uploads enable row level security;
alter table public.an_rv_rows enable row level security;
alter table public.an_rv_staff_links enable row level security;
alter table public.an_rv_staff_responses enable row level security;
revoke all on public.an_rv_uploads, public.an_rv_rows, public.an_rv_staff_links,
  public.an_rv_staff_responses from anon, authenticated;

-- 3) Общее ---------------------------------------------------------------------------

-- Их _studio_key: casefold, ё → е, только буквы и цифры.
create or replace function public.an_rv_studio_key(p text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
    translate(lower(coalesce(p, '')),
      'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯё',
      'абвгдеежзийклмнопрстуфхцчшщъыьэюяе'),
    '[^0-9a-zа-я]', '', 'g')
$$;

-- casefold для сортировки «без регистра» (их .casefold()).
create or replace function public.an_rv_fold(p text)
returns text
language sql
immutable
parallel safe
as $$
  select translate(lower(coalesce(p, '')),
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')
$$;

-- Их display_trainer: без пометок в скобках, «Не указан» вместо пустого.
create or replace function public.an_rv_trainer(p text)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(nullif(btrim(regexp_replace(
    regexp_replace(coalesce(p, ''), '\s*\([^()]*\)', '', 'g'), '\s+', ' ', 'g')), ''), 'Не указан')
$$;

-- Их _city_by_studio: ключ студии → город. Студия в двух городах — у них
-- побеждал последний по алфавиту город (словарь заполнялся по порядку).
create or replace function public.an_rv_city_map()
returns table (studio_key text, city text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (k.key) k.key, k.city
    from (select public.an_rv_studio_key(btrim(s.studio)) as key, btrim(s.city) as city
            from public.an_onec_studios s
           where btrim(coalesce(s.status, '')) = 'Открыта'
             and btrim(coalesce(s.city, '')) <> '' and btrim(coalesce(s.studio, '')) <> '') k
   where k.key <> ''
   order by k.key, k.city collate "C" desc
$$;
revoke all on function public.an_rv_city_map() from public, anon, authenticated;

-- Право на «Отзывы и оценки» (их can_access_dashboard(user, 'reviews')).
create or replace function public.an_rv_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me jsonb := public.an_me_for(auth.uid());
begin
  if v_me is null or not (coalesce((v_me->>'admin')::boolean, false)
                          or coalesce(v_me->'reports', '[]') ? 'reviews') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  return v_me;
end;
$$;
revoke all on function public.an_rv_me() from public, anon, authenticated;

-- Их выбор городов: администратору — города, где есть оценки; партнёру —
-- его города; остальным — ничего (у них сотрудник видел пустую страницу).
create or replace function public.an_rv_allowed_cities(p_me jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cities text[];
begin
  if coalesce((p_me->>'admin')::boolean, false) then
    with recursive k as (
      (select r.studio_key from public.an_rv_rows r order by r.studio_key limit 1)
      union all
      select (select r.studio_key from public.an_rv_rows r
               where r.studio_key > k.studio_key order by r.studio_key limit 1)
        from k where k.studio_key is not null
    )
    select coalesce(array_agg(c order by c collate "C"), '{}') into v_cities
      from (select distinct m.city as c
              from k join public.an_rv_city_map() m on m.studio_key = k.studio_key) x;
    return v_cities;
  end if;
  if jsonb_typeof(p_me->'partner_cities') = 'array' then
    select coalesce(array_agg(c order by c collate "C"), '{}') into v_cities
      from (select distinct c from jsonb_array_elements_text(p_me->'partner_cities') c) x;
    return v_cities;
  end if;
  return '{}';
end;
$$;
revoke all on function public.an_rv_allowed_cities(jsonb) from public, anon, authenticated;

-- 4) Статистика клиентов (их reviews_page + report) ------------------------------------

-- Город — из разрешённых (не тот — первый разрешённый), период — строки
-- ГГГГ-ММ-ДД; отчёт — только с городом. Каждый вызов — «просмотр
-- дашборда» в журнале, как их GET.
create or replace function public.an_rv_report(p_city text, p_from text, p_to text)
returns jsonb
language plpgsql
security definer
set search_path = public
set jit = off
as $$
declare
  v_me jsonb := public.an_rv_me();
  v_cities text[] := public.an_rv_allowed_cities(v_me);
  v_city text;
  v_report jsonb;
begin
  if p_from is null or p_to is null or p_from !~ '^\d{4}-\d{2}-\d{2}$' or p_to !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Неверный период' using errcode = '22023';
  end if;
  v_city := case when p_city = any (v_cities) then p_city else v_cities[1] end;
  perform public.an_audit_add(auth.uid(), 'dashboard_view', 'Отзывы и оценки');
  if v_city is null then
    return jsonb_build_object('cities', to_jsonb(v_cities), 'city', '', 'report', null);
  end if;

  with r as materialized (
    select r.*
      from public.an_rv_rows r
      join public.an_rv_city_map() m on m.studio_key = r.studio_key and m.city = v_city
     where r.rating_date >= p_from and r.rating_date <= p_to
  )
  select jsonb_build_object(
    'total', (select count(*) from r),
    'period_from', (select min(rating_date) from r),
    'period_to', (select max(rating_date) from r),
    'average', coalesce((select avg(rating) from r), 0),
    'negative', (select count(*) from r where rating <= 3),
    'ratings', coalesce((select jsonb_agg(jsonb_build_object('rating', rating, 'count', n) order by rating desc)
                           from (select rating, count(*) as n from r group by rating) x), '[]'),
    'trainers', coalesce((
      select jsonb_agg(jsonb_build_object('trainer', t, 'count', n, 'average', a,
                                          'negative', neg, 'comments', c)
                       order by a, n desc, public.an_rv_fold(t) collate "C")
        from (select public.an_rv_trainer(trainer) as t, count(*) as n, avg(rating) as a,
                     count(*) filter (where rating <= 3) as neg,
                     count(*) filter (where comment <> '') as c
                from r group by 1) x), '[]'),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'client_name', client_name, 'studio', studio,
                                          'rating', rating, 'comment', comment,
                                          'trainer', public.an_rv_trainer(trainer),
                                          'service', service, 'rating_date', rating_date)
                       order by rating, rating_date, public.an_rv_fold(client_name) collate "C", id)
        from r where comment <> ''), '[]'))
    into v_report;

  return jsonb_build_object('cities', to_jsonb(v_cities), 'city', v_city, 'report', v_report);
end;
$$;
revoke all on function public.an_rv_report(text, text, text) from public, anon;
grant execute on function public.an_rv_report(text, text, text) to authenticated;

-- 5) Загрузка выгрузки (администратору аналитики) ------------------------------------

-- Их «История загрузок»: новые сверху.
create or replace function public.an_rv_uploads()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'filename', u.filename,
             'imported_by', u.imported_by_name, 'imported_at', u.imported_at,
             'row_count', u.row_count, 'period_from', u.period_from, 'period_to', u.period_to)
           order by u.imported_at desc, u.id desc)
      from public.an_rv_uploads u), '[]');
end;
$$;
revoke all on function public.an_rv_uploads() from public, anon;
grant execute on function public.an_rv_uploads() to authenticated;

-- Их import_reviews: сначала запись загрузки (файл разобран браузером и
-- проверен их правилами), затем строки пачками, затем итог.
create or replace function public.an_rv_import_start(p_filename text, p_period_from text, p_period_to text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform public.an_require_admin();
  insert into public.an_rv_uploads (filename, imported_by, imported_by_name, period_from, period_to)
  values (left(coalesce(p_filename, ''), 300), auth.uid(),
          coalesce((public.an_person_json(auth.uid()))->>'full_name', ''),
          left(coalesce(p_period_from, ''), 50), left(coalesce(p_period_to, ''), 50))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.an_rv_import_start(text, text, text) from public, anon;
grant execute on function public.an_rv_import_start(text, text, text) to authenticated;

-- Пачка строк (до 5000): совпадающие с уже загруженными (source_hash) не
-- добавляются. Возвращает, сколько добавлено.
create or replace function public.an_rv_import_rows(p_upload bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added integer;
begin
  perform public.an_require_admin();
  if not exists (select 1 from public.an_rv_uploads where id = p_upload) then
    raise exception 'Загрузка не найдена' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Неверная пачка строк' using errcode = '22023';
  end if;
  insert into public.an_rv_rows (upload_id, client_name, studio, studio_key, client_group, age, gender,
                                 service, class_date, class_time, trainer, rating_date, rating, comment,
                                 source_hash)
  select p_upload, x.client_name, x.studio, public.an_rv_studio_key(x.studio),
         coalesce(x.client_group, ''), coalesce(x.age, ''), coalesce(x.gender, ''),
         coalesce(x.service, ''), x.class_date, coalesce(x.class_time, ''), coalesce(x.trainer, ''),
         x.rating_date, x.rating, coalesce(x.comment, ''), x.source_hash
    from jsonb_to_recordset(p_rows) as x(client_name text, studio text, client_group text, age text,
         gender text, service text, class_date text, class_time text, trainer text, rating_date text,
         rating double precision, comment text, source_hash text)
   where x.source_hash ~ '^[0-9a-f]{64}$'
  on conflict (source_hash) do nothing;
  get diagnostics v_added = row_count;
  update public.an_rv_uploads set row_count = row_count + v_added where id = p_upload;
  return v_added;
end;
$$;
revoke all on function public.an_rv_import_rows(bigint, jsonb) from public, anon;
grant execute on function public.an_rv_import_rows(bigint, jsonb) to authenticated;

-- Итог загрузки: добавлено и повторы (всего строк файла − добавлено); в журнал.
create or replace function public.an_rv_import_finish(p_upload bigint, p_total integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upload public.an_rv_uploads;
begin
  perform public.an_require_admin();
  select * into v_upload from public.an_rv_uploads where id = p_upload;
  if not found then
    raise exception 'Загрузка не найдена' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'reviews_imported',
    v_upload.row_count || ' новых строк: ' || v_upload.filename);
  return jsonb_build_object('id', v_upload.id, 'rows', v_upload.row_count,
    'duplicates', greatest(coalesce(p_total, 0) - v_upload.row_count, 0),
    'period_from', v_upload.period_from, 'period_to', v_upload.period_to);
end;
$$;
revoke all on function public.an_rv_import_finish(bigint, integer) from public, anon;
grant execute on function public.an_rv_import_finish(bigint, integer) to authenticated;

-- Их delete_upload: удаляется только запись загрузки — строки остаются.
create or replace function public.an_rv_upload_delete(p_upload bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  delete from public.an_rv_uploads where id = p_upload;
  perform public.an_audit_add(auth.uid(), 'reviews_upload_deleted', p_upload::text);
end;
$$;
revoke all on function public.an_rv_upload_delete(bigint) from public, anon;
grant execute on function public.an_rv_upload_delete(bigint) to authenticated;

-- 6) Ссылки на отзывы сотрудников (администратору аналитики) ------------------------------

-- Сотрудники — действующие люди портала, кроме партнёров (у них — все
-- активные пользователи портала аналитики, кроме партнёров).
create or replace function public.an_rv_employees()
returns table (user_id uuid, full_name text, position_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, coalesce(nullif(btrim(p.full_name), ''), u.email::text, ''), pos.name
    from public.portal_people_ids() x(id)
    join auth.users u on u.id = x.id
    left join public.profiles p on p.id = u.id
    left join public.portal_users pu on pu.user_id = u.id
    left join public.org_positions pos on pos.id = pu.position_id
   where not exists (select 1 from public.an_partner_cities c where c.user_id = u.id)
$$;
revoke all on function public.an_rv_employees() from public, anon, authenticated;

create or replace function public.an_rv_staff_links()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.an_require_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', e.user_id, 'full_name', e.full_name, 'position', e.position_name,
           'link_id', l.id, 'token', l.token, 'is_active', l.is_active)
         order by lower(e.full_name) collate "C", e.user_id), '[]')
    into v_rows
    from public.an_rv_employees() e
    left join public.an_rv_staff_links l on l.user_id = e.user_id;
  perform public.an_audit_add(auth.uid(), 'staff_feedback_links_view', 'directory');
  return v_rows;
end;
$$;
revoke all on function public.an_rv_staff_links() from public, anon;
grant execute on function public.an_rv_staff_links() to authenticated;

-- Их ensure_staff_feedback_link: одна постоянная ссылка на сотрудника.
create or replace function public.an_rv_staff_link_create(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  perform public.an_require_admin();
  select e.full_name into v_name from public.an_rv_employees() e where e.user_id = p_user;
  if not found then
    raise exception 'Выберите действующего сотрудника.' using errcode = '22023';
  end if;
  insert into public.an_rv_staff_links (user_id, token)
  values (p_user, translate(encode(decode(replace(gen_random_uuid()::text, '-', '')
                    || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_'))
  on conflict (user_id) do nothing;
  perform public.an_audit_add(auth.uid(), 'staff_feedback_link_created', p_user::text);
  return v_name;
end;
$$;
revoke all on function public.an_rv_staff_link_create(uuid) from public, anon;
grant execute on function public.an_rv_staff_link_create(uuid) to authenticated;

create or replace function public.an_rv_staff_link_set_active(p_link bigint, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  update public.an_rv_staff_links set is_active = coalesce(p_active, false), updated_at = now()
   where id = p_link;
  if not found then
    raise exception 'Не удалось изменить ссылку.' using errcode = 'P0002';
  end if;
  perform public.an_audit_add(auth.uid(), 'staff_feedback_link_updated',
    p_link || ': active=' || case when p_active then 1 else 0 end);
end;
$$;
revoke all on function public.an_rv_staff_link_set_active(bigint, boolean) from public, anon;
grant execute on function public.an_rv_staff_link_set_active(bigint, boolean) to authenticated;

-- 7) Публичная форма (без входа) -------------------------------------------------------

-- Их staff_feedback_link: действующая ссылка действующего сотрудника, не
-- партнёра.
create or replace function public.an_rv_link_by_token(p_token text)
returns table (link_id bigint, user_id uuid, full_name text, position_name text)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, e.user_id, e.full_name, e.position_name
    from public.an_rv_staff_links l
    join public.an_rv_employees() e on e.user_id = l.user_id
   where l.token = p_token and l.is_active and char_length(coalesce(p_token, '')) between 16 and 100
$$;
revoke all on function public.an_rv_link_by_token(text) from public, anon, authenticated;

create or replace function public.an_rv_feedback_form(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('full_name', full_name, 'position', position_name)
    from public.an_rv_link_by_token(p_token)
$$;
revoke all on function public.an_rv_feedback_form(text) from public;
grant execute on function public.an_rv_feedback_form(text) to anon, authenticated;

-- Их str.strip(): пробельные символы по краям.
create or replace function public.an_rv_strip(p text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(coalesce(p, ''), E' \t\n\r\u000b\u000c   　  ')
$$;

-- Их add_staff_feedback: те же проверки и тексты. Сверх их формы — не
-- больше 50 ответов по одной ссылке за час (форма открыта без входа).
create or replace function public.an_rv_feedback_submit(
  p_token text, p_partner_name text, p_partner_city text,
  p_professionalism_rating text, p_professionalism_comment text,
  p_next_steps_rating text, p_next_steps_comment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
  v_name text := public.an_rv_strip(p_partner_name);
  v_city text := public.an_rv_strip(p_partner_city);
  v_prof_text text := public.an_rv_strip(p_professionalism_comment);
  v_next_text text := public.an_rv_strip(p_next_steps_comment);
  v_prof integer;
  v_next integer;
begin
  select * into v_link from public.an_rv_link_by_token(p_token);
  if not found then
    raise exception 'an_rv_link_gone' using errcode = 'P0002';
  end if;
  if v_name = '' then
    raise exception 'Укажите имя партнёра.' using errcode = '22023';
  end if;
  if v_city = '' then
    raise exception 'Укажите город.' using errcode = '22023';
  end if;
  if char_length(v_name) > 200 or char_length(v_city) > 200 then
    raise exception 'Имя партнёра и город не должны быть длиннее 200 символов.' using errcode = '22023';
  end if;
  if public.an_rv_strip(p_professionalism_rating) !~ '^[+-]?[0-9]{1,9}$'
     or public.an_rv_strip(p_next_steps_rating) !~ '^[+-]?[0-9]{1,9}$' then
    raise exception 'Поставьте оценку по каждому вопросу.' using errcode = '22023';
  end if;
  v_prof := public.an_rv_strip(p_professionalism_rating)::integer;
  v_next := public.an_rv_strip(p_next_steps_rating)::integer;
  if v_prof not between 1 and 5 or v_next not between 1 and 5 then
    raise exception 'Оценка по каждому вопросу должна быть от 1 до 5.' using errcode = '22023';
  end if;
  if v_prof <= 4 and v_prof_text = '' then
    raise exception 'Добавьте рекомендацию к первому вопросу.' using errcode = '22023';
  end if;
  if v_next <= 4 and v_next_text = '' then
    raise exception 'Добавьте рекомендацию ко второму вопросу.' using errcode = '22023';
  end if;
  if char_length(v_prof_text) > 4000 or char_length(v_next_text) > 4000 then
    raise exception 'Рекомендация не должна быть длиннее 4 000 символов.' using errcode = '22023';
  end if;
  if (select count(*) from public.an_rv_staff_responses
       where link_id = v_link.link_id and submitted_at > now() - interval '1 hour') >= 50 then
    raise exception 'Слишком много ответов по этой ссылке — попробуйте позже.' using errcode = '54000';
  end if;
  insert into public.an_rv_staff_responses (link_id, rating, comment, partner_name, partner_city,
    professionalism_rating, professionalism_comment, next_steps_rating, next_steps_comment)
  values (v_link.link_id, v_prof + v_next, '', v_name, v_city, v_prof, v_prof_text, v_next, v_next_text);
  return jsonb_build_object('full_name', v_link.full_name);
end;
$$;
revoke all on function public.an_rv_feedback_submit(text, text, text, text, text, text, text) from public;
grant execute on function public.an_rv_feedback_submit(text, text, text, text, text, text, text)
  to anon, authenticated;

-- 8) Статистика сотрудников (их staff_feedback_report; администратору) ------------------

-- Период — дни по Москве. Сотрудники — по имени (как у них), должность — из
-- последнего ответа; сначала с меньшей общей средней.
create or replace function public.an_rv_staff_report(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
begin
  perform public.an_require_admin();
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Неверный период' using errcode = '22023';
  end if;
  v_from := p_from::timestamp at time zone 'Europe/Moscow';
  v_to := (p_to + 1)::timestamp at time zone 'Europe/Moscow';
  with r as materialized (
    select s.*, e.full_name, e.position_name
      from public.an_rv_staff_responses s
      join public.an_rv_staff_links l on l.id = s.link_id
      join public.an_rv_employees() e on e.user_id = l.user_id
     where s.submitted_at >= v_from and s.submitted_at < v_to
  ), g as (
    select full_name, count(*) as n,
           (array_agg(position_name order by submitted_at desc, id desc))[1] as position_name,
           avg(professionalism_rating) as prof, avg(next_steps_rating) as next,
           (sum(professionalism_rating) + sum(next_steps_rating))::double precision / (count(*) * 2) as overall,
           sum((professionalism_comment <> '')::int + (next_steps_comment <> '')::int) as comments
      from r group by full_name
  )
  select jsonb_build_object(
    'total', (select count(*) from r),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('name', full_name,
        'position', coalesce(position_name, ''), 'count', n, 'professionalism_average', prof,
        'next_steps_average', next, 'overall_average', overall, 'comments', comments)
        order by overall, public.an_rv_fold(full_name) collate "C") from g), '[]'),
    'responses', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'full_name', full_name,
        'position', position_name, 'partner_name', partner_name, 'partner_city', partner_city,
        'professionalism_rating', professionalism_rating,
        'professionalism_comment', professionalism_comment,
        'next_steps_rating', next_steps_rating, 'next_steps_comment', next_steps_comment,
        'submitted_at', submitted_at)
        order by submitted_at desc, id desc) from r), '[]'))
    into v_result;
  perform public.an_audit_add(auth.uid(), 'staff_feedback_view', p_from || '..' || p_to);
  return v_result;
end;
$$;
revoke all on function public.an_rv_staff_report(date, date) from public, anon;
grant execute on function public.an_rv_staff_report(date, date) to authenticated;
