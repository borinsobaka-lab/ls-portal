-- ============================================================================
-- Пакетные клубы: диагностика тела и заявки клиентов (решения владельца
-- 2026-10-15). «zz» — после 2026-10-15_push_delivery.sql.
--
-- Диагностика Lady Stretch: при покупке пакета (например, на 24, 36 или 50
-- занятий) в абонемент входят диагностики. Клиент отправляет заявку из
-- приложения, администратор согласует время с тренером и ставит диагностику в
-- расписание (тренер, начало и конец, клиент — как персональное занятие);
-- «Посетил» списывает одну диагностику с абонемента.
--
-- 1. Номенклатура: memberships.diagnostics_count — сколько диагностик в
--    абонементе (0 — нет). В «В подарок» не показываются — текст для клиента
--    администратор пишет в «Что входит».
-- 2. Абонемент клиента: client_memberships.diagnostics_left — остаток,
--    ставит client_memberships_packages_fill по номенклатуре (тело — как в
--    2026-10-11_zz_packages_personal_balance.sql, плюс диагностики).
-- 3. Расписание: schedule_entries.kind = 'diagnostic' — без тренировки, один
--    тренер и клиент (как персональное). Записывает только сотрудник
--    (schedule_bookings_group_only). Клиент видит СВОИ диагностики (политики
--    «… own diagnostic»: есть его запись) — вкладка «Диагностика» и главная
--    приложения, отменить может сам (cancel_schedule_booking, как запись на
--    тренировку). В зарплату диагностика идёт по ставке занятия
--    (pay_rate, пусто — 0): ставку владелец ещё не назвал.
-- 4. Списание: schedule_bookings_charge_balance (тело — как в
--    2026-10-13_zz_packages_test_fixes.sql, плюс ветка diagnostic) —
--    «Посетил» (и неуважительный пропуск) минус одна диагностика с
--    действующего абонемента с остатком диагностик (charged_balance =
--    'diagnostic'); без остатка «Посетил» не сохраняется. Сняли отметку,
--    удалили запись, отменили занятие — диагностика возвращается
--    (schedule_bookings_refund_on_delete — тело как в
--    2026-10-11_zzzzzzzz_review_fixes.sql, плюс диагностики). Первое
--    посещение по абонементу «с первого посещения» начинает срок — как
--    тренировка.
-- 5. packages_settle (тело — как в 2026-10-14_zz_packages_exhausted_expire.sql):
--    групповой абонемент без тренировок, но с диагностиками, без ждущего
--    продления — не «Закончился», пока диагностики не пройдены; на
--    отхоженный вернули диагностику (продления нет) — он снова текущий.
--    При начатом продлении остаток диагностик остаётся на прежнем — как
--    подарочные персональные (STUDIO_FORMATS.md, «Продление»).
-- 6. Вью client_packages_list (актуальное определение — здесь): остаток
--    diagnostics_left и diagnostics_count в memberships; guest_client_json
--    (гость в окне занятия) — с остатком диагностик.
-- 7. Заявки клиентов — client_requests: на персональные занятия (цели
--    клиента, комментарий) и на диагностику. Клиент создаёт только RPC
--    create_client_request (своя карточка, студия карточки; пока прежняя
--    заявка того же вида не отработана — новая не создаётся), читает свои;
--    сотрудник студии читает и отмечает «Отработано» (processed_at; кто и
--    когда — ставит триггер). Админка: «Обратная связь» → «Заявки» (раздел
--    клуба requests — открыт тем, у кого открыто «Расписание»).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Номенклатура ---------------------------------------------------------------

alter table public.memberships
  add column if not exists diagnostics_count int not null default 0;

alter table public.memberships drop constraint if exists memberships_diagnostics_count_check;
alter table public.memberships add constraint memberships_diagnostics_count_check
  check (diagnostics_count >= 0);

comment on column public.memberships.diagnostics_count is
  'Пакетные клубы: сколько диагностик тела входит в абонемент (0 — нет).';

-- 2. Абонемент клиента ------------------------------------------------------------

alter table public.client_memberships
  add column if not exists diagnostics_left int not null default 0;

comment on column public.client_memberships.diagnostics_left is
  'Пакетные клубы: остаток диагностик тела (из memberships.diagnostics_count), списывается при «Посетил» на диагностике.';

create or replace function public.client_memberships_packages_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_personal int;
  v_diagnostics int;
begin
  select m.kind, m.personal_count, m.diagnostics_count into v_kind, v_personal, v_diagnostics
    from public.memberships m
    join public.studios s on s.id = m.studio_id and s.format = 'packages'
   where m.id = new.membership_id;
  if found then
    new.personal_left := coalesce(v_personal, 0);
    new.diagnostics_left := coalesce(v_diagnostics, 0);
    if v_kind = 'personal' then
      new.balance_kind := 'personal';
      new.visits_left := 0;
    else
      new.balance_kind := 'group';
    end if;
  end if;
  return new;
end;
$$;

-- 3. Расписание: диагностика ----------------------------------------------------

alter table public.schedule_entries
  drop constraint if exists schedule_entries_kind_check;
alter table public.schedule_entries
  add constraint schedule_entries_kind_check
  check (kind in ('group', 'personal', 'diagnostic', 'other'));

alter table public.schedule_entries
  drop constraint if exists schedule_entries_kind_fields;
alter table public.schedule_entries
  add constraint schedule_entries_kind_fields
  check (
    (kind = 'group' and workout_id is not null)
    or (kind in ('personal', 'diagnostic') and workout_id is null)
    or (kind = 'other' and workout_id is null and nullif(btrim(title), '') is not null)
  );

comment on column public.schedule_entries.kind is
  'Тип занятия: group — групповое (тренировка), personal — персональное, diagnostic — диагностика тела, other — прочая активность.';

alter table public.schedule_bookings drop constraint if exists schedule_bookings_charged_balance_check;
alter table public.schedule_bookings add constraint schedule_bookings_charged_balance_check
  check (charged_balance is null or charged_balance in ('visits', 'personal', 'diagnostic'));

-- Записывает на персональное и диагностику только сотрудник (тело — как в
-- 2026-10-11_zzzzzzzz_review_fixes.sql).
create or replace function public.schedule_bookings_group_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.schedule_entries where id = new.entry_id;
  if v_kind = 'other' then
    raise exception 'На прочую активность записать нельзя';
  end if;
  if v_kind in ('personal', 'diagnostic') and not public.is_trainer(auth.uid(), new.studio_id) then
    raise exception 'На это занятие нельзя записаться: оно не групповое';
  end if;
  return new;
end;
$$;

-- Клиент видит свою диагностику: есть его запись. security definer — иначе
-- политика schedule_entries читала бы schedule_bookings под RLS.
create or replace function public.client_has_entry_booking(_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.schedule_bookings b
     where b.entry_id = _entry_id
       and b.user_id = auth.uid()
       and b.status in ('booked', 'attended', 'no_show')
  )
$$;

revoke all on function public.client_has_entry_booking(uuid) from public;
grant execute on function public.client_has_entry_booking(uuid) to authenticated;

drop policy if exists "schedule own diagnostic" on public.schedule_entries;
create policy "schedule own diagnostic" on public.schedule_entries
  for select to authenticated
  using (
    kind = 'diagnostic'
    and cancelled_at is null
    and public.client_has_entry_booking(id)
  );

drop policy if exists "set own diagnostic" on public.schedule_entry_trainers;
create policy "set own diagnostic" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and e.kind = 'diagnostic'
       and e.cancelled_at is null
       and public.client_has_entry_booking(e.id)
  ));

-- 4. Списание и возврат --------------------------------------------------------

create or replace function public.schedule_bookings_charge_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_starts timestamptz;
  v_date date;
  v_cm uuid;
  v_first_visit boolean;
  v_started date;
  v_was boolean := false;
  v_is boolean;
begin
  -- Причина пропуска живёт только вместе со статусом no_show: иначе запись,
  -- вернувшаяся в «записан», при массовой отметке пропусков (без причины)
  -- списалась бы по старой неуважительной причине.
  if new.status is distinct from 'no_show' then
    new.no_show_excused := null;
    new.no_show_comment := null;
  end if;

  v_is := new.status = 'attended' or (new.status = 'no_show' and new.no_show_excused is false);
  if tg_op = 'UPDATE' then
    v_was := old.status = 'attended' or (old.status = 'no_show' and old.no_show_excused is false);
  end if;

  -- Списание сняли — тренировка (диагностика) возвращается на тот же абонемент.
  if v_was and not v_is then
    if old.charged_membership_id is not null then
      if old.charged_balance = 'personal' then
        update public.client_memberships set personal_left = personal_left + 1
         where id = old.charged_membership_id;
      elsif old.charged_balance = 'diagnostic' then
        update public.client_memberships set diagnostics_left = diagnostics_left + 1
         where id = old.charged_membership_id;
      else
        update public.client_memberships set visits_left = visits_left + 1
         where id = old.charged_membership_id and visits_left is not null;
      end if;
      perform public.packages_restart_term(old.charged_membership_id, old.id);
      perform public.packages_settle(old.client_id);
    end if;
    new.charged_membership_id := null;
    new.charged_balance := null;
    return new;
  end if;

  if not v_is
     or v_was
     or new.charged_membership_id is not null
     or new.client_id is null
     or not exists (
       select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
     ) then
    return new;
  end if;

  select se.kind, se.starts_at into v_kind, v_starts
    from public.schedule_entries se where se.id = new.entry_id;
  v_date := coalesce((v_starts at time zone 'Asia/Tbilisi')::date,
                     (now() at time zone 'Asia/Tbilisi')::date);

  -- Срок продления, по которому ещё не ходили, не кончается (ends_at null);
  -- у начатого — обычная проверка конца срока.
  if v_kind = 'group' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and (cm.status = 'active'
            -- Продление — только если текущего того же вида нет: иначе
            -- ждущее списывалось и начинало срок, пока ходят по текущему.
            or (cm.status = 'pending' and not exists (
                  select 1 from public.client_memberships live
                   where live.client_id = cm.client_id
                     and live.balance_kind = cm.balance_kind
                     and live.status in ('active', 'frozen'))))
       and cm.visits_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set visits_left = visits_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'visits';
    end if;
  elsif v_kind = 'personal' then
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and (cm.status = 'active'
            or (cm.status = 'pending' and not exists (
                  select 1 from public.client_memberships live
                   where live.client_id = cm.client_id
                     and live.balance_kind = cm.balance_kind
                     and live.status in ('active', 'frozen'))))
       and cm.personal_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set personal_left = personal_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'personal';
    end if;
  elsif v_kind = 'diagnostic' then
    -- Диагностики — у абонемента любого вида баланса; сначала действующий,
    -- раньше кончающийся.
    select cm.id, cm.starts_on_first_visit, cm.started_at
      into v_cm, v_first_visit, v_started
      from public.client_memberships cm
     where cm.client_id = new.client_id
       and (cm.status = 'active'
            or (cm.status = 'pending' and not exists (
                  select 1 from public.client_memberships live
                   where live.client_id = cm.client_id
                     and live.balance_kind = cm.balance_kind
                     and live.status in ('active', 'frozen'))))
       and cm.diagnostics_left > 0
       and (cm.ends_at is null or cm.ends_at >= v_date)
     order by (cm.status = 'active') desc, cm.ends_at nulls last, cm.created_at
     limit 1
     for update;
    if v_cm is not null then
      update public.client_memberships set diagnostics_left = diagnostics_left - 1 where id = v_cm;
      new.charged_membership_id := v_cm;
      new.charged_balance := 'diagnostic';
    end if;
  end if;

  -- Решение владельца 2026-10-13: посещение без абонемента не отмечают —
  -- сначала продажа, с которой оно спишется.
  if v_cm is null and new.status = 'attended' and v_kind in ('group', 'personal') then
    raise exception 'У клиента нет абонемента с остатком тренировок — сначала оформите продажу абонемента'
      using errcode = 'P0001', hint = 'no_membership';
  end if;
  if v_cm is null and new.status = 'attended' and v_kind = 'diagnostic' then
    raise exception 'У клиента нет абонемента с диагностиками — сначала оформите продажу абонемента'
      using errcode = 'P0001', hint = 'no_diagnostics';
  end if;

  if v_cm is not null then
    -- Первое списание по абонементу «с первого посещения» (или более раннее,
    -- чем уже учтённое) — срок от даты этого занятия.
    if v_first_visit and (v_started is null or v_date < v_started) then
      update public.client_memberships cm
         set started_at = v_date,
             ends_at = case when m.duration_days is null then null
                            when cm.ends_at is not null and cm.started_at is not null
                              then cm.ends_at + (v_date - cm.started_at)
                            else v_date + m.duration_days end
        from public.memberships m
       where cm.id = v_cm and m.id = cm.membership_id;
    end if;
    perform public.packages_settle(new.client_id);
  end if;

  return new;
end;
$$;

create or replace function public.schedule_bookings_refund_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.charged_membership_id is not null then
    if old.charged_balance = 'personal' then
      update public.client_memberships set personal_left = personal_left + 1
       where id = old.charged_membership_id;
    elsif old.charged_balance = 'diagnostic' then
      update public.client_memberships set diagnostics_left = diagnostics_left + 1
       where id = old.charged_membership_id;
    else
      update public.client_memberships set visits_left = visits_left + 1
       where id = old.charged_membership_id and visits_left is not null;
    end if;
    perform public.packages_restart_term(old.charged_membership_id, old.id);
    if old.client_id is not null then
      perform public.packages_settle(old.client_id);
    end if;
  end if;
  -- Занятие, удаляемое целиком, к этому моменту уже удалено — update ничего
  -- не найдёт.
  if old.status = 'booked' then
    update public.schedule_entries
       set booked_count = greatest(0, booked_count - 1)
     where id = old.entry_id;
  elsif old.status = 'waitlist' then
    update public.schedule_entries
       set waitlist_count = greatest(0, waitlist_count - 1)
     where id = old.entry_id;
  end if;
  return old;
end;
$$;

-- 5. Очередь абонементов: диагностики держат отхоженный абонемент --------------

create or replace function public.packages_settle(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_balance text;
  v_live public.client_memberships%rowtype;
  v_old public.client_memberships%rowtype;
  v_has_live boolean;
  v_has_pending boolean;
begin
  if p_client_id is null or not exists (
    select 1 from public.clients c
      join public.studios st on st.id = c.studio_id and st.format = 'packages'
     where c.id = p_client_id
  ) then
    return;
  end if;
  -- Две отметки одного клиента одновременно не активируют два продления
  -- (второе падало на client_memberships_one_live_per_balance).
  perform 1 from public.clients where id = p_client_id for update;

  foreach v_balance in array array['group', 'personal'] loop
    select * into v_live from public.client_memberships
     where client_id = p_client_id and balance_kind = v_balance
       and status in ('active', 'frozen')
     limit 1;
    v_has_live := found;

    -- Вернули тренировку на исчерпанный прежний абонемент, а продление ещё
    -- не начато — прежний снова текущий, продление снова ждёт.
    if v_has_live and v_live.status = 'active' and v_live.starts_on_first_visit
       and v_live.started_at is null then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and id <> v_live.id
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end)
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'pending' where id = v_live.id;
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_live := v_old;
        v_live.status := 'active';
      end if;
    end if;

    -- Текущий кончился (основной остаток или срок), а продление ждёт.
    if v_has_live and v_live.status = 'active'
       and ((v_balance = 'personal' and v_live.personal_left <= 0)
            or (v_balance = 'group' and v_live.visits_left is not null and v_live.visits_left <= 0)
            or (v_live.ends_at is not null and v_live.ends_at < v_today))
       and exists (
         select 1 from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
       ) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    -- Текущий отхожен целиком (и диагностики пройдены), продления нет —
    -- «Закончился».
    if v_has_live and v_live.status = 'active'
       and coalesce(v_live.diagnostics_left, 0) <= 0
       and (case when v_balance = 'personal' then coalesce(v_live.personal_left, 0) <= 0
                 else v_live.visits_left is not null and v_live.visits_left <= 0
                      and coalesce(v_live.personal_left, 0) <= 0 end) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    v_has_pending := exists (
      select 1 from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
    );

    -- Текущего нет, а на отхоженный вернули тренировку (или, без ждущего
    -- продления, диагностику) — он снова текущий.
    if not v_has_live then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end
              or (not v_has_pending and diagnostics_left > 0))
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_has_live := true;
      end if;
    end if;

    -- Текущего нет — ждущий (самый ранний по продаже) становится текущим.
    if not v_has_live then
      update public.client_memberships
         set status = 'active'
       where id = (
         select id from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
          order by created_at
          limit 1
       );
    end if;
  end loop;
end;
$$;

revoke all on function public.packages_settle(uuid) from public, anon, authenticated;

-- 6. Вью «Абонементов» ----------------------------------------------------------
-- Как в 2026-10-13_zzz_packages_refund_state.sql, кроме diagnostics_count в
-- memberships и колонки diagnostics_left в конце.

create or replace view public.client_packages_list
with (security_invoker = true) as
select
  s.id,
  s.studio_id,
  s.client_id,
  s.membership_id,
  s.admin_name,
  s.trainer_id,
  s.trainer_name,
  s.sold_at,
  s.total_amount,
  s.sale_kind,
  s.comment,
  s.membership_note,
  s.created_at,
  coalesce(cl.last_name, '') || ' ' ||
  coalesce(cl.first_name, '') || ' ' ||
  coalesce(cl.full_name, '') || ' ' ||
  coalesce(cl.phone, '') || ' ' ||
  coalesce(cl.phone2, '') || ' ' ||
  coalesce(cl.email, '') || ' ' ||
  coalesce(m.name, '') || ' ' ||
  coalesce(s.trainer_name, '') || ' ' ||
  coalesce(s.admin_name, '') as search_text,
  case
    when cl.id is null then null
    else json_build_object(
      'id', cl.id,
      'full_name', cl.full_name,
      'first_name', cl.first_name,
      'last_name', cl.last_name,
      'phone', cl.phone,
      'email', cl.email
    )
  end as clients,
  case
    when m.id is null then null
    else json_build_object(
      'id', m.id,
      'name', m.name,
      'kind', m.kind,
      'visits_count', m.visits_count,
      'personal_count', m.personal_count,
      'diagnostics_count', m.diagnostics_count
    )
  end as memberships,
  cm.status as membership_status,
  cm.visits_left,
  cm.personal_left,
  cm.ends_at,
  pay.payments,
  pay.paid_amount,
  pay.next_due_date,
  case
    when cm.status = 'refunded' or pay.refunded_count > 0 then 'refunded'
    when pay.unpaid_count = 0 then 'paid'
    when pay.next_due_date < (now() at time zone 'Asia/Tbilisi')::date then 'overdue'
    when pay.next_due_date <= (now() at time zone 'Asia/Tbilisi')::date + 2 then 'soon'
    else 'pending'
  end as payment_state,
  cm.started_at as membership_started_at,
  coalesce(cm.starts_on_first_visit, false) as starts_on_first_visit,
  s.source,
  s.promo_code,
  cm.diagnostics_left
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.personal_left, c.ends_at, c.started_at,
         c.starts_on_first_visit, c.diagnostics_left
    from public.client_memberships c
   where c.sale_id = s.id
   order by c.created_at desc
   limit 1
) cm on true
cross join lateral (
  select
    case
      when count(i.id) = 0 then json_build_array(json_build_object(
        'id', null,
        'amount', s.total_amount,
        'due_date', s.sold_at,
        'paid', true,
        'paid_at', s.sold_at,
        'payment_method', s.payment_method,
        'refunded', false
      ))
      else json_agg(json_build_object(
        'id', i.id,
        'amount', i.amount,
        'due_date', i.due_date,
        'paid', i.paid,
        'paid_at', i.paid_at,
        'payment_method', i.payment_method,
        'refunded', i.refunded
      ) order by i.due_date, i.created_at)
    end as payments,
    case
      when count(i.id) = 0 then s.total_amount
      else coalesce(sum(i.amount) filter (where i.paid), 0)
    end as paid_amount,
    min(i.due_date) filter (where not i.paid and not i.refunded) as next_due_date,
    count(i.id) filter (where not i.paid and not i.refunded) as unpaid_count,
    count(i.id) filter (where i.refunded) as refunded_count
  from public.sale_installments i
  where i.sale_id = s.id
) pay;

grant select on public.client_packages_list to authenticated;

-- Гость из другого клуба сети на диагностике: остаток диагностик в окне
-- занятия (тело — как в 2026-10-14_network_guest_visits.sql, плюс
-- diagnostics_left).

create or replace function public.guest_client_json(_client_id uuid, _ahead int default 0)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'user_id', c.user_id,
    'first_name', c.first_name,
    'last_name', c.last_name,
    'full_name', c.full_name,
    'phone', c.phone,
    'home_studio_id', c.studio_id,
    'home_studio_name', s.name,
    'ahead', coalesce(_ahead, 0),
    -- Действующие и ждущие продления: остаток в окне занятия считается с
    -- продлением, как у клиентов своего клуба (lib/booking-coverage.ts).
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', cm.client_id,
               'status', cm.status,
               'started_at', cm.started_at,
               'ends_at', cm.ends_at,
               'visits_left', cm.visits_left,
               'personal_left', cm.personal_left,
               'diagnostics_left', cm.diagnostics_left,
               'balance_kind', cm.balance_kind,
               'membership', jsonb_build_object('name', m.name)
             ) order by cm.created_at)
        from public.client_memberships cm
        left join public.memberships m on m.id = cm.membership_id
       where cm.client_id = c.id and cm.status in ('active', 'pending')
    ), '[]'::jsonb)
  )
    from public.clients c
    join public.studios s on s.id = c.studio_id
   where c.id = _client_id
$$;

-- Вспомогательная: вызывать только из функций ниже, которые проверяют права.
-- Supabase по умолчанию выдаёт EXECUTE новым функциям anon и authenticated —
-- забираем явно, иначе по id клиента любой получил бы его имя и телефон.
revoke all on function public.guest_client_json(uuid, int) from public, anon, authenticated;

-- 7. Заявки клиентов ------------------------------------------------------------

create table if not exists public.client_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  kind text not null,
  goals text[] not null default '{}',
  goal_other text,
  comment text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid references auth.users (id) on delete set null,
  processed_by_name text
);

alter table public.client_requests drop constraint if exists client_requests_kind_check;
alter table public.client_requests add constraint client_requests_kind_check
  check (kind in ('personal', 'diagnostic'));

comment on table public.client_requests is
  'Заявки клиентов из приложения: на персональные занятия (цели, комментарий) и на диагностику. «Отработано» — processed_at.';
comment on column public.client_requests.goals is
  'Цели клиента — ключи fitness_goal (flexibility, stress_relief, body_shape, other…); текст «Другое» — goal_other.';

create index if not exists client_requests_studio_open_idx
  on public.client_requests (studio_id, created_at desc)
  where processed_at is null;
create index if not exists client_requests_studio_created_idx
  on public.client_requests (studio_id, created_at desc);
create index if not exists client_requests_client_idx
  on public.client_requests (client_id);

grant select, update, delete on public.client_requests to authenticated;
grant all on public.client_requests to service_role;

alter table public.client_requests enable row level security;

-- Клиент читает свои заявки (статус «отправлена» в приложении); создаёт —
-- только create_client_request.
drop policy if exists "client_requests own select" on public.client_requests;
create policy "client_requests own select" on public.client_requests
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "client_requests staff" on public.client_requests;
create policy "client_requests staff" on public.client_requests
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));

-- «Отработано»: кто и когда — ставит база; заявку сотрудник не переписывает.
create or replace function public.client_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.studio_id := old.studio_id;
  new.client_id := old.client_id;
  new.user_id := old.user_id;
  new.kind := old.kind;
  new.goals := old.goals;
  new.goal_other := old.goal_other;
  new.comment := old.comment;
  new.created_at := old.created_at;
  if new.processed_at is not null and old.processed_at is null then
    new.processed_at := now();
    new.processed_by := auth.uid();
    new.processed_by_name := (
      select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid()
    );
  elsif new.processed_at is null then
    new.processed_by := null;
    new.processed_by_name := null;
  else
    new.processed_at := old.processed_at;
    new.processed_by := old.processed_by;
    new.processed_by_name := old.processed_by_name;
  end if;
  return new;
end;
$$;

revoke all on function public.client_requests_guard() from public, anon, authenticated;

drop trigger if exists client_requests_guard_bu on public.client_requests;
create trigger client_requests_guard_bu
  before update on public.client_requests
  for each row execute function public.client_requests_guard();

-- Заявка из приложения: карточка клиента (своя студия — первой), студия
-- карточки. Пока прежняя заявка того же вида не отработана — новая не
-- создаётся (reason pending, created_at прежней).
create or replace function public.create_client_request(
  p_kind text,
  p_goals text[] default '{}',
  p_goal_other text default null,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_client public.clients%rowtype;
  v_open public.client_requests%rowtype;
  v_goals text[];
  v_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  if p_kind is null or p_kind not in ('personal', 'diagnostic') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;

  select * into v_client from public.clients
   where user_id = v_uid
   order by (studio_id = public.current_studio_id(v_uid)) desc nulls last
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_client');
  end if;

  select * into v_open from public.client_requests
   where client_id = v_client.id and kind = p_kind and processed_at is null
   order by created_at desc
   limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'pending', 'created_at', v_open.created_at);
  end if;

  -- Цели — короткие ключи, не больше десяти; текст — с ограничением длины.
  select coalesce(array_agg(distinct left(btrim(g), 40)), '{}') into v_goals
    from unnest(coalesce(p_goals, '{}')) g
   where nullif(btrim(g), '') is not null;
  if coalesce(array_length(v_goals, 1), 0) > 10 then
    v_goals := v_goals[1:10];
  end if;

  insert into public.client_requests (studio_id, client_id, user_id, kind, goals, goal_other, comment)
  values (
    v_client.studio_id, v_client.id, v_uid, p_kind,
    case when p_kind = 'personal' then v_goals else '{}' end,
    case when p_kind = 'personal' then left(nullif(btrim(p_goal_other), ''), 300) end,
    left(nullif(btrim(p_comment), ''), 1000)
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.create_client_request(text, text[], text, text) from public;
grant execute on function public.create_client_request(text, text[], text, text) to authenticated;

-- Права: «Заявки» — тем, у кого в пакетном клубе открыто «Расписание»
-- (диагностику по заявке ставят туда). Нет строки прав — открыто всё и так.
update public.admin_studio_permissions p
   set sections = array_append(p.sections, 'requests'),
       updated_at = now()
  from public.studios st
 where st.id = p.studio_id
   and st.format = 'packages'
   and 'schedule' = any(p.sections)
   and not 'requests' = any(p.sections);

notify pgrst, 'reload schema';
