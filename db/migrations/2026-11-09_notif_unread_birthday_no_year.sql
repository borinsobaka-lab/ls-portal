-- Разбор интерфейса перед тестом (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 5.7.2,
-- 5.9.7; 2026-11-09):
--
-- 1. «Отметить непрочитанным» в ленте «Уведомлений» — RPC
--    `notif_mark_unread(p_ids)`: только свои строки. У сгруппированной строки
--    (`group_key`) непрочитанной может быть одна на ключ
--    (`notif_items_group_uidx`) — если по ключу уже есть новая непрочитанная,
--    прежнюю не возвращаем (она и так «свёрнута» в новую).
-- 2. День рождения без года: `people_birthdays.year_known` (false — год не
--    указан; в `birth_date` тогда 2000 год — високосный, 29 февраля
--    сохраняется). Без года возраст не показывается никому, «Показывать год»
--    выключен. `people_birthday_save` — четвёртый параметр `p_year_known`
--    (по умолчанию true — прежние вызовы работают как раньше).
--
-- Актуальные определения `people_birthday_get`, `people_birthday_save`,
-- `people_birthdays_upcoming` — здесь (прежние —
-- 2026-11-08_zzzzzzzz_people_birthdays_absences.sql).

-- 1 ------------------------------------------------------------------------
create or replace function public.notif_mark_unread(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.notif_items n
     set read_at = null
   where n.user_id = auth.uid()
     and n.read_at is not null
     and n.id = any (coalesce(p_ids, '{}'::uuid[]))
     and (n.group_key is null or not exists (
           select 1 from public.notif_items o
            where o.user_id = n.user_id and o.group_key = n.group_key
              and o.read_at is null and o.id <> n.id));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.notif_mark_unread(uuid[]) from public, anon;
grant execute on function public.notif_mark_unread(uuid[]) to authenticated;

-- 2 ------------------------------------------------------------------------
alter table public.people_birthdays
  add column if not exists year_known boolean not null default true;

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
    'year', case when b.user_id is not null and b.year_known and (b.show_year or v_edit)
                 then extract(year from b.birth_date)::int end,
    'year_known', coalesce(b.year_known, true),
    'show_year', coalesce(b.show_year and b.year_known, false),
    'can_edit', v_edit);
end;
$$;

drop function if exists public.people_birthday_save(uuid, date, boolean);

create or replace function public.people_birthday_save(
  p_user uuid, p_date date, p_show_year boolean, p_year_known boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.chat_require_portal();
  v_known boolean := coalesce(p_year_known, true);
  v_date date := p_date;
begin
  if not public.people_can_edit(v_uid, p_user) then
    raise exception 'people_forbidden' using errcode = '42501';
  end if;
  if p_date is null then
    delete from public.people_birthdays where user_id = p_user;
    return;
  end if;
  if not v_known then
    -- Без года — 2000-й (високосный): сохраняется и 29 февраля.
    v_date := make_date(2000, extract(month from p_date)::int, extract(day from p_date)::int);
  elsif p_date < date '1900-01-01' or p_date > current_date then
    raise exception 'people_birthday_invalid' using errcode = '22023';
  end if;
  insert into public.people_birthdays (user_id, birth_date, show_year, year_known, updated_by)
  values (p_user, v_date, v_known and coalesce(p_show_year, false), v_known, v_uid)
  on conflict (user_id) do update
    set birth_date = excluded.birth_date, show_year = excluded.show_year,
        year_known = excluded.year_known, updated_by = v_uid, updated_at = now();
end;
$$;

revoke all on function public.people_birthday_save(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.people_birthday_save(uuid, date, boolean, boolean) to authenticated;

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
             'age', case when x.show_year and x.year_known
                         then extract(year from age(x.next_date, x.birth_date))::int end)
           order by x.next_date, x.user_id)
      from (select b.user_id, b.birth_date, b.show_year, b.year_known,
                   public.people_next_birthday(b.birth_date, v_today) as next_date
              from public.people_birthdays b
             where b.user_id in (select p from public.portal_people_ids() p)) x
     where x.next_date <= v_today + least(greatest(coalesce(p_days, 30), 0), 366)), '[]'::jsonb);
end;
$$;
