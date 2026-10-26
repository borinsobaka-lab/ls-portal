-- ============================================================================
-- NPS-опросы: «прочитано» в админке и «Перед продлением» без купивших
-- продление (решения владельца 2026-10-15)
-- ============================================================================
-- 1. «Прочитано» у ответа (nps_responses.read_at / read_by / read_by_name):
--    новый ответ из приложения — непрочитанный, сотрудник отмечает каждый
--    ответ в «NPS-опросах» → «Статистика»; число непрочитанных — счётчик у
--    пункта меню (как у «Заявок»). Кто и когда — ставит база (триггер
--    nps_responses_read_biu, как client_requests_guard у заявок); ответ,
--    внесённый сотрудником вручную («Добавить ответ», user_id пуст), сразу
--    прочитан. Прежние ответы без учётной записи (внесённые вручную,
--    обезличенные) — прочитаны; ответы из приложения — нет: их ещё не видели.
-- 2. «Перед продлением» (nps_pending_survey): клиенту, который уже купил
--    продление (следующий абонемент того же вида ждёт в очереди или уже
--    оформлен), опрос не приходит — он нужен, чтобы отработать возражения до
--    продажи. Остальное — как в 2026-10-15_zz_nps_surveys.sql (актуальное
--    определение функции — здесь).
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Прочитано -------------------------------------------------------------------

alter table public.nps_responses
  add column if not exists read_at timestamptz,
  add column if not exists read_by uuid references auth.users(id) on delete set null,
  add column if not exists read_by_name text;

comment on column public.nps_responses.read_at is
  'Когда сотрудник отметил ответ прочитанным («NPS-опросы» → «Статистика»); null — новый, в счётчике меню.';

update public.nps_responses
   set read_at = created_at
 where read_at is null and user_id is null;

create index if not exists nps_responses_unread_idx
  on public.nps_responses (studio_id) where read_at is null;

-- Кто и когда прочитал — ставит база; остальные поля ответа этот триггер не
-- трогает («Обработан» у критиков — отдельная отметка).
create or replace function public.nps_responses_read_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Из приложения (есть учётная запись клиента) — новый; внесённый
    -- сотрудником — сразу прочитан.
    if new.user_id is not null then
      new.read_at := null;
      new.read_by := null;
      new.read_by_name := null;
      return new;
    end if;
    new.read_at := now();
    new.read_by := auth.uid();
    new.read_by_name := (
      select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid());
    return new;
  end if;

  if new.read_at is not null and old.read_at is null then
    new.read_at := now();
    new.read_by := auth.uid();
    new.read_by_name := (
      select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid());
  elsif new.read_at is null then
    new.read_by := null;
    new.read_by_name := null;
  else
    new.read_at := old.read_at;
    new.read_by := old.read_by;
    new.read_by_name := old.read_by_name;
  end if;
  return new;
end;
$$;

revoke all on function public.nps_responses_read_biu() from public, anon, authenticated;

drop trigger if exists nps_responses_read_biu on public.nps_responses;
create trigger nps_responses_read_biu
  before insert or update on public.nps_responses
  for each row execute function public.nps_responses_read_biu();

-- 2. Какой опрос положен сейчас (перед продлением — без купивших продление) --------

create or replace function public.nps_pending_survey(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_cards uuid[];
  v_since date;
  v_newcomer boolean;
  v_candidates jsonb := '[]'::jsonb;  -- в порядке приоритета
  v_cand jsonb;
  v_prompt public.nps_survey_prompts%rowtype;
  v_last_shown timestamptz;
  v_prev_count int;
  v_prev_end date;
  r record;
  v record;
begin
  if p_user is null then
    return null;
  end if;
  select coalesce(array_agg(c.id), '{}') into v_cards from public.clients c where c.user_id = p_user;
  if cardinality(v_cards) = 0 then
    return null;
  end if;

  -- Новичок: самая ранняя дата клиента в базе — регистрация, первый абонемент
  -- (и пробный), первое посещение — не раньше 120 дней назад.
  select least(
    (select min(c.registration_date) from public.clients c where c.id = any(v_cards)),
    (select min(least(cm.started_at, (cm.created_at at time zone 'Asia/Tbilisi')::date))
       from public.client_memberships cm where cm.client_id = any(v_cards)),
    (select min((se.starts_at at time zone 'Asia/Tbilisi')::date)
       from public.schedule_bookings b
       join public.schedule_entries se on se.id = b.entry_id
      where (b.user_id = p_user or b.client_id = any(v_cards))
        and b.status = 'attended')
  ) into v_since;
  v_newcomer := v_since is null or v_since >= v_today - 120;

  -- После возобновления: последний купленный абонемент (не пробный) за 120
  -- дней, перед которым клиент был без абонемента дольше 14 дней. Конец
  -- прежнего: дата окончания; действующий без даты — не кончился; заменённый
  -- без даты — до покупки, которая его заменила; закончившийся без даты — по
  -- последнему списанному посещению. Возвращённый или отменённый до начала
  -- срока абонементом не считается.
  for r in
    select cm.id, cm.client_id, cm.created_at,
           coalesce(s.sold_at, (cm.created_at at time zone 'Asia/Tbilisi')::date) as bought_on
      from public.client_memberships cm
      join public.memberships m on m.id = cm.membership_id
      left join public.sales s on s.id = cm.sale_id
     where cm.client_id = any(v_cards)
       and coalesce(m.kind, 'package') not in ('trial', 'single')
       and cm.status <> 'refunded'
       and cm.created_at > v_now - interval '120 days'
     order by cm.created_at desc
  loop
    select count(*),
           max(case
                 when p.ends_at is not null then p.ends_at
                 when p.status in ('active', 'frozen', 'pending') then 'infinity'::date
                 when p.status = 'replaced' then coalesce(
                   (select min((n.created_at at time zone 'Asia/Tbilisi')::date)
                      from public.client_memberships n
                     where n.client_id = p.client_id
                       and n.created_at > p.created_at
                       and coalesce(n.balance_kind, 'group') = coalesce(p.balance_kind, 'group')),
                   (p.created_at at time zone 'Asia/Tbilisi')::date)
                 else coalesce(
                   (select max((se.starts_at at time zone 'Asia/Tbilisi')::date)
                      from public.schedule_bookings b
                      join public.schedule_entries se on se.id = b.entry_id
                     where b.charged_membership_id = p.id),
                   p.started_at,
                   (p.created_at at time zone 'Asia/Tbilisi')::date)
               end)
      into v_prev_count, v_prev_end
      from public.client_memberships p
      join public.memberships pm on pm.id = p.membership_id
     where p.client_id = any(v_cards)
       and p.id <> r.id
       and p.created_at < r.created_at
       and coalesce(pm.kind, 'package') not in ('trial', 'single')
       and not (p.status in ('refunded', 'cancelled') and p.started_at is null);

    if v_prev_count > 0 and v_prev_end < r.bought_on - 14 then
      select se.ends_at into v
        from public.schedule_bookings b
        join public.schedule_entries se on se.id = b.entry_id
       where (b.user_id = p_user or b.client_id = any(v_cards))
         and b.status = 'attended'
         and se.kind in ('group', 'personal')
         and (se.starts_at at time zone 'Asia/Tbilisi')::date >= r.bought_on
       order by se.starts_at, b.created_at
       offset 1 limit 1;
      if found and v.ends_at <= v_now and v.ends_at > v_now - interval '21 days' then
        v_candidates := v_candidates || jsonb_build_object(
          'survey_type', 'after_return', 'occasion', r.id::text, 'client_id', r.client_id);
      end if;
      exit;
    end if;
  end loop;

  -- Первые занятия: 4-е посещение закончилось.
  if v_newcomer then
    select b.client_id, se.ends_at into v
      from public.schedule_bookings b
      join public.schedule_entries se on se.id = b.entry_id
     where (b.user_id = p_user or b.client_id = any(v_cards))
       and b.status = 'attended'
       and se.kind in ('group', 'personal')
     order by se.starts_at, b.created_at
     offset 3 limit 1;
    if found and v.ends_at <= v_now and v.ends_at > v_now - interval '14 days' then
      v_candidates := v_candidates || jsonb_build_object(
        'survey_type', 'first_lessons', 'occasion', 'once', 'client_id', v.client_id);
    end if;
  end if;

  -- Первый месяц: 30 дней с начала первого абонемента, клиент ещё с нами.
  if v_newcomer then
    select cm.client_id, cm.started_at into v
      from public.client_memberships cm
      join public.memberships m on m.id = cm.membership_id
     where cm.client_id = any(v_cards)
       and coalesce(m.kind, 'package') not in ('trial', 'single')
       and cm.started_at is not null
     order by cm.started_at, cm.created_at
     limit 1;
    if found
       and v_today between v.started_at + 30 and v.started_at + 30 + 20
       and exists (
         select 1
           from public.client_memberships cm
           join public.memberships m on m.id = cm.membership_id
          where cm.client_id = any(v_cards)
            and coalesce(m.kind, 'package') not in ('trial', 'single')
            and cm.status not in ('refunded', 'cancelled')
            and ((cm.status in ('active', 'frozen', 'pending')
                  and (cm.ends_at is null or cm.ends_at >= v_today))
                 or cm.ends_at >= v_today - 14)
       ) then
      v_candidates := v_candidates || jsonb_build_object(
        'survey_type', 'first_month', 'occasion', 'once', 'client_id', v.client_id);
    end if;
  end if;

  -- Перед продлением: до окончания действующего абонемента 10 дней или меньше;
  -- в пакетном клубе — и когда осталось 2 тренировки или меньше. Остаток
  -- подписочных абонементов не списывается — по нему не смотрим. Продление
  -- уже куплено (следующий абонемент того же вида ждёт в очереди или уже
  -- оформлен) — не спрашиваем: опрос нужен, чтобы отработать возражения до
  -- продажи (решение владельца 2026-10-15).
  select cm.id, cm.client_id into v
    from public.client_memberships cm
    join public.memberships m on m.id = cm.membership_id
    join public.studios st on st.id = cm.studio_id
   where cm.client_id = any(v_cards)
     and coalesce(m.kind, 'package') not in ('trial', 'single')
     and cm.status = 'active'
     and cm.started_at is not null
     and (cm.ends_at is null or cm.ends_at >= v_today)
     and ((cm.ends_at is not null and cm.ends_at - 10 <= v_today)
          or (st.format = 'packages'
              and (case when cm.balance_kind = 'personal' then cm.personal_left
                        else cm.visits_left end) <= 2))
     and not exists (
       select 1
         from public.client_memberships nx
         join public.memberships nm on nm.id = nx.membership_id
        where nx.client_id = any(v_cards)
          and nx.id <> cm.id
          and nx.created_at > cm.created_at
          and coalesce(nm.kind, 'package') not in ('trial', 'single')
          and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
          and nx.status in ('pending', 'active', 'frozen'))
   order by cm.ends_at nulls last, cm.created_at
   limit 1;
  if found then
    v_candidates := v_candidates || jsonb_build_object(
      'survey_type', 'before_renewal', 'occasion', v.id::text, 'client_id', v.client_id);
  end if;

  if jsonb_array_length(v_candidates) = 0 then
    return null;
  end if;

  -- Показанный и не законченный (закрыли приложение) — снова, пока актуален.
  for v_cand in select value from jsonb_array_elements(v_candidates) loop
    select * into v_prompt
      from public.nps_survey_prompts p
     where p.user_id = p_user
       and p.survey_type = v_cand->>'survey_type'
       and p.occasion = v_cand->>'occasion';
    if found and v_prompt.closed_at is null and v_prompt.answered_at is null then
      return v_cand;
    end if;
  end loop;

  -- Новый — не чаще раза в 14 дней.
  select max(p.shown_at) into v_last_shown from public.nps_survey_prompts p where p.user_id = p_user;
  if v_last_shown > v_now - interval '14 days' then
    return null;
  end if;

  for v_cand in select value from jsonb_array_elements(v_candidates) loop
    -- Уже показывали — закрыт или отвечен.
    continue when exists (
      select 1 from public.nps_survey_prompts p
       where p.user_id = p_user
         and p.survey_type = v_cand->>'survey_type'
         and p.occasion = v_cand->>'occasion');
    if v_cand->>'survey_type' = 'before_renewal' then
      continue when v_last_shown > v_now - interval '30 days';
      continue when exists (
        select 1 from public.nps_survey_prompts p
         where p.user_id = p_user
           and p.survey_type = 'before_renewal'
           and p.shown_at > v_now - interval '90 days');
    end if;
    return v_cand;
  end loop;

  return null;
end;
$$;

revoke all on function public.nps_pending_survey(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
