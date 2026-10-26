-- Покупка в приложении закрыта для пакетных клубов (решение владельца
-- 2026-10-16, перед запуском приложения Lady Stretch).
--
-- Оплаты в приложении нет: политика "sales client insert own"
-- (db/sales_client_rls.sql) пускала вошедшего клиента вставить продажу
-- самому себе, и триггер activate_membership_from_sale выдавал абонемент
-- бесплатно. В пакетном приложении кнопки покупки нет, но запрос в обход
-- приложения (публичный ключ — в бандле) проходил. Теперь продажу в
-- пакетном клубе вносит только сотрудник (админка) или сервер
-- (auth.uid() пуст — service_role). Подписочные клубы (app.base40.fit) —
-- как раньше: там покупка-муляж остаётся до подключения эквайринга
-- (корневой CLAUDE.md, «Предрелизный риск (оплата)»).
--
-- Остальное — как в 2026-10-15_zz_packages_single_visit.sql (актуальное
-- определение sales_client_insert_guard теперь здесь).

create or replace function public.sales_client_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_trainer(auth.uid(), new.studio_id) then
    return new;
  end if;
  if exists (
    select 1 from public.studios s
     where s.id = new.studio_id and s.format = 'packages'
  ) then
    raise exception 'Покупка в приложении недоступна — абонемент оформляет администратор клуба';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.id = new.membership_id
       and public.catalog_shared(m.studio_id, new.studio_id)
       and m.is_active
       and m.kind is distinct from 'single'
  ) then
    raise exception 'Абонемент недоступен для покупки';
  end if;
  new.seller_id := null;
  new.trainer_id := null;
  new.trainer_name := null;
  new.sale_kind := null;
  new.membership_note := null;
  new.sold_at := (now() at time zone 'Asia/Tbilisi')::date;
  return new;
end;
$$;
