-- ============================================================================
-- Пакетные клубы: правки после тестирования (2026-10-13)
-- ============================================================================
-- Постановка владельца 2026-10-13 (16 пунктов), здесь — то, что требует базы:
--
-- 1. Роль сотрудника «Старший администратор» (trainers.role = 'senior_admin'):
--    тот же администратор (продажи, смены, вкладка «Админы» в приложении),
--    подпись своя.
-- 2. Замена тренера на занятии — schedule_entry_substitutions: тренер занятия
--    (строка schedule_entry_trainers) заменяет другого тренера. Приложение
--    показывает «Замена» и прежнего тренера неактивным. Правка тренера без
--    замены (ошиблись при заведении) строку не создаёт.
-- 3. Возврат по абонементу пакетного клуба (insert в refunds): абонемент —
--    статус refunded («Возврат»), невнесённые платежи рассрочки — refunded
--    (в «Абонементах» вместо суммы и даты — «Возврат», в фильтры по платежам
--    не попадают), будущие и неотмеченные записи клиента на занятия этого
--    вида баланса удаляются вместе с журналом (решение владельца: удалять, а
--    не отменять — для чистоты статистики), если другого абонемента того же
--    вида у клиента нет.
-- 4. Новая продажа пакетного клуба (не только продление) — срок с первого
--    посещения: абонемент «ожидает посещения» (active, starts_on_first_visit,
--    started_at/ends_at пустые), срок начинается с даты первого посещения.
-- 5. «Посетил» без абонемента с остатком — нельзя: сначала продажа (триггер
--    списания падает с понятным текстом). Записаться клиент может и сверх
--    остатка (book_schedule_entry проверяет только, что остаток > 0, — не
--    меняется).
-- 6. Клиент читает свои продажи и график платежей (политики из
--    db/sales_client_rls.sql, выполнявшегося вручную) — «Следующие платежи» у
--    абонемента в приложении.
--
-- Порядок: файл идёт после 2026-10-13_packages_memberships_sales_merge.sql —
-- вью client_packages_list пересоздаётся здесь (актуальное определение).
-- ============================================================================

-- 1. Роль «Старший администратор» ---------------------------------------------

alter table public.trainers drop constraint if exists trainers_role_check;
alter table public.trainers add constraint trainers_role_check
  check (role in ('trainer', 'admin', 'senior_admin', 'masseur'));

comment on column public.trainers.role is
  'Кем работает сотрудник: trainer — тренер, admin — администратор, senior_admin — старший администратор, masseur — массажист.';

-- 2. Замена тренера -------------------------------------------------------------
-- Ключ — тренер занятия (entry_id, trainer_id): сняли его с занятия — замена
-- уходит вместе с ним. replaced_trainer_id — кого заменили. Связь с
-- trainers — одна (replaced_trainer_id не входит в первичный ключ), поэтому
-- PostgREST не видит здесь связки «многие ко многим», и прежние запросы
-- schedule_entry_trainers(trainer:trainers(...)) остаются однозначными.

create table if not exists public.schedule_entry_substitutions (
  entry_id uuid not null,
  trainer_id uuid not null,
  replaced_trainer_id uuid not null references public.trainers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, trainer_id),
  foreign key (entry_id, trainer_id)
    references public.schedule_entry_trainers(entry_id, trainer_id) on delete cascade,
  constraint schedule_entry_substitutions_not_self check (replaced_trainer_id <> trainer_id)
);

comment on table public.schedule_entry_substitutions is
  'Замена тренера на занятии: trainer_id (тренер занятия) заменяет replaced_trainer_id. Видна клиентам в приложении.';

grant select, insert, update, delete on public.schedule_entry_substitutions to authenticated;
grant all on public.schedule_entry_substitutions to service_role;

alter table public.schedule_entry_substitutions enable row level security;

drop policy if exists "subs studio select" on public.schedule_entry_substitutions;
create policy "subs studio select" on public.schedule_entry_substitutions
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and e.studio_id = public.current_studio_id(auth.uid())
       and ((e.kind = 'group' and e.cancelled_at is null)
            or public.is_trainer(auth.uid(), e.studio_id))
  ));

drop policy if exists "subs client browse" on public.schedule_entry_substitutions;
create policy "subs client browse" on public.schedule_entry_substitutions
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and e.kind = 'group'
       and e.cancelled_at is null
       and public.client_can_browse_studio(e.studio_id)
  ));

drop policy if exists "subs trainer write" on public.schedule_entry_substitutions;
create policy "subs trainer write" on public.schedule_entry_substitutions
  for all to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and public.is_trainer(auth.uid(), e.studio_id)
  ))
  with check (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and public.is_trainer(auth.uid(), e.studio_id)
  ));

-- 3. Возврат --------------------------------------------------------------------

alter table public.sale_installments
  add column if not exists refunded boolean not null default false;

comment on column public.sale_installments.refunded is
  'Платёж снят возвратом по продаже (пакетные клубы): не вносится, в фильтры по платежам не попадает.';

-- refunded — оформлен возврат (пакетные клубы). not valid: как в
-- 2026-10-11_zzz_packages_renewal_queue.sql, старые строки не перепроверяем.
alter table public.client_memberships drop constraint if exists client_memberships_status_check;
alter table public.client_memberships add constraint client_memberships_status_check
  check (status in ('active', 'frozen', 'pending', 'replaced', 'expired', 'cancelled', 'refunded'))
  not valid;

create or replace function public.refunds_packages_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_cm public.client_memberships%rowtype;
  v_balance text;
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_bookings uuid[];
begin
  if new.sale_id is null then
    return new;
  end if;
  select * into v_sale from public.sales where id = new.sale_id;
  if not found or not exists (
    select 1 from public.studios st where st.id = v_sale.studio_id and st.format = 'packages'
  ) then
    return new;
  end if;

  -- Невнесённые платежи больше не ждём.
  update public.sale_installments
     set refunded = true
   where sale_id = v_sale.id and not paid and not refunded;

  -- Абонемент по продаже — «Возврат» (повторный возврат по той же продаже
  -- ничего не меняет: абонемент уже refunded).
  select * into v_cm from public.client_memberships
   where sale_id = v_sale.id and status in ('active', 'frozen', 'pending')
   order by created_at desc
   limit 1
   for update;
  if not found then
    return new;
  end if;
  v_balance := coalesce(v_cm.balance_kind, 'group');
  update public.client_memberships set status = 'refunded' where id = v_cm.id;

  -- Записи клиента, по которым ещё не отмечено посещение, — удаляются, если
  -- другого абонемента того же вида нет (иначе запись спишется с него).
  -- Групповой абонемент — групповые занятия, персональный — персональные.
  if v_cm.client_id is not null and not exists (
    select 1 from public.client_memberships cm
     where cm.client_id = v_cm.client_id
       and cm.id <> v_cm.id
       and cm.balance_kind = v_balance
       and cm.status in ('active', 'frozen', 'pending')
       and (cm.ends_at is null or cm.ends_at >= v_today)
  ) then
    select coalesce(array_agg(b.id), '{}') into v_bookings
      from public.schedule_bookings b
      join public.schedule_entries se on se.id = b.entry_id
     where b.client_id = v_cm.client_id
       and b.status in ('booked', 'waitlist')
       and se.kind = case when v_balance = 'personal' then 'personal' else 'group' end;
    if array_length(v_bookings, 1) > 0 then
      delete from public.bookings_log where booking_id = any(v_bookings);
      -- Места и лист ожидания освобождает schedule_bookings_refund_ad.
      delete from public.schedule_bookings where id = any(v_bookings);
    end if;
  end if;

  perform public.packages_settle(v_cm.client_id);
  return new;
end;
$$;

revoke all on function public.refunds_packages_apply() from public, anon, authenticated;

-- refunds — из db/sales_payment.sql (выполнялся вручную): на чистой базе
-- таблицы может не быть.
do $$
begin
  if to_regclass('public.refunds') is not null then
    execute 'drop trigger if exists refunds_packages_apply_ai on public.refunds';
    execute 'create trigger refunds_packages_apply_ai after insert on public.refunds
               for each row execute function public.refunds_packages_apply()';
  end if;
end;
$$;

-- 4. Новая продажа — срок с первого посещения ---------------------------------
-- Тело — как в 2026-10-11_zzz_packages_renewal_queue.sql, кроме: в пакетном
-- клубе и обычная продажа (новая, пробное, допродажа, пакет персональных)
-- выдаёт абонемент без дат с starts_on_first_visit — «ожидает посещения»;
-- срок ставит первое посещение (schedule_bookings_charge_balance).

create or replace function public.activate_membership_from_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  computed_ends date;
  v_balance text;
  v_packages boolean;
begin
  select duration_days, visits_count, auto_renew, kind
    into m
    from public.memberships
    where id = new.membership_id;

  v_packages := exists (
    select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
  );

  -- Продление ничего не вытесняет: ждёт, пока закончится текущий; срок — с
  -- первого посещения. balance_kind и personal_left поставит
  -- client_memberships_packages_fill.
  if new.sale_kind = 'renewal' and v_packages then
    insert into public.client_memberships (
      studio_id, client_id, membership_id, sale_id, source,
      started_at, ends_at, visits_left, status, auto_renew, starts_on_first_visit
    ) values (
      new.studio_id, new.client_id, new.membership_id, new.id,
      coalesce(new.source, 'admin'),
      null, null, m.visits_count, 'pending', false, true
    );
    perform public.packages_settle(new.client_id);
    return new;
  end if;

  -- Пакет персональных — свой вид баланса: вытесняет только такой же.
  v_balance := case
    when m.kind = 'personal' and v_packages then 'personal'
    else 'group'
  end;

  update public.client_memberships
     set status = 'replaced'
   where client_id = new.client_id
     and status in ('active','frozen')
     and balance_kind = v_balance;

  if v_packages then
    -- «Ожидает посещения»: срок пойдёт с первого посещения.
    insert into public.client_memberships (
      studio_id, client_id, membership_id, sale_id, source,
      started_at, ends_at, visits_left, status, auto_renew, starts_on_first_visit
    ) values (
      new.studio_id, new.client_id, new.membership_id, new.id,
      coalesce(new.source, 'admin'),
      null, null, m.visits_count, 'active', false, true
    );
    return new;
  end if;

  computed_ends := case
    when m.duration_days is not null
      then (new.sold_at + (m.duration_days || ' days')::interval)::date
    else null
  end;

  -- balance_kind и personal_left поставит client_memberships_packages_fill.
  insert into public.client_memberships (
    studio_id, client_id, membership_id, sale_id, source,
    started_at, ends_at, visits_left, status, auto_renew
  ) values (
    new.studio_id, new.client_id, new.membership_id, new.id,
    coalesce(new.source, 'admin'),
    new.sold_at, computed_ends, m.visits_count, 'active',
    coalesce(m.auto_renew, false)
  );

  return new;
end
$$;

-- 5. «Посетил» — только с абонементом -------------------------------------------
-- Тело — как в 2026-10-11_zzzzzzzz_review_fixes.sql, кроме: посещение
-- (attended) группового или персонального занятия пакетного клуба без
-- абонемента с остатком не сохраняется — сначала продажа. «Не посетил» по
-- неуважительной причине без абонемента по-прежнему фиксируется без списания.

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

  -- Списание сняли — тренировка возвращается на тот же абонемент.
  if v_was and not v_is then
    if old.charged_membership_id is not null then
      if old.charged_balance = 'personal' then
        update public.client_memberships set personal_left = personal_left + 1
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
            -- Продление — только если текущего того же вида нет: иначе
            -- ждущее списывалось и начинало срок, пока ходят по текущему.
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
  end if;

  -- Решение владельца 2026-10-13: посещение без абонемента не отмечают —
  -- сначала продажа, с которой оно спишется.
  if v_cm is null and new.status = 'attended' and v_kind in ('group', 'personal') then
    raise exception 'У клиента нет абонемента с остатком тренировок — сначала оформите продажу абонемента'
      using errcode = 'P0001', hint = 'no_membership';
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

-- 6. Клиент видит свои продажи и график платежей --------------------------------
-- Как в db/sales_client_rls.sql (выполнялся вручную) — здесь, чтобы было и на
-- базе, где его не выполняли.

drop policy if exists "sales client select own" on public.sales;
create policy "sales client select own" on public.sales
  for select to authenticated
  using (
    exists (
      select 1 from public.clients c
      where c.id = sales.client_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "sale_installments client select own" on public.sale_installments;
create policy "sale_installments client select own" on public.sale_installments
  for select to authenticated
  using (
    exists (
      select 1 from public.sales s
      join public.clients c on c.id = s.client_id
      where s.id = sale_installments.sale_id
        and c.user_id = auth.uid()
    )
  );

-- 7. Вью «Абонементов»: возврат ------------------------------------------------
-- Определение — как в 2026-10-13_packages_memberships_sales_merge.sql, кроме:
-- у платежа — refunded; снятые возвратом платежи не считаются невнесёнными
-- (next_due_date, unpaid_count); payment_state = 'refunded' у абонемента с
-- возвратом — он не попадает ни в один фильтр по платежам.

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
      'personal_count', m.personal_count
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
    when cm.status = 'refunded' then 'refunded'
    when pay.unpaid_count = 0 then 'paid'
    when pay.next_due_date < (now() at time zone 'Asia/Tbilisi')::date then 'overdue'
    when pay.next_due_date <= (now() at time zone 'Asia/Tbilisi')::date + 2 then 'soon'
    else 'pending'
  end as payment_state,
  cm.started_at as membership_started_at,
  coalesce(cm.starts_on_first_visit, false) as starts_on_first_visit,
  s.source,
  s.promo_code
from public.sales s
join public.studios st on st.id = s.studio_id and st.format = 'packages'
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id
left join lateral (
  select c.status, c.visits_left, c.personal_left, c.ends_at, c.started_at,
         c.starts_on_first_visit
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
    count(i.id) filter (where not i.paid and not i.refunded) as unpaid_count
  from public.sale_installments i
  where i.sale_id = s.id
) pay;

grant select on public.client_packages_list to authenticated;

notify pgrst, 'reload schema';
