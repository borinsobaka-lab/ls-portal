-- ============================================================================
-- AI-ассистент Kate (2026-10-19): история переписки сотрудника и данные для
-- вопросов о продажах.
--
-- 1. assistant_threads / assistant_messages — переписка сотрудника с Kate.
--    Каждый видит и правит только свои диалоги (даже владелец чужие не
--    видит). Пишет сервер админки (/api/chat) от имени сотрудника: вопрос —
--    до ответа модели, ответ — когда он готов. Хранится только текст ответа
--    и имена вызванных инструментов (tools): строки данных из инструментов
--    не сохраняются — при следующем вопросе модель запросит их заново.
--    Срока хранения нет (решение владельца: переписка не стирается).
--
-- 2. Сводки для Kate — security definer, вызывающий обязан быть сотрудником
--    клуба (is_trainer); клиенты — базы клиентов клуба (у пакетного — общая
--    база всех пакетных клубов, как в «Клиентах»):
--    assistant_app_clients    — кто и когда вошёл в приложение формата клуба,
--                               последний раз, открытия и просмотры
--                               абонементов за 30 дней, включены ли пуши
--                               (таблицы app_devices / app_activity_days
--                               закрыты всем, кроме сервера);
--    assistant_inactive_members — действующий абонемент, но давно не был
--                               (или ни разу после покупки);
--    assistant_birthdays      — дни рождения в ближайшие N дней.
--
-- Идемпотентно.
-- ============================================================================

-- 1. Переписка -------------------------------------------------------------------

create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  studio_id uuid references public.studios (id) on delete set null,
  title text not null default 'Новый чат',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.assistant_threads drop constraint if exists assistant_threads_title_check;
alter table public.assistant_threads add constraint assistant_threads_title_check
  check (char_length(title) between 1 and 200);

create index if not exists assistant_threads_user_idx
  on public.assistant_threads (user_id, updated_at desc);

comment on table public.assistant_threads is
  'Диалоги сотрудника с AI-ассистентом Kate. Видит и правит только автор.';
comment on column public.assistant_threads.studio_id is
  'Клуб, открытый в админке при первом вопросе (для истории; отвечает Kate по клубу, открытому сейчас).';

create table if not exists public.assistant_messages (
  thread_id uuid not null references public.assistant_threads (id) on delete cascade,
  id text not null,
  role text not null,
  parts jsonb not null,
  tools text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (thread_id, id)
);

alter table public.assistant_messages drop constraint if exists assistant_messages_role_check;
alter table public.assistant_messages add constraint assistant_messages_role_check
  check (role in ('user', 'assistant'));
alter table public.assistant_messages drop constraint if exists assistant_messages_size_check;
alter table public.assistant_messages add constraint assistant_messages_size_check
  check (char_length(id) between 1 and 100
         and jsonb_typeof(parts) = 'array'
         and octet_length(parts::text) <= 200000
         and cardinality(tools) <= 100);

create index if not exists assistant_messages_thread_idx
  on public.assistant_messages (thread_id, created_at);

comment on table public.assistant_messages is
  'Сообщения диалога с Kate: parts — части UIMessage AI SDK (только текст), tools — какие инструменты вызывала Kate.';

-- Новое сообщение поднимает диалог наверх списка.
create or replace function public.assistant_messages_touch_thread()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.assistant_threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists assistant_messages_touch_thread_aiu on public.assistant_messages;
create trigger assistant_messages_touch_thread_aiu
  after insert or update on public.assistant_messages
  for each row execute function public.assistant_messages_touch_thread();

alter table public.assistant_threads enable row level security;
alter table public.assistant_messages enable row level security;

revoke all on public.assistant_threads from public, anon;
revoke all on public.assistant_messages from public, anon;
grant select, insert, update, delete on public.assistant_threads to authenticated;
grant select, insert, update, delete on public.assistant_messages to authenticated;
grant all on public.assistant_threads to service_role;
grant all on public.assistant_messages to service_role;

-- Kate — инструмент сотрудника: завести диалог может только сотрудник.
drop policy if exists "assistant threads own select" on public.assistant_threads;
create policy "assistant threads own select" on public.assistant_threads
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "assistant threads own insert" on public.assistant_threads;
create policy "assistant threads own insert" on public.assistant_threads
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_staff(auth.uid())));

drop policy if exists "assistant threads own update" on public.assistant_threads;
create policy "assistant threads own update" on public.assistant_threads
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "assistant threads own delete" on public.assistant_threads;
create policy "assistant threads own delete" on public.assistant_threads
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "assistant messages own" on public.assistant_messages;
create policy "assistant messages own" on public.assistant_messages
  for all to authenticated
  using (exists (select 1 from public.assistant_threads t
                  where t.id = assistant_messages.thread_id
                    and t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.assistant_threads t
                       where t.id = assistant_messages.thread_id
                         and t.user_id = (select auth.uid())));

-- 2. Сводки для Kate ----------------------------------------------------------------

-- Клубы базы клиентов клуба: у пакетного — все пакетные (общая база), у
-- подписочного — он сам. Не сотрудник клуба — исключение. Только для
-- функций ниже (наружу не выдаётся).
create or replace function public.assistant_client_scope(p_studio_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_format text;
begin
  if p_studio_id is null or not public.is_trainer(auth.uid(), p_studio_id) then
    raise exception 'Нет доступа к клубу' using errcode = '42501';
  end if;
  select format into v_format from public.studios where id = p_studio_id;
  if v_format = 'packages' then
    return (select coalesce(array_agg(id), '{}'::uuid[]) from public.studios where format = 'packages');
  end if;
  return array[p_studio_id];
end;
$$;

revoke all on function public.assistant_client_scope(uuid) from public, anon, authenticated;

-- Приложение: кто вошёл, кто был, кто смотрел абонементы.
--   p_order: registered — по первому входу (новые сверху), last_seen — по
--   последнему открытию, membership_views — по просмотрам абонементов за 30 дней.
--   p_since — только вошедшие (registered) или открывавшие (last_seen) с этой даты.
create or replace function public.assistant_app_clients(
  p_studio_id uuid,
  p_order text default 'registered',
  p_since date default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope uuid[] := public.assistant_client_scope(p_studio_id);
  v_format text;
  v_since30 date := (now() at time zone 'Asia/Tbilisi')::date - 30;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if p_order not in ('registered', 'last_seen', 'membership_views') then
    raise exception 'Неизвестная сортировка: %', p_order using errcode = '22023';
  end if;
  select coalesce(format, 'subscription') into v_format from public.studios where id = p_studio_id;

  return coalesce((
    select jsonb_agg(to_jsonb(r) - 'sort_at' - 'sort_views'
                     order by case when p_order = 'membership_views' then r.sort_views end
                                desc nulls last,
                              r.sort_at desc nulls last, r.client_id)
      from (
        select
          c.id as client_id,
          c.studio_id,
          coalesce(nullif(trim(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, '')), ''),
                   c.full_name) as client_name,
          c.phone,
          cs.club_status,
          u.created_at as first_sign_in_at,
          u.last_sign_in_at,
          d.first_app_at,
          coalesce(c.app_last_seen_at, d.last_app_at) as last_app_at,
          coalesce(a.sessions_30d, 0) as sessions_30d,
          coalesce(a.membership_views_30d, 0) as membership_views_30d,
          coalesce(d.push_on, false) as push_on,
          case when p_order = 'registered' then u.created_at
               else coalesce(c.app_last_seen_at, d.last_app_at) end as sort_at,
          coalesce(a.membership_views_30d, 0) as sort_views
        from public.clients c
        join auth.users u on u.id = c.user_id
        left join public.clients_with_status cs on cs.id = c.id
        left join lateral (
          select min(dv.first_seen_at) as first_app_at,
                 max(dv.last_seen_at) as last_app_at,
                 bool_or(coalesce(dv.push_subscribed, false)) as push_on
            from public.app_devices dv
           where dv.user_id = c.user_id and dv.app_format = v_format
        ) d on true
        left join lateral (
          select sum(ad.sessions)::integer as sessions_30d,
                 sum(case when jsonb_typeof(ad.screens -> 'memberships') = 'number'
                          then (ad.screens ->> 'memberships')::numeric else 0 end)::integer
                   as membership_views_30d
            from public.app_activity_days ad
           where ad.user_id = c.user_id and ad.app_format = v_format and ad.day >= v_since30
        ) a on true
        where c.studio_id = any (v_scope)
          and (p_since is null
               or (p_order = 'registered' and u.created_at >= p_since::timestamp at time zone 'Asia/Tbilisi')
               or (p_order = 'last_seen'
                   and coalesce(c.app_last_seen_at, d.last_app_at) >= p_since::timestamp at time zone 'Asia/Tbilisi')
               or p_order = 'membership_views')
          and (p_order <> 'membership_views' or coalesce(a.membership_views_30d, 0) > 0)
          and (p_order <> 'last_seen' or coalesce(c.app_last_seen_at, d.last_app_at) is not null)
        order by
          case when p_order = 'membership_views' then coalesce(a.membership_views_30d, 0) end desc nulls last,
          case p_order
            when 'registered' then u.created_at
            when 'last_seen' then coalesce(c.app_last_seen_at, d.last_app_at)
            else coalesce(c.app_last_seen_at, d.last_app_at)
          end desc nulls last
        limit v_limit
      ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.assistant_app_clients(uuid, text, date, integer) from public, anon;
grant execute on function public.assistant_app_clients(uuid, text, date, integer) to authenticated;

-- Действующий абонемент, но давно не был: последнее посещение раньше, чем
-- p_days дней назад, или ни одного посещения с начала абонемента (в том числе
-- «ожидает первого посещения»). Пробные — тоже (повод позвать на пробное).
create or replace function public.assistant_inactive_members(
  p_studio_id uuid,
  p_days integer default 14,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope uuid[] := public.assistant_client_scope(p_studio_id);
  v_days integer := least(greatest(coalesce(p_days, 14), 1), 365);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.last_visit_at nulls first, r.client_id)
      from (
        select *
          from (
            -- Абонемент на клиента — ближайший к окончанию.
            select distinct on (c.id)
              c.id as client_id,
              coalesce(nullif(trim(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, '')), ''),
                       c.full_name) as client_name,
              c.phone,
              cm.id as client_membership_id,
              m.name as membership_name,
              m.kind as membership_kind,
              case
                when coalesce(cm.starts_on_first_visit, false) and cm.started_at is null
                  then 'awaiting'
                else cm.status
              end as membership_state,
              cm.started_at,
              cm.ends_at,
              cm.visits_left,
              cm.personal_left,
              v.last_visit_at,
              coalesce(v.visits_total, 0) as visits_total,
              case when v.last_visit_at is not null
                   then v_today - (v.last_visit_at at time zone 'Asia/Tbilisi')::date end
                as days_since_visit,
              exists (
                select 1 from public.schedule_bookings b
                  join public.schedule_entries e on e.id = b.entry_id
                 where b.client_id = c.id and b.status = 'booked' and e.starts_at > now()
              ) as has_upcoming_booking
            from public.client_memberships cm
            join public.clients c on c.id = cm.client_id
            left join public.memberships m on m.id = cm.membership_id
            left join lateral (
              select max(l.starts_at) as last_visit_at, count(*)::integer as visits_total
                from public.bookings_log l
               where l.status in ('attended', 'completed')
                 and (l.client_id = c.id
                      or (l.client_id is null and c.user_id is not null and l.user_id = c.user_id))
            ) v on true
            where c.studio_id = any (v_scope)
              and cm.studio_id = any (v_scope)
              and cm.status = 'active'
              and (cm.ends_at is null or cm.ends_at >= v_today)
              and (v.last_visit_at is null
                   or v.last_visit_at < now() - make_interval(days => v_days))
            order by c.id, cm.ends_at nulls last
          ) one_per_client
         order by last_visit_at nulls first, client_id
         limit v_limit
      ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.assistant_inactive_members(uuid, integer, integer) from public, anon;
grant execute on function public.assistant_inactive_members(uuid, integer, integer) to authenticated;

-- Дни рождения в ближайшие p_days дней (0 — сегодня). 29 февраля — только в
-- високосный год.
create or replace function public.assistant_birthdays(
  p_studio_id uuid,
  p_days integer default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope uuid[] := public.assistant_client_scope(p_studio_id);
  v_days integer := least(greatest(coalesce(p_days, 7), 0), 60);
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
begin
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.birthday_on, r.client_name)
      from (
        select
          c.id as client_id,
          coalesce(nullif(trim(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, '')), ''),
                   c.full_name) as client_name,
          c.phone,
          c.birthday,
          v_today + g.n as birthday_on,
          extract(year from age(v_today + g.n, c.birthday))::integer as turns,
          cs.club_status
        from generate_series(0, v_days) as g(n)
        join public.clients c
          on c.birthday is not null
         and to_char(c.birthday, 'MM-DD') = to_char(v_today + g.n, 'MM-DD')
        left join public.clients_with_status cs on cs.id = c.id
        where c.studio_id = any (v_scope)
        limit 300
      ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.assistant_birthdays(uuid, integer) from public, anon;
grant execute on function public.assistant_birthdays(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
