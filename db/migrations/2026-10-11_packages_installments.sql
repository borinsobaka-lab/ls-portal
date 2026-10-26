-- ============================================================================
-- Пакетные студии: внутренняя рассрочка (решение владельца 2026-10-11).
--
-- У номенклатуры — «сколькими платежами можно оплатить» (1, 2, 3, …). При
-- продаже администратор выбирает число платежей (по умолчанию 1, не больше
-- указанного у номенклатуры): первый платёж клиент вносит на месте, остаток
-- делится на следующие ежемесячные платежи. Продажа пишется в прежние колонки:
-- sales.down_payment_amount — первый платёж, sales.remaining_installments —
-- сколько платежей после него, график — sale_installments.
--
-- Совместимо с подписочным форматом: новая колонка с умолчанием 1 (у
-- подписочных номенклатур не используется — у них installment_enabled и
-- рассрочка 1 + 2 / 1 + 3), ограничение remaining_installments расширено с
-- (0, 2, 3) до 0…11 — прежние значения остаются допустимыми.
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

alter table public.memberships
  add column if not exists max_payments smallint not null default 1;

alter table public.memberships drop constraint if exists memberships_max_payments_check;
alter table public.memberships add constraint memberships_max_payments_check
  check (max_payments between 1 and 12);

comment on column public.memberships.max_payments is
  'Пакетный формат: сколькими ежемесячными платежами можно оплатить (1 — только сразу). Подписочный формат не использует.';

alter table public.sales drop constraint if exists sales_remaining_installments_check;
alter table public.sales add constraint sales_remaining_installments_check
  check (remaining_installments between 0 and 11);

notify pgrst, 'reload schema';
