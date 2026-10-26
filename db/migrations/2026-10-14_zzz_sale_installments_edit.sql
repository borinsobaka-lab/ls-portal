-- ============================================================================
-- «Редактировать платежи» в «Абонементах» (решение владельца 2026-10-14):
-- клиент не может внести очередной платёж целиком — администратор записывает
-- внесённую часть, а остаток раскладывает на новые платежи (даты могут
-- сдвинуться). График можно менять как угодно, но в сумме он должен
-- покрывать стоимость продажи.
--
-- RPC replace_sale_installments(sale, rows): rows — НЕвнесённые платежи в
-- нужном виде, jsonb-массив {id?, amount, due_date}. Внесённые и снятые
-- возвратом платежи не трогаются. Невнесённые, которых нет в rows, —
-- удаляются, с id — меняются, без id — добавляются. После записи сумма
-- всех платежей (кроме снятых возвратом) должна быть не меньше
-- sales.total_amount — иначе исключение и откат.
-- Функция — security invoker: права те же, что на прямую правку
-- sale_installments (RLS «sale_installments via sale» — сотрудник клуба
-- продажи). По продаже с возвратом график не меняется.
--
-- sales.remaining_installments (сколько платежей после первого) обновляется
-- по новому графику; ограничение 0–11 снято до «не меньше 0» — платежей
-- после правки может стать больше двенадцати.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.sales drop constraint if exists sales_remaining_installments_check;
alter table public.sales add constraint sales_remaining_installments_check
  check (remaining_installments >= 0);

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
  v_keep uuid[] := '{}';
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

  -- Невнесённые платежи, оставленные в графике (с id), — проверяем и правим.
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_amount := (v_row->>'amount')::numeric;
    v_due := (v_row->>'due_date')::date;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Сумма каждого платежа должна быть больше нуля' using errcode = '22023';
    end if;
    if v_due is null then
      raise exception 'У каждого платежа нужна дата' using errcode = '22023';
    end if;
    v_id := nullif(v_row->>'id', '')::uuid;
    if v_id is not null then
      update public.sale_installments
         set amount = v_amount, due_date = v_due
       where id = v_id and sale_id = p_sale_id and not paid and not refunded;
      if not found then
        raise exception 'Платёж уже внесён или не относится к этой продаже'
          using errcode = 'P0001';
      end if;
      v_keep := v_keep || v_id;
    end if;
  end loop;

  -- Убранные из графика невнесённые платежи.
  delete from public.sale_installments
   where sale_id = p_sale_id and not paid and not refunded
     and not (id = any (v_keep));

  -- Новые платежи.
  insert into public.sale_installments (sale_id, amount, due_date, paid)
  select p_sale_id, (r->>'amount')::numeric, (r->>'due_date')::date, false
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
