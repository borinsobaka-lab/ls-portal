-- ============================================================================
-- «Редактировать платежи» у любого абонемента (решение владельца 2026-10-18):
-- и у полностью оплаченного, и у оплаченного сразу при продаже (без графика),
-- а у внесённых платежей — правка суммы (внесли не столько, сколько
-- отметили). Отметку «внесён» правка графика по-прежнему не снимает — это
-- делают нажатием на платёж («Снять отметку об оплате»).
--
-- replace_sale_installments(sale, rows) переопределена (прежняя —
-- 2026-10-14_zzz_sale_installments_edit.sql), rows — jsonb-массив
-- {id?, amount, due_date?, paid?}:
--   * с id — платёж этой продажи: у невнесённого меняются сумма и дата, у
--     внесённого — только сумма (дата, когда внесён, и способ оплаты — как
--     были);
--   * внесённые, которых нет в rows, не трогаются (как раньше); невнесённые,
--     которых нет в rows, — удаляются;
--   * без id — новый невнесённый платёж; без id и с paid = true — оплата при
--     продаже у продажи без графика (одна строка): записывается внесённым
--     платежом днём продажи и её способом оплаты — так её и считали
--     (зарплаты, дашборд, вью «Абонементов»: без графика — вся сумма в день
--     продажи).
-- Сумма каждого платежа больше нуля, всех (кроме снятых возвратом) — не
-- меньше sales.total_amount; по продаже с возвратом график не меняется.
-- Security invoker: права — как на прямую правку sale_installments (RLS —
-- сотрудник клуба продажи).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

create or replace function public.replace_sale_installments(p_sale_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_row jsonb;
  v_id uuid;
  v_amount numeric;
  v_due date;
  v_paid boolean;
  v_keep uuid[] := '{}';
  v_had_schedule boolean;
  v_sold_once int := 0;
  v_total numeric;
  v_count int;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Продажа не найдена' using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Нет списка платежей' using errcode = '22023';
  end if;
  if exists (select 1 from public.sale_installments where sale_id = p_sale_id and refunded)
     or exists (
       select 1 from public.client_memberships
        where sale_id = p_sale_id and status = 'refunded'
     ) then
    raise exception 'По продаже оформлен возврат — график платежей не меняется'
      using errcode = 'P0001';
  end if;
  v_had_schedule := exists (select 1 from public.sale_installments where sale_id = p_sale_id);

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_amount := (v_row->>'amount')::numeric;
    v_due := (v_row->>'due_date')::date;
    v_id := nullif(v_row->>'id', '')::uuid;
    v_paid := coalesce((v_row->>'paid')::boolean, false);
    if v_amount is null or v_amount <= 0 then
      raise exception 'Сумма каждого платежа должна быть больше нуля' using errcode = '22023';
    end if;

    if v_id is not null then
      -- Внесённому — только сумма; невнесённому нужна и дата.
      update public.sale_installments
         set amount = v_amount,
             due_date = case when paid then due_date else coalesce(v_due, due_date) end
       where id = v_id and sale_id = p_sale_id and not refunded
         and (paid or v_due is not null);
      if not found then
        if exists (select 1 from public.sale_installments where id = v_id and sale_id = p_sale_id) then
          raise exception 'У каждого платежа нужна дата' using errcode = '22023';
        end if;
        raise exception 'Платёж не относится к этой продаже' using errcode = 'P0001';
      end if;
      v_keep := v_keep || v_id;
    elsif v_paid then
      -- Оплата при продаже: у продажи без графика становится первым платежом.
      v_sold_once := v_sold_once + 1;
      if v_had_schedule or v_sold_once > 1 then
        raise exception 'Новый платёж нельзя сразу отметить внесённым' using errcode = 'P0001';
      end if;
    elsif v_due is null then
      raise exception 'У каждого платежа нужна дата' using errcode = '22023';
    end if;
  end loop;

  -- Убранные из графика невнесённые платежи.
  delete from public.sale_installments
   where sale_id = p_sale_id and not paid and not refunded
     and not (id = any (v_keep));

  -- Новые платежи (и оплата при продаже у продажи без графика).
  insert into public.sale_installments (sale_id, amount, due_date, paid, paid_at, payment_method)
  select p_sale_id,
         (r->>'amount')::numeric,
         case when coalesce((r->>'paid')::boolean, false) then v_sale.sold_at
              else (r->>'due_date')::date end,
         coalesce((r->>'paid')::boolean, false),
         case when coalesce((r->>'paid')::boolean, false) then v_sale.sold_at end,
         case when coalesce((r->>'paid')::boolean, false) then v_sale.payment_method end
    from jsonb_array_elements(p_rows) r
   where nullif(r->>'id', '') is null;

  select coalesce(sum(amount), 0), count(*) into v_total, v_count
    from public.sale_installments
   where sale_id = p_sale_id and not refunded;
  if v_total < coalesce(v_sale.total_amount, 0) then
    raise exception 'Сумма платежей (%) меньше стоимости абонемента (%)',
      v_total, v_sale.total_amount
      using errcode = 'P0001';
  end if;

  update public.sales
     set remaining_installments = greatest(v_count - 1, 0)
   where id = p_sale_id;
end;
$$;

revoke all on function public.replace_sale_installments(uuid, jsonb) from public, anon;
grant execute on function public.replace_sale_installments(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
