-- ============================================================================
-- Календарь портала (TASKS_CHATS_PLAN.md, этап 2, раздел 4 брифа;
-- 2026-11-08). Синхронизации с Google нет (решение владельца 2026-11-08).
--
-- Календари `cal_calendars`: личный (`personal`, у каждого один, заводится
-- при первом открытии; видит только владелец) и общие (`shared`: компании,
-- отдела, проекта, тематические). Кто видит и правит общий —
-- `cal_calendar_access`: вся компания (право `calendar.company`, новое,
-- «Управление порталом»), подразделение — все или руководители, с
-- подразделениями ниже или без (`calendar.company` или руководитель /
-- заместитель этого подразделения или выше), участники проекта (участник
-- проекта), сотрудник; уровень `view` — смотрит, `edit` — добавляет и
-- правит события, `manage` — и настройки календаря. Владелец общего —
-- `manage`. Уровень человека — `cal_level`.
--
-- События `cal_events`: время `starts_at` / `ends_at` (весь день —
-- полночь в поясе события `tz` и полночь дня после последнего), место,
-- описание, «Видеовстреча» (`video`: «Подключиться» — звонок Kinescope в
-- чате события), напоминания `reminders` (минут до начала; у события на
-- весь день — до полуночи дня, отрицательное — после неё: −540 = в 9:00).
-- Повтор `rrule` ({freq: daily / workdays / weekly / monthly / yearly,
-- interval, weekdays, until}) считается в поясе события (`cal_occurrences`),
-- отменённые повторения — `exdates`, изменённое одно повторение — отдельная
-- строка с `series_id` и `original_start` (его время — в `exdates` серии).
-- Видят событие те, кто видит календарь, и участники; правят — `edit` и
-- выше в календаре и организатор.
--
-- Участники `cal_attendees` (ответ pending / accepted / declined / maybe,
-- свои напоминания). Уведомления: `cal.invite` (приглашение), `cal.change`
-- (перенесено, отменено, убрали), `cal.reply` (ответ участника — без пуша
-- по умолчанию), `cal.remind` (напоминание; `cal_tick` — только
-- service_role, сервер портала раз в минуту вместе с `task_tick`, журнал —
-- `cal_reminder_log`). Обсуждение и звонок — чат события
-- (`chat_chats.kind = 'event'`, по кнопке — `cal_event_chat_open`, состав =
-- участники). Слои календаря — `cal_overlays`: сроки моих задач, дни
-- рождения и отсутствия коллег (подразделения и подчинённые).
--
-- Актуальные определения `notif_default_push`, `chat_notify_message` —
-- здесь. Все таблицы закрыты браузеру, только RPC `cal_*`. Идемпотентно.
-- ============================================================================

-- 1. Право ----------------------------------------------------------------------

insert into public.access_permissions (key, block, label, hint, scope, levels, target, sort_order) values
  ('calendar.company', 'admin', 'Календари компании',
   'Открывает общие календари всей компании и любому подразделению (планёрки, акции, маркетинг).',
   'network', '{on}', null, 347)
on conflict (key) do update
  set block = excluded.block, label = excluded.label, hint = excluded.hint, scope = excluded.scope,
      levels = excluded.levels, target = excluded.target, sort_order = excluded.sort_order;

create or replace function public.cal_can_company(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.access_has_right(p_uid, 'calendar.company') or public.access_has_right(p_uid, 'portal.admin')
$$;

-- 2. Таблицы -------------------------------------------------------------------------

create table if not exists public.cal_calendars (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal', 'shared')),
  owner_id uuid references auth.users (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  color text not null default 'blue'
    check (color in ('blue', 'sky', 'teal', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'purple', 'violet', 'gray')),
  description text check (description is null or char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cal_calendars_personal_uidx on public.cal_calendars (owner_id)
  where kind = 'personal';
alter table public.cal_calendars enable row level security;

create table if not exists public.cal_calendar_access (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.cal_calendars (id) on delete cascade,
  subject text not null check (subject in ('all', 'unit', 'user', 'project')),
  unit_id uuid references public.org_units (id) on delete cascade,
  unit_scope text not null default 'all' check (unit_scope in ('all', 'heads')),
  with_subunits boolean not null default true,
  user_id uuid references auth.users (id) on delete cascade,
  project_id uuid references public.task_projects (id) on delete cascade,
  level text not null default 'view' check (level in ('view', 'edit', 'manage')),
  constraint cal_calendar_access_target_check check (
    (subject = 'all' and unit_id is null and user_id is null and project_id is null)
    or (subject = 'unit' and unit_id is not null and user_id is null and project_id is null)
    or (subject = 'user' and user_id is not null and unit_id is null and project_id is null)
    or (subject = 'project' and project_id is not null and unit_id is null and user_id is null))
);
create index if not exists cal_calendar_access_cal_idx on public.cal_calendar_access (calendar_id);
create index if not exists cal_calendar_access_user_idx on public.cal_calendar_access (user_id) where user_id is not null;
alter table public.cal_calendar_access enable row level security;

create table if not exists public.cal_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.cal_calendars (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 5000),
  location text check (location is null or char_length(location) <= 300),
  all_day boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  tz text not null default 'Europe/Moscow',
  rrule jsonb,
  exdates timestamptz[] not null default '{}',
  series_id uuid references public.cal_events (id) on delete cascade,
  original_start timestamptz,
  video boolean not null default false,
  reminders integer[] not null default '{15}',
  organizer_id uuid references auth.users (id) on delete set null,
  chat_id uuid references public.chat_chats (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cal_events_time_check check (ends_at >= starts_at and ends_at - starts_at <= interval '366 days'),
  constraint cal_events_series_check check (series_id is null or (rrule is null and original_start is not null))
);
create index if not exists cal_events_cal_idx on public.cal_events (calendar_id, starts_at);
create index if not exists cal_events_starts_idx on public.cal_events (starts_at);
create index if not exists cal_events_series_idx on public.cal_events (series_id) where series_id is not null;
create index if not exists cal_events_recurring_idx on public.cal_events (calendar_id) where rrule is not null;
alter table public.cal_events enable row level security;

create table if not exists public.cal_attendees (
  event_id uuid not null references public.cal_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  response text not null default 'pending' check (response in ('pending', 'accepted', 'declined', 'maybe')),
  responded_at timestamptz,
  reminders integer[],
  added_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists cal_attendees_user_idx on public.cal_attendees (user_id, response);
alter table public.cal_attendees enable row level security;

create table if not exists public.cal_reminder_log (
  event_id uuid not null references public.cal_events (id) on delete cascade,
  occ_start timestamptz not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  minutes integer not null,
  sent_at timestamptz not null default now(),
  primary key (event_id, occ_start, user_id, minutes)
);
create index if not exists cal_reminder_log_sent_idx on public.cal_reminder_log (sent_at);
alter table public.cal_reminder_log enable row level security;

-- Личный календарь без владельца (учётная запись удалена) — не нужен.
create or replace function public.cal_calendars_orphan_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'personal' and new.owner_id is null then
    delete from public.cal_calendars where id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists cal_calendars_orphan_au on public.cal_calendars;
create trigger cal_calendars_orphan_au
  after update of owner_id on public.cal_calendars
  for each row execute function public.cal_calendars_orphan_au();

-- 3. Чат события ---------------------------------------------------------------------

alter table public.chat_chats drop constraint if exists chat_chats_kind_check;
alter table public.chat_chats add constraint chat_chats_kind_check
  check (kind in ('direct', 'group', 'self', 'task', 'project', 'event'));

-- Удалённое событие уносит свой чат (файлы — очередь уборки чатов).
create or replace function public.cal_events_cleanup_ad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.notif_items where group_key = 'cal:' || old.id::text;
  if old.chat_id is not null then
    perform public.chat_broadcast(old.chat_id, jsonb_build_object('type', 'removed'));
    delete from public.chat_chats where id = old.chat_id and kind = 'event';
  end if;
  return null;
end;
$$;
drop trigger if exists cal_events_cleanup_ad on public.cal_events;
create trigger cal_events_cleanup_ad
  after delete on public.cal_events
  for each row execute function public.cal_events_cleanup_ad();

-- Уведомления о сообщениях: чат события — как группа. Прежнее определение —
-- 2026-11-08_zzzzz_chat_channels.sql; актуальное — здесь.
create or replace function public.chat_notify_message(m public.chat_messages)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_chats;
  r record;
  v_author text := public.chat_display_name(m.author_id);
  v_preview text := public.chat_preview_text(m.body_text, m.attachments);
  v_url text := '/chats/' || m.chat_id || '?m=' || m.seq;
  v_reply_author uuid;
  v_title text;
begin
  select * into c from public.chat_chats where id = m.chat_id;
  if m.reply_to_seq is not null then
    select author_id into v_reply_author from public.chat_messages
     where chat_id = m.chat_id and seq = m.reply_to_seq;
  end if;
  for r in
    select cm.user_id, cm.notify, cm.muted_until
      from public.chat_members cm
     where cm.chat_id = m.chat_id and cm.user_id is distinct from m.author_id
  loop
    continue when r.notify = 'none';
    if r.user_id = any (m.mentions) or m.mention_all or r.user_id = v_reply_author then
      v_title := case when r.user_id = v_reply_author and not (r.user_id = any (m.mentions) or m.mention_all)
                      then 'Ответ от ' || v_author else 'Упоминание от ' || v_author end;
      perform public.notif_send_ex(r.user_id, 'chat.mention', v_title,
        case when c.kind in ('group', 'task', 'project', 'event') then '«' || c.title || '»: ' else '' end || v_preview,
        v_url, m.author_id, 'chatmention:' || m.chat_id, false, true);
    elsif r.notify = 'all' and (r.muted_until is null or r.muted_until < now()) then
      if c.kind = 'group' and coalesce((c.settings->>'channel')::boolean, false) then
        perform public.notif_send_ex(r.user_id, 'chat.channel', c.title, v_preview, v_url,
          m.author_id, 'chatchannel:' || m.chat_id, false, true);
      elsif c.kind = 'direct' then
        perform public.notif_send_ex(r.user_id, 'chat.direct', v_author, v_preview, v_url,
          m.author_id, 'chat:' || m.chat_id, false, false);
      elsif c.kind in ('group', 'task', 'project', 'event') then
        perform public.notif_send_ex(r.user_id, 'chat.group', c.title, v_author || ': ' || v_preview,
          v_url, m.author_id, 'chat:' || m.chat_id, false, false);
      end if;
    end if;
  end loop;
end;
$$;

-- Пуш по умолчанию: + без пуша `cal.reply`. Прежнее определение —
-- 2026-11-08_zzzzzzzz_people_birthdays_absences.sql; актуальное — здесь.
create or replace function public.notif_default_push(p_kind text)
returns boolean
language sql
immutable
as $$
  select p_kind not in ('chat.group', 'task.done', 'task.accepted', 'task.deadline', 'company.birthday',
                        'cal.reply')
$$;

-- 4. Права ---------------------------------------------------------------------------

-- Уровень человека в календаре: manage / edit / view / null.
create or replace function public.cal_level(p_cal uuid, p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when c.kind = 'personal' then case when c.owner_id = p_uid then 'manage' end
    when c.owner_id = p_uid then 'manage'
    else (
      select case when bool_or(a.level = 'manage') then 'manage'
                  when bool_or(a.level = 'edit') then 'edit'
                  when count(*) > 0 then 'view' end
        from public.cal_calendar_access a
       where a.calendar_id = c.id
         and case a.subject
               when 'all' then true
               when 'user' then a.user_id = p_uid
               when 'unit' then exists (
                 select 1 from public.org_unit_members m
                   join public.org_units sub on sub.id = m.unit_id
                  where m.user_id = p_uid
                    and (sub.id = a.unit_id or (a.with_subunits and a.unit_id = any (sub.path)))
                    and (a.unit_scope = 'all' or m.member_role in ('head', 'deputy')))
               when 'project' then exists (
                 select 1 from public.task_project_members pm
                  where pm.project_id = a.project_id and pm.user_id = p_uid)
               else false
             end)
  end
    from public.cal_calendars c
   where c.id = p_cal and p_uid is not null and public.is_portal_user(p_uid)
$$;

-- Доступ к событию: edit (календарь edit / manage или организатор), view
-- (видит календарь или участник), null.
create or replace function public.cal_event_access(e public.cal_events, p_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_level text := public.cal_level(e.calendar_id, p_uid);
begin
  -- Заблокированный не видит и по оставшимся строкам участника.
  if p_uid is null or not public.is_portal_user(p_uid) then
    return null;
  end if;
  if v_level in ('edit', 'manage') or e.organizer_id is not distinct from p_uid then
    return 'edit';
  end if;
  if v_level = 'view' or exists (select 1 from public.cal_attendees a
                                  where a.event_id = e.id and a.user_id = p_uid) then
    return 'view';
  end if;
  return null;
end;
$$;

create or replace function public.cal_require_event(p_id uuid, p_need text, p_lock boolean default false)
returns public.cal_events
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.cal_events;
  v_access text;
begin
  if p_lock then
    select * into e from public.cal_events where id = p_id for update;
  else
    select * into e from public.cal_events where id = p_id;
  end if;
  if not found then
    raise exception 'cal_not_found' using errcode = 'P0002';
  end if;
  v_access := public.cal_event_access(e, auth.uid());
  if v_access is null or (p_need = 'edit' and v_access <> 'edit') then
    raise exception 'cal_forbidden' using errcode = '42501';
  end if;
  return e;
end;
$$;

create or replace function public.cal_user_tz(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select s.timezone from public.portal_user_settings s where s.user_id = p_uid), 'Europe/Moscow')
$$;

-- Личный календарь человека (заводится при первом обращении).
create or replace function public.cal_personal_id(p_uid uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.cal_calendars where kind = 'personal' and owner_id = p_uid;
  if v_id is null then
    insert into public.cal_calendars (kind, owner_id, name, color)
    values ('personal', p_uid, 'Мой календарь', 'blue')
    on conflict (owner_id) where kind = 'personal' do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.cal_calendars where kind = 'personal' and owner_id = p_uid;
    end if;
  end if;
  return v_id;
end;
$$;

-- 5. Повторения -----------------------------------------------------------------------

create or replace function public.cal_rrule_valid(p jsonb)
returns boolean
language plpgsql
immutable
as $$
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object' or coalesce(p->>'freq', '') not in ('daily', 'workdays', 'weekly', 'monthly', 'yearly') then
    return false;
  end if;
  if p ? 'interval' and (jsonb_typeof(p->'interval') <> 'number' or (p->>'interval')::numeric not between 1 and 99) then
    return false;
  end if;
  if p->>'freq' = 'weekly' and (coalesce(jsonb_typeof(p->'weekdays'), '') <> 'array'
       or jsonb_array_length(p->'weekdays') not between 1 and 7
       or exists (select 1 from jsonb_array_elements(p->'weekdays') x
                   where jsonb_typeof(x) <> 'number' or x::text::numeric not between 1 and 7)) then
    return false;
  end if;
  if nullif(p->>'until', '') is not null then
    perform (p->>'until')::date;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- Начала повторений события, пересекающих [p_from, p_to). Без повтора —
-- само событие. Повтор считается в поясе события: «по понедельникам в
-- 10:00 по Москве» остаётся 10:00 по Москве.
create or replace function public.cal_occurrences(e public.cal_events, p_from timestamptz, p_to timestamptz)
returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dur interval := e.ends_at - e.starts_at;
  v_local timestamp := e.starts_at at time zone e.tz;
  v_d0 date := (e.starts_at at time zone e.tz)::date;
  v_t0 time := (e.starts_at at time zone e.tz)::time;
  v_freq text := e.rrule->>'freq';
  v_int integer := greatest(coalesce((e.rrule->>'interval')::numeric::int, 1), 1);
  v_days int[];
  v_until date := nullif(e.rrule->>'until', '')::date;
  v_first date;
  v_last date;
  v_dow0 integer;
  v_last0 integer;
begin
  if e.rrule is null then
    if e.starts_at < p_to and (e.ends_at > p_from or e.starts_at >= p_from) then
      return next e.starts_at;
    end if;
    return;
  end if;
  v_dow0 := extract(isodow from v_d0)::int;
  if jsonb_typeof(e.rrule->'weekdays') = 'array' then
    v_days := array(select x::int from jsonb_array_elements_text(e.rrule->'weekdays') x);
  end if;
  v_first := greatest(v_d0, ((p_from - v_dur) at time zone e.tz)::date - 1);
  v_last := (p_to at time zone e.tz)::date + 1;
  if v_until is not null then
    v_last := least(v_last, v_until);
  end if;
  v_last := least(v_last, v_first + 800);
  if v_last < v_first then
    return;
  end if;
  v_last0 := extract(day from v_local)::int;
  return query
    select s.o
      from (select (d.day + v_t0) at time zone e.tz as o, d.day
              from (select g::date as day from generate_series(v_first, v_last, interval '1 day') g) d) s
     where case v_freq
             when 'daily' then (s.day - v_d0) % v_int = 0
             when 'workdays' then not public.work_day_off(s.day)
             when 'weekly' then extract(isodow from s.day)::int = any (coalesce(v_days, array[v_dow0]))
                            and ((s.day - (v_d0 - (v_dow0 - 1))) / 7) % v_int = 0
             when 'monthly' then extract(day from s.day)::int =
                                   least(v_last0, extract(day from (date_trunc('month', s.day) + interval '1 month - 1 day'))::int)
                            and ((extract(year from s.day)::int * 12 + extract(month from s.day)::int)
                                 - (extract(year from v_d0)::int * 12 + extract(month from v_d0)::int)) % v_int = 0
             when 'yearly' then extract(month from s.day) = extract(month from v_d0)
                            and extract(day from s.day)::int =
                                  least(v_last0, extract(day from (date_trunc('month', s.day) + interval '1 month - 1 day'))::int)
                            and (extract(year from s.day)::int - extract(year from v_d0)::int) % v_int = 0
             else false
           end
       and s.o >= e.starts_at
       and not (s.o = any (e.exdates))
       and s.o < p_to and (s.o + v_dur > p_from or s.o >= p_from)
     order by s.o;
end;
$$;

-- «12.11, 10:00–11:00» в поясе человека (для уведомлений).
create or replace function public.cal_when_text(p_start timestamptz, p_end timestamptz, p_all_day boolean,
                                                p_event_tz text, p_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text := case when p_all_day then p_event_tz else public.cal_user_tz(p_uid) end;
  s timestamp := p_start at time zone v_tz;
  f timestamp := p_end at time zone v_tz;
begin
  if p_all_day then
    if (f - interval '1 minute')::date > s::date then
      return to_char(s, 'DD.MM') || '–' || to_char(f - interval '1 minute', 'DD.MM') || ', весь день';
    end if;
    return to_char(s, 'DD.MM') || ', весь день';
  end if;
  if f::date > s::date then
    return to_char(s, 'DD.MM HH24:MI') || ' – ' || to_char(f, 'DD.MM HH24:MI');
  end if;
  if f = s then
    return to_char(s, 'DD.MM, HH24:MI');
  end if;
  return to_char(s, 'DD.MM, HH24:MI') || '–' || to_char(f, 'HH24:MI');
end;
$$;

-- 6. Уведомления и живое обновление -----------------------------------------------

create or replace function public.cal_url(p_event uuid, p_occ timestamptz default null)
returns text
language sql
immutable
as $$
  select '/calendar?event=' || p_event::text
         || case when p_occ is not null
                 then '&at=' || to_char(p_occ at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') else '' end
$$;

create or replace function public.cal_broadcast(p_event uuid, p_also uuid[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  begin
    for r in
      select a.user_id from public.cal_attendees a where a.event_id = p_event
      union
      select u from unnest(coalesce(p_also, '{}'::uuid[])) u
    loop
      perform realtime.send(jsonb_build_object('type', 'calendar', 'event_id', p_event),
                            'calendar', 'user:' || r.user_id::text, true);
    end loop;
  exception when others then
    null;
  end;
end;
$$;

-- Чат события: участники (кроме отказавшихся? — нет: все участники).
create or replace function public.cal_event_chat_sync(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid;
  r record;
begin
  select chat_id into v_chat from public.cal_events where id = p_event;
  if v_chat is null then
    return;
  end if;
  insert into public.chat_members (chat_id, user_id, role)
  select v_chat, a.user_id, 'member' from public.cal_attendees a
   where a.event_id = p_event and public.is_portal_user(a.user_id)
  on conflict (chat_id, user_id) do nothing;
  for r in
    select cm.user_id from public.chat_members cm
     where cm.chat_id = v_chat
       and not exists (select 1 from public.cal_attendees a where a.event_id = p_event and a.user_id = cm.user_id)
  loop
    perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'removed'), array[r.user_id]);
    delete from public.chat_members where chat_id = v_chat and user_id = r.user_id;
  end loop;
  perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'members'));
end;
$$;

create or replace function public.cal_event_chat_open(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  e public.cal_events;
  v_chat uuid;
begin
  select * into e from public.cal_events where id = p_id for update;
  if not found then
    raise exception 'cal_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.cal_attendees where event_id = p_id and user_id = v_uid) then
    raise exception 'cal_not_attendee' using errcode = '42501';
  end if;
  if e.chat_id is not null then
    return e.chat_id;
  end if;
  insert into public.chat_chats (kind, title, created_by, settings)
  values ('event', left(e.title, 100), v_uid,
          jsonb_build_object('pin', 'all', 'post', 'all', 'add', 'admins', 'event_id', e.id))
  returning id into v_chat;
  update public.cal_events set chat_id = v_chat where id = p_id;
  perform public.cal_event_chat_sync(p_id);
  perform public.chat_system_message(v_chat, v_uid, jsonb_build_object('type', 'event_chat'));
  perform public.chat_broadcast(v_chat, jsonb_build_object('type', 'chat'));
  return v_chat;
end;
$$;

-- 7. Календари -------------------------------------------------------------------------

create or replace function public.cal_calendar_json(c public.cal_calendars, p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'name', c.name, 'color', c.color, 'description', c.description,
    'owner_id', c.owner_id, 'level', public.cal_level(c.id, p_uid))
$$;

create or replace function public.cal_calendars_list()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  perform public.cal_personal_id(v_uid);
  return coalesce((
    select jsonb_agg(public.cal_calendar_json(c, v_uid) order by (c.kind = 'personal') desc, lower(c.name))
      from public.cal_calendars c
     where public.cal_level(c.id, v_uid) is not null), '[]'::jsonb);
end;
$$;

create or replace function public.cal_calendar_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.cal_calendars;
  v_level text;
begin
  select * into c from public.cal_calendars where id = p_id;
  v_level := public.cal_level(p_id, v_uid);
  if not found or v_level is null then
    raise exception 'cal_forbidden' using errcode = '42501';
  end if;
  return public.cal_calendar_json(c, v_uid) || jsonb_build_object(
    'access', case when v_level = 'manage' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'subject', a.subject, 'unit_id', a.unit_id, 'unit_scope', a.unit_scope,
               'with_subunits', a.with_subunits, 'user_id', a.user_id, 'project_id', a.project_id,
               'level', a.level)
             order by case a.subject when 'all' then 0 when 'unit' then 1 when 'project' then 2 else 3 end)
        from public.cal_calendar_access a where a.calendar_id = p_id), '[]'::jsonb) end);
end;
$$;

-- Что человек может открыть общему календарю: всю компанию, подразделения,
-- проекты (где он участник).
create or replace function public.cal_source_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_company boolean := public.cal_can_company(v_uid);
begin
  return jsonb_build_object(
    'company', v_company,
    'units', coalesce((
      select jsonb_agg(u.id order by cardinality(u.path), u.sort_order, u.name)
        from public.org_units u
       where v_company or exists (
               select 1 from public.org_unit_members m
                where m.user_id = v_uid and m.member_role in ('head', 'deputy')
                  and (m.unit_id = u.id or m.unit_id = any (u.path)))), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'color', p.color) order by lower(p.title))
        from public.task_projects p
       where p.archived_at is null
         and exists (select 1 from public.task_project_members pm
                      where pm.project_id = p.id and pm.user_id = v_uid)), '[]'::jsonb));
end;
$$;

create or replace function public.cal_calendar_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.cal_calendars;
  v_name text := btrim(coalesce(p->>'name', ''));
  v_color text := coalesce(nullif(p->>'color', ''), 'blue');
  v_desc text := nullif(btrim(coalesce(p->>'description', '')), '');
  v_company boolean := public.cal_can_company(v_uid);
  e jsonb;
  v_subject text;
  v_unit uuid;
  v_project uuid;
  v_user uuid;
  v_level text;
  v_kept boolean;
  v_old jsonb;
begin
  if v_name = '' then
    raise exception 'cal_name_required' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.cal_calendars (kind, owner_id, name, color, description)
    values ('shared', v_uid, v_name, v_color, v_desc)
    returning * into c;
  else
    select * into c from public.cal_calendars where id = p_id for update;
    if not found or coalesce(public.cal_level(p_id, v_uid), '') <> 'manage' then
      raise exception 'cal_forbidden' using errcode = '42501';
    end if;
    update public.cal_calendars
       set name = v_name, color = v_color, description = v_desc, updated_at = now()
     where id = p_id;
  end if;

  if c.kind = 'shared' and jsonb_typeof(p->'access') = 'array' then
    if jsonb_array_length(p->'access') > 50 then
      raise exception 'cal_access_invalid' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('subject', a.subject, 'unit_id', a.unit_id,
                                                 'project_id', a.project_id, 'user_id', a.user_id)), '[]'::jsonb)
      into v_old
      from public.cal_calendar_access a where a.calendar_id = c.id;
    delete from public.cal_calendar_access where calendar_id = c.id;
    for e in select * from jsonb_array_elements(p->'access') loop
      v_subject := e->>'subject';
      v_level := coalesce(nullif(e->>'level', ''), 'view');
      v_unit := nullif(e->>'unit_id', '')::uuid;
      v_project := nullif(e->>'project_id', '')::uuid;
      v_user := nullif(e->>'user_id', '')::uuid;
      if v_level not in ('view', 'edit', 'manage') then
        raise exception 'cal_access_invalid' using errcode = '22023';
      end if;
      select exists (select 1 from jsonb_array_elements(v_old) o
                      where o->>'subject' = v_subject
                        and nullif(o->>'unit_id', '')::uuid is not distinct from v_unit
                        and nullif(o->>'project_id', '')::uuid is not distinct from v_project
                        and nullif(o->>'user_id', '')::uuid is not distinct from v_user) into v_kept;
      if v_subject = 'all' then
        if not v_company and not v_kept then
          raise exception 'cal_access_forbidden' using errcode = '42501';
        end if;
        v_unit := null; v_project := null; v_user := null;
      elsif v_subject = 'unit' then
        if v_unit is null or not exists (select 1 from public.org_units where id = v_unit) then
          raise exception 'cal_access_invalid' using errcode = '22023';
        end if;
        if not v_company and not v_kept and not exists (
             select 1 from public.org_unit_members m join public.org_units u on u.id = v_unit
              where m.user_id = v_uid and m.member_role in ('head', 'deputy')
                and (m.unit_id = u.id or m.unit_id = any (u.path))) then
          raise exception 'cal_access_forbidden' using errcode = '42501';
        end if;
        v_project := null; v_user := null;
      elsif v_subject = 'project' then
        if v_project is null or not exists (select 1 from public.task_projects where id = v_project) then
          raise exception 'cal_access_invalid' using errcode = '22023';
        end if;
        if not v_kept and not exists (select 1 from public.task_project_members
                                       where project_id = v_project and user_id = v_uid) then
          raise exception 'cal_access_forbidden' using errcode = '42501';
        end if;
        v_unit := null; v_user := null;
      elsif v_subject = 'user' then
        if v_user is null or not public.is_portal_user(v_user) then
          raise exception 'cal_access_invalid' using errcode = '22023';
        end if;
        v_unit := null; v_project := null;
      else
        raise exception 'cal_access_invalid' using errcode = '22023';
      end if;
      insert into public.cal_calendar_access
        (calendar_id, subject, unit_id, unit_scope, with_subunits, user_id, project_id, level)
      values (c.id, v_subject, v_unit,
              case when e->>'unit_scope' = 'heads' then 'heads' else 'all' end,
              coalesce((e->>'with_subunits')::boolean, true), v_user, v_project, v_level);
    end loop;
  end if;
  return c.id;
end;
$$;

create or replace function public.cal_calendar_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  c public.cal_calendars;
begin
  select * into c from public.cal_calendars where id = p_id for update;
  if not found then
    return;
  end if;
  if c.kind <> 'shared' then
    raise exception 'cal_personal_delete' using errcode = '22023';
  end if;
  if coalesce(public.cal_level(p_id, v_uid), '') <> 'manage' then
    raise exception 'cal_forbidden' using errcode = '42501';
  end if;
  delete from public.cal_calendars where id = p_id;
end;
$$;

-- 8. События ---------------------------------------------------------------------------

create or replace function public.cal_reminders_parse(p jsonb)
returns integer[]
language plpgsql
immutable
as $$
declare
  v integer[];
begin
  if p is null or jsonb_typeof(p) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 5 then
    raise exception 'cal_reminders_invalid' using errcode = '22023';
  end if;
  v := array(select distinct x::text::int from jsonb_array_elements(p) x order by 1);
  if exists (select 1 from unnest(v) m where m not between -1440 and 10080) then
    raise exception 'cal_reminders_invalid' using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function public.cal_event_json(e public.cal_events, p_uid uuid, p_occ timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.cal_calendars;
  v_occ timestamptz := coalesce(p_occ, e.starts_at);
  v_end timestamptz := coalesce(p_occ, e.starts_at) + (e.ends_at - e.starts_at);
  a public.cal_attendees;
  v_level text := public.cal_level(e.calendar_id, p_uid);
begin
  select * into c from public.cal_calendars where id = e.calendar_id;
  select * into a from public.cal_attendees where event_id = e.id and user_id = p_uid;
  return jsonb_build_object(
    'id', e.id,
    'calendar', jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'kind', c.kind,
                                   'visible', v_level is not null),
    'title', e.title, 'description', e.description, 'location', e.location,
    'all_day', e.all_day, 'tz', e.tz,
    'starts_at', e.starts_at, 'ends_at', e.ends_at,
    'occ_start', v_occ, 'occ_end', v_end,
    'day_from', (v_occ at time zone e.tz)::date,
    'day_to', case when e.all_day then ((v_end at time zone e.tz) - interval '1 minute')::date
                   else (v_end at time zone e.tz)::date end,
    'rrule', e.rrule, 'series_id', e.series_id, 'original_start', e.original_start,
    'video', e.video, 'reminders', to_jsonb(e.reminders),
    'my_reminders', case when a.user_id is not null then to_jsonb(coalesce(a.reminders, e.reminders)) end,
    'my_response', a.response,
    'organizer_id', e.organizer_id,
    'attendees', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'response', x.response)
                       order by (x.user_id = e.organizer_id) desc, x.added_at)
        from public.cal_attendees x where x.event_id = e.id), '[]'::jsonb),
    'can_edit', public.cal_event_access(e, p_uid) = 'edit',
    'chat_id', case when a.user_id is not null then e.chat_id end,
    'created_at', e.created_at);
end;
$$;

create or replace function public.cal_event_get(p_id uuid, p_occ timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  e public.cal_events := public.cal_require_event(p_id, 'view');
begin
  if p_occ is not null and e.rrule is not null and not exists (
       select 1 from public.cal_occurrences(e, p_occ, p_occ + interval '1 second') o where o = p_occ) then
    p_occ := null;
  end if;
  return public.cal_event_json(e, v_uid, case when e.rrule is not null then p_occ end);
end;
$$;

-- Создать (p_id null) или изменить событие; p — только меняемые поля:
-- calendar_id, title, description, location, all_day, starts_at, ends_at,
-- tz, rrule, video, reminders, attendees (полный список, организатор —
-- всегда). Смена времени или повтора серии сбрасывает изменённые и
-- отменённые повторения.
create or replace function public.cal_event_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_new boolean := p_id is null;
  o public.cal_events;
  n public.cal_events;
  v_day_from date;
  v_day_to date;
  v_target uuid[];
  v_added uuid[] := '{}';
  v_removed uuid[] := '{}';
  v_time_changed boolean := false;
  v_place_changed boolean := false;
  v_u uuid;
  r record;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  if v_new then
    n.id := gen_random_uuid();
    n.calendar_id := coalesce(nullif(p->>'calendar_id', '')::uuid, public.cal_personal_id(v_uid));
    n.tz := public.cal_user_tz(v_uid);
    n.all_day := false;
    n.exdates := '{}';
    n.video := false;
    n.reminders := '{15}';
    n.organizer_id := v_uid;
    n.created_by := v_uid;
    n.created_at := now();
    if coalesce(public.cal_level(n.calendar_id, v_uid), '') not in ('edit', 'manage') then
      raise exception 'cal_forbidden' using errcode = '42501';
    end if;
  else
    o := public.cal_require_event(p_id, 'edit', true);
    n := o;
    if p ? 'calendar_id' and nullif(p->>'calendar_id', '')::uuid is distinct from o.calendar_id then
      n.calendar_id := nullif(p->>'calendar_id', '')::uuid;
      if n.series_id is not null
         or coalesce(public.cal_level(n.calendar_id, v_uid), '') not in ('edit', 'manage') then
        raise exception 'cal_forbidden' using errcode = '42501';
      end if;
    end if;
  end if;

  if p ? 'title' then n.title := btrim(coalesce(p->>'title', '')); end if;
  if p ? 'description' then n.description := nullif(btrim(coalesce(p->>'description', '')), ''); end if;
  if p ? 'location' then n.location := nullif(btrim(coalesce(p->>'location', '')), ''); end if;
  if p ? 'all_day' then n.all_day := coalesce((p->>'all_day')::boolean, false); end if;
  if p ? 'tz' and nullif(p->>'tz', '') is not null then
    if not exists (select 1 from pg_timezone_names where name = p->>'tz') then
      raise exception 'cal_invalid' using errcode = '22023';
    end if;
    n.tz := p->>'tz';
  end if;
  if p ? 'starts_at' then n.starts_at := (p->>'starts_at')::timestamptz; end if;
  if p ? 'ends_at' then n.ends_at := (p->>'ends_at')::timestamptz; end if;
  if p ? 'rrule' then n.rrule := case when jsonb_typeof(p->'rrule') = 'object' then p->'rrule' end; end if;
  if p ? 'video' then n.video := coalesce((p->>'video')::boolean, false); end if;
  if p ? 'reminders' then n.reminders := coalesce(public.cal_reminders_parse(p->'reminders'), '{}'); end if;

  if coalesce(n.title, '') = '' then
    raise exception 'cal_title_required' using errcode = '22023';
  end if;
  if n.starts_at is null then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  n.ends_at := coalesce(n.ends_at, n.starts_at);
  if n.all_day then
    -- Весь день: с полуночи первого дня до полуночи после последнего.
    v_day_from := (n.starts_at at time zone n.tz)::date;
    v_day_to := greatest(((n.ends_at at time zone n.tz) - interval '1 minute')::date, v_day_from);
    n.starts_at := v_day_from::timestamp at time zone n.tz;
    n.ends_at := (v_day_to + 1)::timestamp at time zone n.tz;
  end if;
  if n.ends_at < n.starts_at then
    raise exception 'cal_end_before_start' using errcode = '22023';
  end if;
  if n.ends_at - n.starts_at > interval '366 days' then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  if not public.cal_rrule_valid(n.rrule) or (n.series_id is not null and n.rrule is not null) then
    raise exception 'cal_rrule_invalid' using errcode = '22023';
  end if;
  if n.rrule is not null and nullif(n.rrule->>'until', '') is not null
     and (n.rrule->>'until')::date < (n.starts_at at time zone n.tz)::date then
    raise exception 'cal_rrule_invalid' using errcode = '22023';
  end if;

  if not v_new then
    v_time_changed := n.starts_at is distinct from o.starts_at or n.ends_at is distinct from o.ends_at
                      or n.all_day is distinct from o.all_day or n.tz is distinct from o.tz
                      or n.rrule is distinct from o.rrule;
    v_place_changed := n.location is distinct from o.location or n.video is distinct from o.video;
    if v_time_changed and o.rrule is not null then
      delete from public.cal_events where series_id = o.id;
      n.exdates := '{}';
    end if;
  end if;
  n.updated_at := now();

  if v_new then
    insert into public.cal_events select n.*;
  else
    update public.cal_events
       set calendar_id = n.calendar_id, title = n.title, description = n.description, location = n.location,
           all_day = n.all_day, starts_at = n.starts_at, ends_at = n.ends_at, tz = n.tz, rrule = n.rrule,
           exdates = n.exdates, video = n.video, reminders = n.reminders, updated_at = n.updated_at
     where id = n.id;
  end if;

  -- Участники: организатор всегда в списке.
  if v_new then
    insert into public.cal_attendees (event_id, user_id, response, responded_at)
    values (n.id, coalesce(n.organizer_id, v_uid), 'accepted', now())
    on conflict do nothing;
  end if;
  if p ? 'attendees' then
    if jsonb_typeof(p->'attendees') <> 'array' or jsonb_array_length(p->'attendees') > 200 then
      raise exception 'cal_invalid' using errcode = '22023';
    end if;
    v_target := array(
      select distinct x::uuid from jsonb_array_elements_text(p->'attendees') x
       where public.is_portal_user(x::uuid)
      union
      select n.organizer_id where n.organizer_id is not null);
    select coalesce(array_agg(a.user_id), '{}') into v_removed
      from public.cal_attendees a
     where a.event_id = n.id and not (a.user_id = any (v_target));
    delete from public.cal_attendees where event_id = n.id and user_id = any (v_removed);
    with ins as (
      insert into public.cal_attendees (event_id, user_id)
      select n.id, u from unnest(v_target) u
      on conflict do nothing
      returning user_id)
    select coalesce(array_agg(user_id), '{}') into v_added from ins;
  end if;

  -- Уведомления.
  for r in select a.user_id, a.response from public.cal_attendees a where a.event_id = n.id and a.user_id <> v_uid loop
    if r.user_id = any (v_added) then
      perform public.notif_send_ex(r.user_id, 'cal.invite', 'Приглашение: ' || n.title,
        public.cal_when_text(n.starts_at, n.ends_at, n.all_day, n.tz, r.user_id)
          || case when n.rrule is not null then ' · повторяется' else '' end
          || ' · ' || public.chat_display_name(v_uid),
        public.cal_url(n.id, case when n.series_id is not null then n.starts_at end),
        v_uid, 'cal:' || n.id::text, false, true);
    elsif (v_time_changed or v_place_changed) and r.response <> 'declined' then
      perform public.notif_send_ex(r.user_id, 'cal.change',
        case when v_time_changed then 'Встреча перенесена: ' else 'Встреча изменена: ' end || n.title,
        public.cal_when_text(n.starts_at, n.ends_at, n.all_day, n.tz, r.user_id)
          || coalesce(' · ' || n.location, ''),
        public.cal_url(n.id, case when n.series_id is not null then n.starts_at end),
        v_uid, 'cal:' || n.id::text, false, true);
    end if;
  end loop;
  foreach v_u in array v_removed loop
    continue when v_u = v_uid;
    perform public.notif_send_ex(v_u, 'cal.change', 'Вас убрали из встречи', n.title,
      null, v_uid, null, false, true);
  end loop;

  perform public.cal_event_chat_sync(n.id);
  if n.chat_id is not null and not v_new and n.title is distinct from o.title then
    update public.chat_chats set title = left(n.title, 100) where id = n.chat_id;
  end if;
  perform public.cal_broadcast(n.id, v_removed);
  return n.id;
end;
$$;

-- Изменить одно повторение серии: отдельное событие (series_id,
-- original_start) с участниками серии, время повторения — в exdates серии.
create or replace function public.cal_event_occurrence_save(p_id uuid, p_occ timestamptz, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cal_events := public.cal_require_event(p_id, 'edit', true);
  v_new uuid := gen_random_uuid();
begin
  if s.rrule is null then
    return public.cal_event_save(p_id, p);
  end if;
  if p_occ is null or not exists (
       select 1 from public.cal_occurrences(s, p_occ, p_occ + interval '1 second') o where o = p_occ) then
    raise exception 'cal_occurrence_not_found' using errcode = 'P0002';
  end if;
  insert into public.cal_events
    (id, calendar_id, title, description, location, all_day, starts_at, ends_at, tz, rrule, exdates,
     series_id, original_start, video, reminders, organizer_id, created_by)
  values (v_new, s.calendar_id, s.title, s.description, s.location, s.all_day, p_occ,
          p_occ + (s.ends_at - s.starts_at), s.tz, null, '{}', s.id, p_occ, s.video, s.reminders,
          s.organizer_id, auth.uid());
  insert into public.cal_attendees (event_id, user_id, response, responded_at, reminders)
  select v_new, a.user_id, a.response, a.responded_at, a.reminders
    from public.cal_attendees a where a.event_id = s.id;
  update public.cal_events set exdates = array_append(exdates, p_occ), updated_at = now() where id = s.id;
  return public.cal_event_save(v_new, coalesce(p, '{}'::jsonb) - 'rrule' - 'calendar_id');
end;
$$;

-- Удалить событие (серию целиком) или одно повторение (p_occ).
create or replace function public.cal_event_delete(p_id uuid, p_occ timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  e public.cal_events := public.cal_require_event(p_id, 'edit', true);
  r record;
  v_users uuid[];
begin
  select coalesce(array_agg(a.user_id), '{}') into v_users from public.cal_attendees a where a.event_id = e.id;
  if p_occ is not null and e.rrule is not null then
    if not exists (select 1 from public.cal_occurrences(e, p_occ, p_occ + interval '1 second') o where o = p_occ) then
      return;
    end if;
    update public.cal_events set exdates = array_append(exdates, p_occ), updated_at = now() where id = e.id;
    for r in select a.user_id from public.cal_attendees a
              where a.event_id = e.id and a.user_id <> v_uid and a.response <> 'declined' loop
      perform public.notif_send_ex(r.user_id, 'cal.change', 'Отменено: ' || e.title,
        public.cal_when_text(p_occ, p_occ + (e.ends_at - e.starts_at), e.all_day, e.tz, r.user_id),
        public.cal_url(e.id), v_uid, 'cal:' || e.id::text, false, true);
    end loop;
    perform public.cal_broadcast(e.id);
    return;
  end if;
  for r in select a.user_id from public.cal_attendees a
            where a.event_id = e.id and a.user_id <> v_uid and a.response <> 'declined' loop
    perform public.notif_send_ex(r.user_id, 'cal.change', 'Встреча отменена: ' || e.title,
      public.cal_when_text(e.starts_at, e.ends_at, e.all_day, e.tz, r.user_id)
        || case when e.rrule is not null then ' · все повторения' else '' end,
      null, v_uid, null, false, true);
  end loop;
  delete from public.cal_events where id = e.id;
  perform public.cal_broadcast(e.id, v_users);
end;
$$;

-- Ответ участника: придёт / не придёт / возможно.
create or replace function public.cal_event_respond(p_id uuid, p_response text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  e public.cal_events;
  v_old text;
begin
  if p_response not in ('accepted', 'declined', 'maybe') then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  select * into e from public.cal_events where id = p_id;
  select response into v_old from public.cal_attendees where event_id = p_id and user_id = v_uid for update;
  if e.id is null or v_old is null then
    raise exception 'cal_not_attendee' using errcode = '42501';
  end if;
  if v_old = p_response then
    return;
  end if;
  update public.cal_attendees set response = p_response, responded_at = now()
   where event_id = p_id and user_id = v_uid;
  if e.organizer_id is not null and e.organizer_id <> v_uid then
    perform public.notif_send_ex(e.organizer_id, 'cal.reply',
      public.chat_display_name(v_uid) || case p_response when 'accepted' then ' придёт'
                                                      when 'declined' then ' не придёт'
                                                      else ' — возможно, придёт' end,
      e.title, public.cal_url(e.id, case when e.series_id is not null then e.starts_at end),
      v_uid, 'calreply:' || e.id::text, false, true);
  end if;
  perform public.cal_broadcast(e.id);
end;
$$;

-- Свои напоминания участника (null — как у события).
create or replace function public.cal_event_my_reminders(p_id uuid, p_minutes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  update public.cal_attendees set reminders = public.cal_reminders_parse(p_minutes)
   where event_id = p_id and user_id = v_uid;
  if not found then
    raise exception 'cal_not_attendee' using errcode = '42501';
  end if;
end;
$$;

-- Повторения событий за период: календари p_calendars (что видит человек)
-- и, если в списке его личный, — встречи, куда его пригласили.
create or replace function public.cal_events_range(p_from timestamptz, p_to timestamptz, p_calendars uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_personal uuid := (select id from public.cal_calendars where kind = 'personal' and owner_id = v_uid);
  v_mine boolean;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  v_mine := v_personal = any (coalesce(p_calendars, '{}'));
  return coalesce((
    with cals as (
      select c.id, c.color, public.cal_level(c.id, v_uid) as lvl
        from public.cal_calendars c
       where c.id = any (coalesce(p_calendars, '{}'))
    ), ev as (
      select e as r, k.color as cal_color, k.lvl
        from public.cal_events e join cals k on k.id = e.calendar_id
       where k.lvl is not null
         and e.starts_at < p_to
         and (case when e.rrule is null then e.ends_at >= p_from
                   else nullif(e.rrule->>'until', '') is null
                        or (e.rrule->>'until')::date >= (p_from at time zone e.tz)::date - 1 end)
      union all
      select e, coalesce((select c.color from public.cal_calendars c where c.id = v_personal), 'blue'),
             public.cal_level(e.calendar_id, v_uid)
        from public.cal_events e
        join public.cal_attendees a on a.event_id = e.id and a.user_id = v_uid and a.response <> 'declined'
       where v_mine
         and not exists (select 1 from cals k where k.id = e.calendar_id and k.lvl is not null)
         and e.starts_at < p_to
         and (case when e.rrule is null then e.ends_at >= p_from
                   else nullif(e.rrule->>'until', '') is null
                        or (e.rrule->>'until')::date >= (p_from at time zone e.tz)::date - 1 end)
    )
    select jsonb_agg(jsonb_build_object(
             'id', (ev.r).id, 'occ', o.occ, 'start', o.occ, 'end', o.occ + ((ev.r).ends_at - (ev.r).starts_at),
             'all_day', (ev.r).all_day,
             'day_from', (o.occ at time zone (ev.r).tz)::date,
             'day_to', ((o.occ + ((ev.r).ends_at - (ev.r).starts_at)) at time zone (ev.r).tz - interval '1 minute')::date,
             'title', (ev.r).title, 'location', (ev.r).location, 'calendar_id', (ev.r).calendar_id,
             'color', ev.cal_color, 'recurring', (ev.r).rrule is not null or (ev.r).series_id is not null,
             'video', (ev.r).video,
             'my_response', (select a.response from public.cal_attendees a
                              where a.event_id = (ev.r).id and a.user_id = v_uid),
             'attendees', (select count(*) from public.cal_attendees a where a.event_id = (ev.r).id),
             'can_edit', coalesce(ev.lvl in ('edit', 'manage'), false) or (ev.r).organizer_id is not distinct from v_uid,
             'organizer_id', (ev.r).organizer_id)
           order by o.occ)
      from ev
      cross join lateral public.cal_occurrences(ev.r, p_from, p_to) o(occ)), '[]'::jsonb);
end;
$$;

-- Ждут ответа: приглашения на предстоящие встречи.
create or replace function public.cal_counters()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  return jsonb_build_object('invites', (
    select count(*) from public.cal_attendees a
      join public.cal_events e on e.id = a.event_id
     where a.user_id = v_uid and a.response = 'pending'
       and (case when e.rrule is null then e.ends_at > now()
                 else nullif(e.rrule->>'until', '') is null or (e.rrule->>'until')::date >= current_date end)));
end;
$$;

-- Ближайшие приглашения без ответа (список «Ждут ответа»).
create or replace function public.cal_invites()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'starts_at', e.starts_at,
                                        'ends_at', e.ends_at, 'all_day', e.all_day, 'tz', e.tz,
                                        'recurring', e.rrule is not null, 'rrule', e.rrule,
                                        'organizer_id', e.organizer_id)
                     order by e.starts_at)
      from public.cal_attendees a
      join public.cal_events e on e.id = a.event_id
     where a.user_id = v_uid and a.response = 'pending'
       and (case when e.rrule is null then e.ends_at > now()
                 else nullif(e.rrule->>'until', '') is null or (e.rrule->>'until')::date >= current_date end)
     limit 50), '[]'::jsonb);
end;
$$;

-- 9. Слои: сроки задач, дни рождения, отсутствия --------------------------------------

-- Коллеги: по подразделениям, подчинённые и сам человек.
create or replace function public.cal_colleague_ids(p_uid uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select array(
    select p_uid
    union
    select m2.user_id from public.org_unit_members m1
      join public.org_unit_members m2 on m2.unit_id = m1.unit_id
     where m1.user_id = p_uid
    union
    select unnest(public.task_led_user_ids(p_uid)))
$$;

create or replace function public.cal_overlays(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_tz text := public.cal_user_tz(v_uid);
  v_d1 date := (p_from at time zone v_tz)::date;
  v_d2 date := (p_to at time zone v_tz)::date;
  v_people uuid[];
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'cal_invalid' using errcode = '22023';
  end if;
  v_people := public.cal_colleague_ids(v_uid);
  return jsonb_build_object(
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object('number', t.number, 'title', t.title, 'deadline', t.deadline,
                                          'status', t.status, 'urgent', t.urgent) order by t.deadline)
        from public.tasks t
       where t.deadline >= p_from and t.deadline < p_to and t.status not in ('done', 'cancelled')
         and exists (select 1 from public.task_members m
                      where m.task_id = t.id and m.user_id = v_uid and m.role in ('assignee', 'coassignee'))),
      '[]'::jsonb),
    'birthdays', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', b.user_id, 'day', x.d) order by x.d)
        from public.people_birthdays b
        cross join lateral (select public.people_next_birthday(b.birth_date, v_d1) as d) x
       where b.user_id = any (v_people) and public.is_portal_user(b.user_id) and x.d <= v_d2), '[]'::jsonb),
    'absences', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'kind', a.kind,
                                          'starts_on', a.starts_on, 'ends_on', a.ends_on) order by a.starts_on)
        from public.people_absences a
       where a.user_id = any (v_people) and a.ends_on >= v_d1 and a.starts_on <= v_d2
         and public.is_portal_user(a.user_id)), '[]'::jsonb));
end;
$$;

-- 10. Напоминания (сервер раз в минуту) ---------------------------------------------

create or replace function public.cal_tick(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
  v_title text;
begin
  delete from public.cal_reminder_log where sent_at < p_now - interval '30 days';
  for r in
    select e.id, e.title, e.all_day, e.tz, e.location, e.video, o.occ, e.ends_at - e.starts_at as dur,
           a.user_id, m.minutes, e.series_id
      from public.cal_events e
      cross join lateral public.cal_occurrences(e, p_now - interval '1 day', p_now + interval '8 days') o(occ)
      join public.cal_attendees a on a.event_id = e.id and a.response <> 'declined'
      cross join lateral unnest(coalesce(a.reminders, e.reminders)) m(minutes)
     where e.starts_at < p_now + interval '8 days'
       and (case when e.rrule is null then e.ends_at >= p_now - interval '1 day'
                 else nullif(e.rrule->>'until', '') is null
                      or (e.rrule->>'until')::date >= (p_now at time zone e.tz)::date - 2 end)
       and o.occ - make_interval(mins => m.minutes) <= p_now
       and o.occ - make_interval(mins => m.minutes) > p_now - interval '10 minutes'
       and public.is_portal_user(a.user_id)
       and not exists (select 1 from public.cal_reminder_log l
                        where l.event_id = e.id and l.occ_start = o.occ and l.user_id = a.user_id
                          and l.minutes = m.minutes)
     limit 2000
  loop
    insert into public.cal_reminder_log (event_id, occ_start, user_id, minutes)
    values (r.id, r.occ, r.user_id, r.minutes)
    on conflict do nothing;
    continue when not found;
    v_title := case
      when r.all_day then r.title
      when r.minutes <= 0 then 'Начинается: ' || r.title
      when r.minutes < 60 then 'Через ' || r.minutes || ' мин: ' || r.title
      else r.title end;
    perform public.notif_send_ex(r.user_id, 'cal.remind', v_title,
      public.cal_when_text(r.occ, r.occ + r.dur, r.all_day, r.tz, r.user_id)
        || coalesce(' · ' || r.location, '')
        || case when r.video then ' · видеовстреча' else '' end,
      public.cal_url(r.id, r.occ), null, 'calremind:' || r.id::text, false, true);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 11. Права на функции ---------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.cal_can_company(uuid)',
    'public.cal_calendars_orphan_au()',
    'public.cal_events_cleanup_ad()',
    'public.cal_level(uuid, uuid)',
    'public.cal_event_access(public.cal_events, uuid)',
    'public.cal_require_event(uuid, text, boolean)',
    'public.cal_user_tz(uuid)',
    'public.cal_personal_id(uuid)',
    'public.cal_occurrences(public.cal_events, timestamptz, timestamptz)',
    'public.cal_when_text(timestamptz, timestamptz, boolean, text, uuid)',
    'public.cal_broadcast(uuid, uuid[])',
    'public.cal_event_chat_sync(uuid)',
    'public.cal_calendar_json(public.cal_calendars, uuid)',
    'public.cal_event_json(public.cal_events, uuid, timestamptz)',
    'public.cal_colleague_ids(uuid)',
    'public.cal_tick(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.cal_calendars_list()',
    'public.cal_calendar_get(uuid)',
    'public.cal_source_options()',
    'public.cal_calendar_save(uuid, jsonb)',
    'public.cal_calendar_delete(uuid)',
    'public.cal_event_get(uuid, timestamptz)',
    'public.cal_event_save(uuid, jsonb)',
    'public.cal_event_occurrence_save(uuid, timestamptz, jsonb)',
    'public.cal_event_delete(uuid, timestamptz)',
    'public.cal_event_respond(uuid, text)',
    'public.cal_event_my_reminders(uuid, jsonb)',
    'public.cal_event_chat_open(uuid)',
    'public.cal_events_range(timestamptz, timestamptz, uuid[])',
    'public.cal_counters()',
    'public.cal_invites()',
    'public.cal_overlays(timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

revoke all on public.cal_calendars, public.cal_calendar_access, public.cal_events, public.cal_attendees,
              public.cal_reminder_log from anon, authenticated;
