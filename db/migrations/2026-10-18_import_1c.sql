-- ============================================================================
-- Перенос клиентов и абонементов из 1С в пакетные клубы (решение владельца
-- 2026-10-18, запуск Lady Stretch). Данные клиентов в репозиторий не
-- попадают: файл заливки готовят из
-- выгрузки 1С (скрипт в эту копию не входит), владелец загружает его в админке («Доступы» → «Импорт из
-- 1С»), страница отдаёт его этой функции пачками.
--
--   * clients.onec_ref / sales.onec_ref / client_memberships.onec_ref — ключ
--     записи из 1С (клиент — коды карточек 1С, продажа и абонемент — номер
--     документа продажи, номенклатура и код клиента). По ним повторная
--     заливка того же файла ничего не задваивает, а «Удалить залитое»
--     находит только перенесённое.
--   * «Остаток из 1С» — скрытая номенклатура общего каталога пакетных клубов
--     (пакет тренировок, цена 0, в приложении не продаётся): на неё
--     переносятся остатки «Абонемента для перехода» и сертификатов, а в
--     истории — пакеты, которых нет в нашей номенклатуре.
--   * import_1c_chunk(jsonb) — пачка клиентов с абонементами. Только владелец
--     клубов пачки. Клиент: найден по onec_ref — пропускается; карточка с той
--     же почтой уже есть в базе клубов — абонементы добавляются к ней; иначе
--     новая карточка. Действующие абонементы (kind = sale) — продажа: сумма
--     из 1С (нет — цена номенклатуры), «цена по прайсу» — из номенклатуры,
--     разница — скидка; долг — рассрочка (первый платёж внесён в день
--     продажи, остаток — вторым платежом через месяц). Вся номенклатура
--     файла проверяется с первой пачки. Абонемент клиента выдаёт обычный триггер
--     продажи, затем ему ставится состояние из 1С (остаток, срок, очередь) и
--     packages_settle наводит порядок. История (kind = history) —
--     «Закончился», без продажи и без остатка.
--   * import_1c_rollback(text) — удалить всё перенесённое; только пока никто
--     из перенесённых клиентов не входил в приложение и не записан на
--     занятие.
-- ============================================================================

alter table public.clients add column if not exists onec_ref text;
alter table public.sales add column if not exists onec_ref text;
alter table public.client_memberships add column if not exists onec_ref text;

create unique index if not exists clients_onec_ref_key
  on public.clients (onec_ref) where onec_ref is not null;
create unique index if not exists sales_onec_ref_key
  on public.sales (onec_ref) where onec_ref is not null;
create unique index if not exists client_memberships_onec_ref_key
  on public.client_memberships (onec_ref) where onec_ref is not null;

-- Скрытая номенклатура «Остаток из 1С» — одна на общий каталог пакетных
-- клубов, в самом старом пакетном клубе.
insert into public.memberships (
  studio_id, name, description, kind, visits_count, personal_count,
  duration_days, price, max_payments, is_active, sort_order, translations
)
select s.id,
       'Остаток из 1С',
       'Остаток тренировок, перенесённый из 1С («Абонемент для перехода», сертификаты). Не продаётся.',
       'package', 1, 0, 30, 0, 1, false,
       coalesce((
         select max(m.sort_order) + 1
           from public.memberships m
           join public.studios ps on ps.id = m.studio_id and ps.format = 'packages'
       ), 0),
       '{"en": {"name": "Carried-over classes"}, "ka": {"name": "გადმოტანილი ვარჯიშები"}}'::jsonb
  from public.studios s
 where s.format = 'packages'
   and not exists (
     select 1 from public.memberships m
       join public.studios ps on ps.id = m.studio_id and ps.format = 'packages'
      where m.name = 'Остаток из 1С'
   )
 order by s.created_at
 limit 1;

create or replace function public.import_1c_chunk(p_chunk jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_studios jsonb := '{}'::jsonb;
  v_key text;
  v_name text;
  v_sid uuid;
  v_c jsonb;
  v_m jsonb;
  v_x jsonb;
  v_client uuid;
  v_client_studio uuid;
  v_email text;
  v_mid uuid;
  v_mkind text;
  v_price numeric;
  v_sale uuid;
  v_cm uuid;
  v_sold date;
  v_total numeric;
  v_paid numeric;
  v_ts timestamptz;
  v_live jsonb;
  r_clients_created int := 0;
  r_clients_existing int := 0;
  r_clients_reused int := 0;
  r_sales int := 0;
  r_sales_skipped int := 0;
  r_history int := 0;
  r_history_skipped int := 0;
begin
  -- Клубы пачки: ключ файла → пакетный клуб с этим названием. Заливает
  -- только владелец каждого из них (service_role и миграции — без сессии).
  for v_key, v_name in select key, value #>> '{}' from jsonb_each(coalesce(p_chunk->'studios', '{}'::jsonb)) loop
    select s.id into v_sid
      from public.studios s
     where s.name = v_name and s.format = 'packages';
    if not found then
      raise exception 'Пакетный клуб «%» не найден — проверьте название в «Клубах»', v_name;
    end if;
    if v_uid is not null and not public.has_role(v_uid, v_sid, 'owner') then
      raise exception 'Переносить клиентов из 1С может только владелец клуба «%»', v_name
        using errcode = '42501';
    end if;
    v_studios := v_studios || jsonb_build_object(v_key, v_sid);
  end loop;

  -- Вся номенклатура файла (страница шлёт её с каждой пачкой) — есть ли в
  -- каталоге: иначе перенос встал бы посреди файла.
  for v_name in select value #>> '{}' from jsonb_array_elements(coalesce(p_chunk->'catalog', '[]'::jsonb)) loop
    if not exists (
      select 1 from public.memberships m
        join public.studios s on s.id = m.studio_id and s.format = 'packages'
       where m.name = v_name
    ) then
      raise exception 'В номенклатуре пакетных клубов нет абонемента «%»', v_name;
    end if;
  end loop;

  for v_c in select value from jsonb_array_elements(coalesce(p_chunk->'clients', '[]'::jsonb)) loop
    v_client := null;
    v_client_studio := null;
    v_email := nullif(lower(btrim(coalesce(v_c->>'email', ''))), '');

    select c.id, c.studio_id into v_client, v_client_studio
      from public.clients c
     where c.onec_ref = v_c->>'ref';
    if v_client is not null then
      r_clients_existing := r_clients_existing + 1;
    else
      if v_email is not null then
        select c.id, c.studio_id into v_client, v_client_studio
          from public.clients c
          join public.studios s on s.id = c.studio_id and s.format = 'packages'
         where lower(btrim(c.email)) = v_email
         limit 1;
      end if;
      if v_client is not null then
        r_clients_reused := r_clients_reused + 1;
      else
        v_client_studio := (v_studios->>(v_c->>'studio'))::uuid;
        if v_client_studio is null then
          raise exception 'Клиент %: клуб «%» не указан в файле', v_c->>'ref', v_c->>'studio';
        end if;
        insert into public.clients (
          studio_id, first_name, last_name, phone, phone2, email, birthday,
          gender, notes, registration_date, onec_ref
        ) values (
          v_client_studio,
          nullif(btrim(v_c->>'first_name'), ''),
          nullif(btrim(v_c->>'last_name'), ''),
          nullif(v_c->>'phone', ''),
          nullif(v_c->>'phone2', ''),
          v_email,
          (v_c->>'birthday')::date,
          nullif(v_c->>'gender', ''),
          nullif(v_c->>'notes', ''),
          (v_c->>'registration_date')::date,
          v_c->>'ref'
        )
        returning id into v_client;
        r_clients_created := r_clients_created + 1;
      end if;
    end if;

    v_live := '[]'::jsonb;
    for v_m in select value from jsonb_array_elements(coalesce(v_c->'memberships', '[]'::jsonb)) loop
      select m.id, m.kind, m.price into v_mid, v_mkind, v_price
        from public.memberships m
        join public.studios s on s.id = m.studio_id and s.format = 'packages'
       where m.name = v_m->>'catalog'
       order by m.is_active desc, m.sort_order, m.created_at
       limit 1;
      if v_mid is null then
        raise exception 'В номенклатуре пакетных клубов нет абонемента «%»', v_m->>'catalog';
      end if;
      v_sold := (v_m->>'sold_at')::date;
      -- Порядок в базе — по дате продажи (по created_at очередь продлений
      -- выбирает следующий абонемент).
      v_ts := ((v_sold + time '12:00') at time zone 'Asia/Tbilisi')
              + make_interval(secs => coalesce((v_m->>'order')::int, 0));

      if v_m->>'kind' = 'history' then
        if exists (select 1 from public.client_memberships where onec_ref = v_m->>'ref') then
          r_history_skipped := r_history_skipped + 1;
        else
          insert into public.client_memberships (
            studio_id, client_id, membership_id, source, started_at, ends_at,
            visits_left, status, starts_on_first_visit, onec_ref, created_at
          ) values (
            v_client_studio, v_client, v_mid, 'admin',
            (v_m->>'started_at')::date, (v_m->>'ends_at')::date,
            0, 'expired', false, v_m->>'ref', v_ts
          )
          returning id into v_cm;
          -- client_memberships_packages_fill поставил остатки номенклатуры:
          -- у истории их нет (иначе packages_settle вернул бы её в действующие).
          update public.client_memberships
             set visits_left = 0, personal_left = 0, diagnostics_left = 0
           where id = v_cm;
          r_history := r_history + 1;
        end if;
      else
        if exists (select 1 from public.sales where onec_ref = v_m->>'ref') then
          r_sales_skipped := r_sales_skipped + 1;
        else
          -- Сумма — из 1С (нет — цена номенклатуры), «цена по прайсу» — из
          -- номенклатуры, долг — из 1С.
          v_total := coalesce((v_m->>'total')::numeric, v_price);
          v_paid := greatest(0, v_total - coalesce((v_m->>'debt')::numeric, 0));
          insert into public.sales (
            studio_id, client_id, membership_id, admin_name, sold_at,
            total_amount, down_payment_amount, remaining_installments, source,
            list_price, discount_amount, comment, onec_ref, created_at
          ) values (
            v_client_studio, v_client, v_mid, 'Перенос из 1С', v_sold,
            v_total, v_paid, case when v_paid < v_total then 1 else 0 end, 'admin',
            v_price,
            greatest(v_price - v_total, 0),
            nullif(v_m->>'comment', ''), v_m->>'ref', v_ts
          )
          returning id into v_sale;
          -- Долг — как рассрочка из «Новой продажи»: внесённое — первым
          -- платежом в день продажи, остаток — следующим.
          if v_paid < v_total then
            if v_paid > 0 then
              insert into public.sale_installments (sale_id, due_date, amount, paid, paid_at)
              values (v_sale, v_sold, v_paid, true, v_sold);
            end if;
            insert into public.sale_installments (sale_id, due_date, amount, paid)
            values (
              v_sale,
              coalesce((v_m->>'debt_due')::date, (v_sold + interval '1 month')::date),
              v_total - v_paid,
              false
            );
          end if;
          v_live := v_live || jsonb_build_array(jsonb_build_object('sale', v_sale, 'm', v_m, 'ts', v_ts));
          r_sales := r_sales + 1;
        end if;
      end if;
    end loop;

    -- Абонементы перенесённых продаж выдал триггер (и, может быть, заменил
    -- один другим) — ставим им состояние из 1С. Сначала все ждут, потом
    -- закончившиеся и очередь, текущий — последним: живой абонемент одного
    -- вида у клиента один (client_memberships_one_live_per_balance).
    if jsonb_array_length(v_live) > 0 then
      update public.client_memberships
         set status = 'pending'
       where sale_id in (select (x->>'sale')::uuid from jsonb_array_elements(v_live) x);
      for v_x in
        select x from jsonb_array_elements(v_live) x
         order by (x->'m'->>'status') = 'active'
      loop
        v_m := v_x->'m';
        update public.client_memberships
           set status = v_m->>'status',
               starts_on_first_visit = coalesce((v_m->>'starts_on_first_visit')::boolean, false),
               started_at = (v_m->>'started_at')::date,
               ends_at = (v_m->>'ends_at')::date,
               visits_left = (v_m->>'visits_left')::int,
               personal_left = coalesce((v_m->>'personal_left')::int, 0),
               diagnostics_left = case when v_m->>'status' = 'expired' then 0 else diagnostics_left end,
               onec_ref = v_m->>'ref',
               created_at = (v_x->>'ts')::timestamptz
         where sale_id = (v_x->>'sale')::uuid;
      end loop;
      perform public.packages_settle(v_client);
    end if;
  end loop;

  return jsonb_build_object(
    'clients_created', r_clients_created,
    'clients_existing', r_clients_existing,
    'clients_reused', r_clients_reused,
    'sales_created', r_sales,
    'sales_skipped', r_sales_skipped,
    'history_created', r_history,
    'history_skipped', r_history_skipped
  );
end;
$$;

revoke all on function public.import_1c_chunk(jsonb) from public, anon;
grant execute on function public.import_1c_chunk(jsonb) to authenticated, service_role;

create or replace function public.import_1c_rollback(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sales int;
  v_history int;
  v_clients int;
begin
  if p_confirm is distinct from 'УДАЛИТЬ' then
    raise exception 'Для удаления перенесённого введите УДАЛИТЬ';
  end if;
  if v_uid is not null and exists (
    select 1 from public.studios s
     where s.format = 'packages'
       and not public.has_role(v_uid, s.id, 'owner')
  ) then
    raise exception 'Удалить перенесённое из 1С может только владелец всех пакетных клубов'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.clients where onec_ref is not null and user_id is not null) then
    raise exception 'Перенесённые клиенты уже входили в приложение — удалить перенос целиком нельзя';
  end if;
  if exists (
    select 1 from public.schedule_bookings b
      join public.clients c on c.id = b.client_id
     where c.onec_ref is not null
  ) then
    raise exception 'Перенесённых клиентов уже записывали на занятия — удалить перенос целиком нельзя';
  end if;
  if exists (
    select 1 from public.sales s
      join public.clients c on c.id = s.client_id
     where c.onec_ref is not null and s.onec_ref is null
  ) then
    raise exception 'Перенесённым клиентам уже продавали абонементы — удалить перенос целиком нельзя';
  end if;

  -- Продажа удаляет и выданный по ней абонемент (sales_delete_client_memberships).
  delete from public.sales where onec_ref is not null;
  get diagnostics v_sales = row_count;
  delete from public.client_memberships where onec_ref is not null;
  get diagnostics v_history = row_count;
  delete from public.clients where onec_ref is not null;
  get diagnostics v_clients = row_count;

  return jsonb_build_object('sales', v_sales, 'history', v_history, 'clients', v_clients);
end;
$$;

revoke all on function public.import_1c_rollback(text) from public, anon;
grant execute on function public.import_1c_rollback(text) to authenticated, service_role;

-- PostgREST сразу видит новые функции (на случай, если событийный триггер
-- перезагрузки схемы не сработает).
notify pgrst, 'reload schema';
