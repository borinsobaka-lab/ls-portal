-- «Разовое посещение» — четвёртый тип номенклатуры пакетных клубов
-- (решение владельца 2026-10-15).
--
-- memberships.kind = 'single': 1 групповая тренировка, срок 1 месяц
-- (30 дней), стоимость — в «Номенклатурах» админки, всегда 1 платёж.
-- Продаётся только администратором (выбор абонемента в продаже), в
-- приложении не показывается и не покупается.
--
-- 1. Тип в проверке memberships_kind_check и условия разового посещения
--    (memberships_single_terms_check; без персональных и диагностик —
--    diagnostics_count из 2026-10-15_zz_diagnostics_client_requests.sql,
--    файл идёт по имени раньше) — форма админки пишет их сама, база не даёт
--    сохранить другие.
-- 2. Покупка в приложении (sales_client_insert_guard): разовое посещение
--    клиент себе не оформляет. Остальное — как в
--    2026-10-13_zzzz_packages_shared_catalog.sql.
-- 3. Строка «Разовое посещение» в общем каталоге пакетных клубов (если её
--    ещё нет), стоимость 0 — владелец ставит цену в «Номенклатурах».
--
-- Баланс и списание — как у пакета тренировок и пробного: balance_kind
-- group, visits_left из visits_count, списание при «Посетил», без остатка —
-- «Закончился» (packages_settle). Менять функции не нужно: они различают
-- только personal.

-- 1. Тип ---------------------------------------------------------------------

alter table public.memberships drop constraint if exists memberships_kind_check;
alter table public.memberships add constraint memberships_kind_check
  check (kind in ('package', 'trial', 'personal', 'single'));

comment on column public.memberships.kind is
  'Пакетный формат: package — пакет тренировок, trial — пробное посещение, personal — пакет персональных тренировок, single — разовое посещение (1 групповая, 30 дней, 1 платёж; в приложении не продаётся). Подписочный формат не использует.';

alter table public.memberships drop constraint if exists memberships_single_terms_check;
alter table public.memberships add constraint memberships_single_terms_check
  check (
    kind <> 'single'
    or (
      visits_count = 1 and personal_count = 0 and diagnostics_count = 0
      and duration_days = 30 and max_payments = 1
    )
  );

-- 2. Покупка в приложении ----------------------------------------------------

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

-- 3. Номенклатура «Разовое посещение» -----------------------------------------
-- Каталог пакетных клубов общий: одна строка на все пакетные клубы, в самом
-- старом из них (как studios_packages_catalog_rehome). Нет пакетных клубов —
-- ничего не создаётся: номенклатуру заведут в «Номенклатурах».

insert into public.memberships (
  studio_id, name, kind, visits_count, personal_count, duration_days, price,
  max_payments, is_active, auto_renew, installment_enabled, for_couple,
  freeze_days_allowed, sort_order, translations
)
select s.id, 'Разовое посещение', 'single', 1, 0, 30, 0,
       1, true, false, false, false,
       0,
       coalesce((
         select max(m.sort_order) + 1
           from public.memberships m
           join public.studios ms on ms.id = m.studio_id and ms.format = 'packages'
       ), 0),
       '{"en": {"name": "Single visit"}, "ka": {"name": "ერთჯერადი ვიზიტი"}}'::jsonb
  from public.studios s
 where s.format = 'packages'
   and not exists (
     select 1
       from public.memberships m
       join public.studios ms on ms.id = m.studio_id and ms.format = 'packages'
      where m.kind = 'single'
   )
 order by s.created_at, s.id
 limit 1;
