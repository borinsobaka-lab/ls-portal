-- ============================================================================
-- «Компания», этап 2 (TASKS_CHATS_PLAN.md, 3.7, 8.8, 2026-11-08): дни
-- рождения и отсутствия сотрудников.
--
-- День рождения — `people_birthdays` (человек × дата; год показывается
-- другим, только если человек разрешил — `show_year`). Отсутствия —
-- `people_absences` (отпуск, больничный, командировка, отгул, «нет на
-- месте»; с какого по какой день, до года; заметка видна только тем, кто
-- может править). Править чужое — `people_can_edit`: сам человек, его
-- руководитель или заместитель (подразделения выше — `task_led_user_ids`),
-- право `users.manage` или суперадминистратор. Видят все люди портала
-- (справочник компании).
--
-- Поздравление: в день рождения с 9:00 своего пояса коллегам по
-- подразделениям уведомление `company.birthday` (лента, без пуша по
-- умолчанию; один раз в год) — `people_birthday_tick` (только service_role,
-- сервер портала раз в минуту вместе с `task_tick`); журнал —
-- `people_birthday_log`. Актуальное определение `notif_default_push` — здесь.
--
-- RPC: `people_birthday_get` / `_save`, `people_birthdays_upcoming`,
-- `people_absences_list`, `people_absence_save` / `_delete`. Таблицы закрыты
-- браузеру. Идемпотентно.
-- ============================================================================

create table if not exists public.people_birthdays (
  user_id uuid primary key references auth.users (id) on delete cascade,
  birth_date date not null check (birth_date >= date '1900-01-01'),
  show_year boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.people_birthdays enable row level security;

create table if not exists public.people_absences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('vacation', 'sick', 'trip', 'dayoff', 'other')),
  starts_on date not null,
  ends_on date not null,
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint people_absences_dates_check check (ends_on >= starts_on and ends_on - starts_on <= 366)
);
create index if not exists people_absences_user_idx on public.people_absences (user_id, ends_on);
create index if not exists people_absences_dates_idx on public.people_absences (ends_on, starts_on);
alter table public.people_absences enable row level security;

create table if not exists public.people_birthday_log (
  recipient_id uuid not null references auth.users (id) on delete cascade,
  birthday_user_id uuid not null references auth.users (id) on delete cascade,
  year integer not null,
  primary key (recipient_id, birthday_user_id, year)
);
alter table public.people_birthday_log enable row level security;

-- Кто может править день рождения и отсутствия человека.
create or replace function public.people_can_edit(p_actor uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_actor is not null and (
    p_actor = p_user
    or p_user = any (public.task_led_user_ids(p_actor))
    or public.access_has_right(p_actor, 'users.manage')
    or public.access_has_right(p_actor, 'portal.admin'))
$$;

-- Ближайшая дата дня рождения (29 февраля в невисокосный год — 28-го).
create or replace function public.people_next_birthday(p_birth date, p_today date)
returns date
language plpgsql
immutable
as $$
declare
  y integer := extract(year from p_today)::int;
  d date;
begin
  for i in 0..1 loop
    begin
      d := make_date(y + i, extract(month from p_birth)::int, extract(day from p_birth)::int);
    exception when others then
      d := make_date(y + i, 2, 28);
    end;
    if d >= p_today then
      return d;
    end if;
  end loop;
  return d;
end;
$$;

create or replace function public.people_today(p_uid uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(
            (select s.timezone from public.portal_user_settings s where s.user_id = p_uid),
            'Europe/Moscow'))::date
$$;

create or replace function public.people_birthday_get(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  b public.people_birthdays;
  v_edit boolean := public.people_can_edit(v_uid, p_user);
begin
  select * into b from public.people_birthdays where user_id = p_user;
  return jsonb_build_object(
    'day', case when b.user_id is not null then to_char(b.birth_date, 'MM-DD') end,
    'year', case when b.user_id is not null and (b.show_year or v_edit)
                 then extract(year from b.birth_date)::int end,
    'show_year', coalesce(b.show_year, false),
    'can_edit', v_edit);
end;
$$;

create or replace function public.people_birthday_save(p_user uuid, p_date date, p_show_year boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if not public.people_can_edit(v_uid, p_user) then
    raise exception 'people_forbidden' using errcode = '42501';
  end if;
  if p_date is null then
    delete from public.people_birthdays where user_id = p_user;
    return;
  end if;
  if p_date < date '1900-01-01' or p_date > current_date then
    raise exception 'people_birthday_invalid' using errcode = '22023';
  end if;
  insert into public.people_birthdays (user_id, birth_date, show_year, updated_by)
  values (p_user, p_date, coalesce(p_show_year, false), v_uid)
  on conflict (user_id) do update
    set birth_date = excluded.birth_date, show_year = excluded.show_year,
        updated_by = v_uid, updated_at = now();
end;
$$;

-- Дни рождения людей портала на ближайшие p_days дней (сегодня — по поясу
-- того, кто смотрит).
create or replace function public.people_birthdays_upcoming(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_today date := public.people_today(v_uid);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', x.user_id, 'date', x.next_date,
             'age', case when x.show_year then extract(year from age(x.next_date, x.birth_date))::int end)
           order by x.next_date, x.user_id)
      from (select b.user_id, b.birth_date, b.show_year,
                   public.people_next_birthday(b.birth_date, v_today) as next_date
              from public.people_birthdays b
             where b.user_id in (select p from public.portal_people_ids() p)) x
     where x.next_date <= v_today + least(greatest(coalesce(p_days, 30), 0), 366)), '[]'::jsonb);
end;
$$;

create or replace function public.people_absences_list(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'people_absence_invalid' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'user_id', a.user_id, 'kind', a.kind,
             'starts_on', a.starts_on, 'ends_on', a.ends_on,
             'note', case when public.people_can_edit(v_uid, a.user_id) then a.note end,
             'can_edit', public.people_can_edit(v_uid, a.user_id))
           order by a.starts_on, a.ends_on, a.user_id)
      from public.people_absences a
     where a.ends_on >= p_from and a.starts_on <= p_to
       and a.user_id in (select p from public.portal_people_ids() p)), '[]'::jsonb);
end;
$$;

create or replace function public.people_absence_save(
  p_id uuid, p_user uuid, p_kind text, p_from date, p_to date, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_id uuid;
  v_owner uuid;
begin
  if p_id is not null then
    select user_id into v_owner from public.people_absences where id = p_id;
    if v_owner is null or not public.people_can_edit(v_uid, v_owner) then
      raise exception 'people_forbidden' using errcode = '42501';
    end if;
  end if;
  if not public.people_can_edit(v_uid, p_user) then
    raise exception 'people_forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('vacation', 'sick', 'trip', 'dayoff', 'other')
     or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'people_absence_invalid' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.people_absences (user_id, kind, starts_on, ends_on, note, created_by)
    values (p_user, p_kind, p_from, p_to, left(nullif(btrim(coalesce(p_note, '')), ''), 200), v_uid)
    returning id into v_id;
  else
    update public.people_absences
       set user_id = p_user, kind = p_kind, starts_on = p_from, ends_on = p_to,
           note = left(nullif(btrim(coalesce(p_note, '')), ''), 200)
     where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.people_absence_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_owner uuid;
begin
  select user_id into v_owner from public.people_absences where id = p_id;
  if v_owner is null then
    return;
  end if;
  if not public.people_can_edit(v_uid, v_owner) then
    raise exception 'people_forbidden' using errcode = '42501';
  end if;
  delete from public.people_absences where id = p_id;
end;
$$;

-- Поздравления: коллегам по подразделениям, с 9:00 их пояса, раз в год.
create or replace function public.people_birthday_tick(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select distinct c.user_id as recipient, b.user_id as hero, (p_now at time zone c.tz)::date as day
      from public.people_birthdays b
      join public.org_unit_members hm on hm.user_id = b.user_id
      join public.org_unit_members cm on cm.unit_id = hm.unit_id and cm.user_id <> b.user_id
      cross join lateral (
        select cm.user_id,
               coalesce((select s.timezone from public.portal_user_settings s where s.user_id = cm.user_id),
                        'Europe/Moscow') as tz) c
     where public.is_portal_user(b.user_id) and public.is_portal_user(c.user_id)
       and (p_now at time zone c.tz)::time >= time '09:00'
       and public.people_next_birthday(b.birth_date, (p_now at time zone c.tz)::date)
           = (p_now at time zone c.tz)::date
       and not exists (select 1 from public.people_birthday_log l
                        where l.recipient_id = c.user_id and l.birthday_user_id = b.user_id
                          and l.year = extract(year from (p_now at time zone c.tz))::int)
     limit 2000
  loop
    insert into public.people_birthday_log (recipient_id, birthday_user_id, year)
    values (r.recipient, r.hero, extract(year from r.day)::int)
    on conflict do nothing;
    perform public.notif_send(r.recipient, 'company.birthday', 'Сегодня день рождения',
      public.chat_display_name(r.hero) || ' — поздравьте коллегу', '/company/birthdays', r.hero, null);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Пуш по умолчанию: + без пуша `company.birthday`. Прежнее определение —
-- 2026-11-08_zz_tasks.sql; актуальное — здесь.
create or replace function public.notif_default_push(p_kind text)
returns boolean
language sql
immutable
as $$
  select p_kind not in ('chat.group', 'task.done', 'task.accepted', 'task.deadline', 'company.birthday')
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.people_can_edit(uuid, uuid)',
    'public.people_today(uuid)',
    'public.people_birthday_tick(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.people_birthday_get(uuid)',
    'public.people_birthday_save(uuid, date, boolean)',
    'public.people_birthdays_upcoming(integer)',
    'public.people_absences_list(date, date)',
    'public.people_absence_save(uuid, uuid, text, date, date, text)',
    'public.people_absence_delete(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
