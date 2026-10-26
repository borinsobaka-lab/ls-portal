-- ============================================================================
-- NPS-опросы в клиентском приложении (решение владельца 2026-10-15)
-- ============================================================================
-- Опрос показывается клиенту модальным окном в приложении (оба формата), его
-- можно закрыть крестиком и не пройти. Имя — из карточки клиента, язык —
-- языка приложения, вид опроса приложение не выбирает: какой опрос положен
-- сейчас, решает база (nps_pending_survey).
--
-- Когда положен опрос (даты — по Тбилиси):
--   first_lessons  «Первые занятия» — закончилось 4-е посещение клиента
--                  («Посетил», групповое или персональное, в любой студии
--                  сети). Актуален 14 дней.
--   first_month    «Первый месяц» — через 30 дней после начала первого
--                  абонемента (пробное и разовое посещение — не абонемент,
--                  здесь и ниже, как на дашборде и в триггерах; в пакетном
--                  клубе начало — первое посещение). Следующие абонементы его не
--                  вызывают. Актуален 21 день; только если клиент ещё с нами
--                  (есть действующий абонемент или закончился не больше 14
--                  дней назад).
--   before_renewal «Перед продлением» — за 10 дней до окончания текущего
--                  абонемента, в пакетном клубе и когда осталось 2 тренировки
--                  или меньше (абонемент кончается и по остатку). Актуален,
--                  пока абонемент действует. Раз на абонемент.
--   after_return   «После возобновления» — клиент был членом клуба, остался
--                  без абонемента дольше 14 дней (БЧК; тот же порог, что
--                  «возврат» на дашборде) и купил абонемент снова: после 2-го
--                  посещения по возвращении. Актуален 21 день. Раз на
--                  возвращение.
-- «Первые занятия» и «Первый месяц» — только новичкам: клиент появился в
-- базе (регистрация, первый абонемент или первое посещение) не раньше 120
-- дней назад. Иначе давний клиент, перенесённый из прежней системы без
-- истории посещений, получил бы «Как вам первые занятия?».
--
-- Частота: не больше одного опроса в 14 дней (показали — закрыт или отвечен,
-- неважно); «Перед продлением» — не раньше чем через 30 дней после любого
-- опроса и не чаще раза в 90 дней (у месячных пакетов иначе — каждый месяц,
-- а новичок получал бы три опроса за первый месяц). Несколько положенных
-- сразу — по приоритету: после возобновления, первые занятия, первый месяц,
-- перед продлением. Показанный, но не закрытый и не отвеченный опрос
-- (закрыли приложение) показывается снова, пока актуален.
--
-- Показы — nps_survey_prompts (строка на клиента, вид и повод: once или id
-- абонемента), ответы — nps_responses (+ user_id, client_id). Приложение
-- пишет только через RPC: my_nps_survey → nps_survey_shown →
-- submit_nps_response / nps_survey_close. Вставка в nps_responses напрямую —
-- теперь только сотрудник («Добавить ответ» в админке); было — любой
-- вошедший. Удалённая карточка клиента — ответ остаётся без имени.
--
-- «Общий» опрос (general) приложение не показывает: механика не продумана.
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

-- 1. Ответы ---------------------------------------------------------------------
-- db/nps.sql и db/feedback_nps_studio.sql выполнялись вручную — на чистой базе
-- таблицы может не быть.

create table if not exists public.nps_responses (
  id uuid primary key default gen_random_uuid(),
  score int not null check (score between 0 and 10),
  client_name text,
  comment text,
  language text default 'ru',
  survey_type text not null default 'general'
    check (survey_type in ('first_lessons','first_month','before_renewal','after_return','general')),
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.nps_responses
  add column if not exists studio_id uuid references public.studios(id) on delete set null,
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists client_id uuid references public.clients(id) on delete set null;

comment on column public.nps_responses.user_id is
  'Учётная запись клиента, ответившего в приложении (null — ответ внесён в админке).';
comment on column public.nps_responses.client_id is
  'Карточка клиента, ответившего в приложении (null — ответ внесён в админке).';

create index if not exists nps_responses_created_idx on public.nps_responses (created_at desc);
create index if not exists nps_responses_studio_created_idx
  on public.nps_responses (studio_id, created_at desc);
create index if not exists nps_responses_client_idx on public.nps_responses (client_id);

grant select, insert, update, delete on public.nps_responses to authenticated;
grant all on public.nps_responses to service_role;

alter table public.nps_responses enable row level security;

-- Как в db/security_hardening.sql, кроме вставки: клиент отвечает только через
-- submit_nps_response, напрямую пишет сотрудник.
drop policy if exists "nps read all auth" on public.nps_responses;
drop policy if exists "nps write all auth" on public.nps_responses;
drop policy if exists "nps staff select" on public.nps_responses;
drop policy if exists "nps auth insert" on public.nps_responses;
drop policy if exists "nps staff insert" on public.nps_responses;
drop policy if exists "nps staff update" on public.nps_responses;
drop policy if exists "nps staff delete" on public.nps_responses;
create policy "nps staff select" on public.nps_responses
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "nps staff insert" on public.nps_responses
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "nps staff update" on public.nps_responses
  for update to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy "nps staff delete" on public.nps_responses
  for delete to authenticated using (public.is_staff(auth.uid()));

-- Удалена карточка клиента — ответ остаётся в статистике NPS, но без имени и
-- без связи с учётной записью (политика конфиденциальности, раздел 9).
create or replace function public.nps_responses_anonymize_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.nps_responses
     set client_name = null, user_id = null
   where client_id = old.id;
  return old;
end;
$$;

revoke all on function public.nps_responses_anonymize_client() from public, anon, authenticated;

drop trigger if exists clients_nps_anonymize_bd on public.clients;
create trigger clients_nps_anonymize_bd
  before delete on public.clients
  for each row execute function public.nps_responses_anonymize_client();

-- 2. Показы ---------------------------------------------------------------------

create table if not exists public.nps_survey_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  survey_type text not null
    check (survey_type in ('first_lessons','first_month','before_renewal','after_return')),
  -- Повод: 'once' (первые занятия, первый месяц) или id абонемента клиента
  -- (перед продлением — какой кончается, после возобновления — купленный).
  occasion text not null,
  client_id uuid references public.clients(id) on delete set null,
  studio_id uuid references public.studios(id) on delete set null,
  shown_at timestamptz not null default now(),
  closed_at timestamptz,
  answered_at timestamptz,
  response_id uuid references public.nps_responses(id) on delete set null,
  unique (user_id, survey_type, occasion)
);

comment on table public.nps_survey_prompts is
  'Показы NPS-опросов в приложении: кому, какой, закрыт крестиком (closed_at) или отвечен (answered_at). Пишут только RPC.';

create index if not exists nps_survey_prompts_user_shown_idx
  on public.nps_survey_prompts (user_id, shown_at desc);
create index if not exists nps_survey_prompts_studio_idx
  on public.nps_survey_prompts (studio_id, survey_type);

grant select on public.nps_survey_prompts to authenticated;
grant all on public.nps_survey_prompts to service_role;

alter table public.nps_survey_prompts enable row level security;

-- Читает сотрудник (статистика показов в «NPS-опросах»), как и ответы.
drop policy if exists "nps prompts staff select" on public.nps_survey_prompts;
create policy "nps prompts staff select" on public.nps_survey_prompts
  for select to authenticated using (public.is_staff(auth.uid()));

-- 3. Какой опрос положен сейчас ------------------------------------------------
-- Возвращает {survey_type, occasion, client_id} или null. Только для RPC ниже.

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
  -- подписочных абонементов не списывается — по нему не смотрим.
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

-- Строка показа опроса, который положен клиенту сейчас (или уже показанного):
-- id строки или null, если такого опроса клиенту не положено.
create or replace function public.nps_open_prompt(p_user uuid, p_survey_type text, p_occasion text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v jsonb;
  v_client uuid;
  v_studio uuid;
begin
  select p.id into v_id
    from public.nps_survey_prompts p
   where p.user_id = p_user and p.survey_type = p_survey_type and p.occasion = p_occasion;
  if found then
    return v_id;
  end if;

  v := public.nps_pending_survey(p_user);
  if v is null
     or v->>'survey_type' is distinct from p_survey_type
     or v->>'occasion' is distinct from p_occasion then
    return null;
  end if;

  v_client := coalesce(
    (v->>'client_id')::uuid,
    (select c.id from public.clients c where c.user_id = p_user order by c.created_at limit 1));
  select c.studio_id into v_studio from public.clients c where c.id = v_client;

  insert into public.nps_survey_prompts (user_id, survey_type, occasion, client_id, studio_id)
  values (p_user, p_survey_type, p_occasion, v_client, v_studio)
  on conflict (user_id, survey_type, occasion) do nothing
  returning id into v_id;
  if v_id is null then
    select p.id into v_id
      from public.nps_survey_prompts p
     where p.user_id = p_user and p.survey_type = p_survey_type and p.occasion = p_occasion;
  end if;
  return v_id;
end;
$$;

revoke all on function public.nps_open_prompt(uuid, text, text) from public, anon, authenticated;

-- 4. RPC приложения --------------------------------------------------------------

-- Какой опрос показать: {survey_type, occasion} или null.
create or replace function public.my_nps_survey()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;
  v := public.nps_pending_survey(auth.uid());
  if v is null then
    return null;
  end if;
  return jsonb_build_object('survey_type', v->>'survey_type', 'occasion', v->>'occasion');
end;
$$;

-- Окно опроса открылось.
create or replace function public.nps_survey_shown(p_survey_type text, p_occasion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  perform public.nps_open_prompt(auth.uid(), p_survey_type, p_occasion);
end;
$$;

-- Закрыт крестиком без ответа — больше этот опрос не показывается.
create or replace function public.nps_survey_close(p_survey_type text, p_occasion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  v_id := public.nps_open_prompt(auth.uid(), p_survey_type, p_occasion);
  update public.nps_survey_prompts
     set closed_at = now()
   where id = v_id and closed_at is null and answered_at is null;
end;
$$;

-- Ответ: оценка 0–10 и обязательный комментарий. Имя — из карточки клиента,
-- клуб — клуб карточки. Возвращает id ответа.
create or replace function public.submit_nps_response(
  p_survey_type text,
  p_occasion text,
  p_score int,
  p_comment text,
  p_language text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_prompt public.nps_survey_prompts%rowtype;
  v_id uuid;
  v_name text;
  v_response uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_score is null or p_score < 0 or p_score > 10 then
    raise exception 'Оценка — от 0 до 10' using errcode = '22023', hint = 'invalid_score';
  end if;
  if v_comment is null then
    raise exception 'Ответьте на вопрос' using errcode = '22023', hint = 'comment_required';
  end if;

  v_id := public.nps_open_prompt(v_uid, p_survey_type, p_occasion);
  if v_id is null then
    raise exception 'Этот опрос сейчас недоступен' using errcode = 'P0001', hint = 'survey_not_available';
  end if;
  select * into v_prompt from public.nps_survey_prompts where id = v_id for update;
  if v_prompt.answered_at is not null then
    raise exception 'Вы уже ответили на этот опрос' using errcode = 'P0001', hint = 'already_answered';
  end if;
  if v_prompt.closed_at is not null then
    raise exception 'Этот опрос закрыт' using errcode = 'P0001', hint = 'survey_closed';
  end if;

  select coalesce(nullif(btrim(concat_ws(' ', c.last_name, c.first_name)), ''), c.full_name)
    into v_name
    from public.clients c where c.id = v_prompt.client_id;

  insert into public.nps_responses (
    studio_id, score, client_name, comment, language, survey_type, user_id, client_id
  ) values (
    v_prompt.studio_id, p_score, v_name, left(v_comment, 2000),
    case when p_language in ('en', 'ka', 'ru') then p_language else 'en' end,
    p_survey_type, v_uid, v_prompt.client_id
  )
  returning id into v_response;

  update public.nps_survey_prompts
     set answered_at = now(), response_id = v_response
   where id = v_id;
  return v_response;
end;
$$;

-- 5. Статистика показов для админки ---------------------------------------------
-- Счётчики по видам опроса (клуб — клуб карточки клиента; null — все, что
-- видит сотрудник). security invoker: читает по RLS, клиенту — пусто.
create or replace function public.nps_prompt_stats(p_studio_id uuid)
returns table (survey_type text, shown bigint, answered bigint, closed bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select p.survey_type, count(*), count(p.answered_at), count(p.closed_at)
    from public.nps_survey_prompts p
   where p_studio_id is null or p.studio_id = p_studio_id
   group by p.survey_type;
$$;

revoke all on function public.nps_prompt_stats(uuid) from public, anon;
grant execute on function public.nps_prompt_stats(uuid) to authenticated;

revoke all on function public.my_nps_survey() from public, anon;
revoke all on function public.nps_survey_shown(text, text) from public, anon;
revoke all on function public.nps_survey_close(text, text) from public, anon;
revoke all on function public.submit_nps_response(text, text, int, text, text) from public, anon;
grant execute on function public.my_nps_survey() to authenticated;
grant execute on function public.nps_survey_shown(text, text) to authenticated;
grant execute on function public.nps_survey_close(text, text) to authenticated;
grant execute on function public.submit_nps_response(text, text, int, text, text) to authenticated;

notify pgrst, 'reload schema';
