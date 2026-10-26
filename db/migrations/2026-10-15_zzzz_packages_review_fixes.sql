-- ============================================================================
-- Пакетные клубы: исправления по код-ревью 2026-10-15.
--
-- 1. «Разовое посещение» (2026-10-15_zz_packages_single_visit.sql) не
--    вытесняет и не вытесняется. activate_membership_from_sale считала его
--    продажу обычным групповым пакетом: «Новая» или «Допродажа» разового при
--    живом пакете переводила пакет в «Заменён» (с ним пропадали оставшиеся
--    тренировки и диагностики), а продажа пакета — неиспользованное
--    оплаченное разовое. Теперь, если одна из двух сторон — разовое
--    посещение, новая продажа встаёт в очередь, как продление (pending, срок
--    с первого посещения): сначала доходят по текущему, потом — по новому
--    (packages_settle). Остальное — как в 2026-10-13_zz_packages_test_fixes.sql
--    (актуальное определение activate_membership_from_sale — здесь).
-- 2. my_studio_visit_stats (сравнение со студией в статистике приложения):
--    диагностика тела — не посещение тренировки (актуальное определение —
--    здесь; было — 2026-10-12_zz_packages_app_fixes.sql).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Разовое посещение в очереди ---------------------------------------------------

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
  v_queue boolean;
begin
  select duration_days, visits_count, auto_renew, kind
    into m
    from public.memberships
    where id = new.membership_id;

  v_packages := exists (
    select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages'
  );

  -- Пакет персональных — свой вид баланса: вытесняет только такой же.
  v_balance := case
    when m.kind = 'personal' and v_packages then 'personal'
    else 'group'
  end;

  -- Продление ничего не вытесняет: ждёт, пока закончится текущий. Так же —
  -- разовое посещение при живом групповом и пакет при живом разовом.
  v_queue := v_packages and (
    new.sale_kind = 'renewal'
    or (v_balance = 'group' and exists (
      select 1 from public.client_memberships cm
        join public.memberships lm on lm.id = cm.membership_id
       where cm.client_id = new.client_id
         and cm.status in ('active', 'frozen')
         and cm.balance_kind = 'group'
         and (m.kind = 'single' or lm.kind = 'single')
    ))
  );

  -- Срок — с первого посещения. balance_kind и personal_left поставит
  -- client_memberships_packages_fill.
  if v_queue then
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

-- 2. Сравнение со студией без диагностик ----------------------------------------

-- Студия — из карточки вызывающего; человек в журнале — карточка (client_id),
-- без неё — учётная запись. Месяц — по Тбилиси.
create or replace function public.my_studio_visit_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_client      uuid;
  v_studio      uuid;
  v_month_start timestamptz :=
    date_trunc('month', now() at time zone 'Asia/Tbilisi') at time zone 'Asia/Tbilisi';
  v_my_total    int;
  v_my_month    int;
  v_total_n     int;
  v_total_above int;
  v_month_n     int;
  v_month_below int;
  v_month_sum   int;
begin
  if v_uid is null then
    return null;
  end if;
  select c.id, c.studio_id into v_client, v_studio
    from public.clients c
   where c.user_id = v_uid
   order by c.created_at
   limit 1;
  if v_studio is null then
    return null;
  end if;

  with visits as (
    select coalesce(l.client_id::text, 'u:' || l.user_id::text) as person,
           (coalesce(l.client_id = v_client, false) or coalesce(l.user_id = v_uid, false)) as mine,
           l.starts_at
      from public.bookings_log l
     where l.studio_id = v_studio
       and l.status = 'attended'
       and l.starts_at <= now()
       and (l.client_id is not null or l.user_id is not null)
       -- Диагностика тела — не тренировка.
       and not exists (
         select 1 from public.schedule_entries e
          where e.id = l.entry_id and e.kind = 'diagnostic'
       )
  ),
  me as (
    select count(*)::int as total,
           count(*) filter (where starts_at >= v_month_start)::int as month
      from visits where mine
  ),
  others as (
    select person,
           count(*)::int as total,
           count(*) filter (where starts_at >= v_month_start)::int as month
      from visits where not mine
     group by person
  )
  select me.total, me.month,
         (select count(*) from others)::int,
         (select count(*) from others o where o.total > me.total)::int,
         (select count(*) from others o where o.month > 0)::int,
         (select count(*) from others o where o.month > 0 and o.month < me.month)::int,
         (select coalesce(sum(o.month), 0) from others o)::int
    into v_my_total, v_my_month, v_total_n, v_total_above, v_month_n, v_month_below, v_month_sum
    from me;

  return jsonb_build_object(
    -- Топ N %: место клиента среди всех, кто хоть раз был в студии.
    'total_top_pct', case when v_my_total > 0 and v_total_n + 1 >= 5
      then greatest(1, ceil(100.0 * (v_total_above + 1) / (v_total_n + 1)))::int end,
    'total_cohort', v_total_n + 1,
    -- Среднее за месяц — среди тех, кто в этом месяце уже занимался.
    'month_avg', case when v_month_n + (case when v_my_month > 0 then 1 else 0 end) >= 5
      then round((v_month_sum + v_my_month)::numeric
                 / (v_month_n + (case when v_my_month > 0 then 1 else 0 end)), 1) end,
    'month_better_pct', case when v_my_month > 0 and v_month_n >= 4
      then round(100.0 * v_month_below / v_month_n)::int end,
    'month_cohort', v_month_n + (case when v_my_month > 0 then 1 else 0 end)
  );
end;
$$;

revoke all on function public.my_studio_visit_stats() from public, anon;
grant execute on function public.my_studio_visit_stats() to authenticated;

notify pgrst, 'reload schema';
