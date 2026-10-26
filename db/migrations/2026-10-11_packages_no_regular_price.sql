-- ============================================================================
-- Пакетные студии: без отдельной «цены для постоянных клиентов» (решение
-- владельца 2026-10-11).
--
-- 2026-10-10_packages_memberships.sql добавил memberships.for_regular_clients —
-- тот же пакет второй строкой по сниженной цене. Владелец передумал: в
-- номенклатуре только полная цена, скидку дают при продаже. Колонку убираем.
-- Строки, заведённые как «цена для постоянных», не удаляем (на них могут
-- ссылаться продажи), а скрываем из приложения — иначе там оказались бы два
-- одноимённых пакета с разной ценой. Удалить их можно в «Номенклатурах».
--
-- Триггер «без автопродления в пакетных студиях» из прежней миграции остаётся.
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'memberships'
       and column_name = 'for_regular_clients'
  ) then
    update public.memberships set is_active = false where for_regular_clients;
  end if;
end;
$$;

alter table public.memberships drop column if exists for_regular_clients;

notify pgrst, 'reload schema';
