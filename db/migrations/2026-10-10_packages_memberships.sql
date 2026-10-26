-- ============================================================================
-- Номенклатура «Зала с пакетами тренировок» (STUDIO_FORMATS.md, решение
-- владельца 2026-10-10).
--
-- В пакетных студиях номенклатура — пакеты тренировок: название, описание,
-- количество тренировок, стоимость, срок действия. Автопродления нет.
-- Один и тот же пакет продаётся по двум ценам: новым клиентам — полная,
-- постоянным (повторная покупка) — сниженная. Сниженная цена — отдельная
-- строка memberships с тем же названием, своим описанием и признаком
-- for_regular_clients.
--
-- Таблица общая с подписочным форматом, поэтому только совместимые правки:
-- новая колонка с умолчанием (у подписочных номенклатур — false, смысл
-- прежний), автопродление в пакетных студиях выключает триггер.
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

alter table public.memberships
  add column if not exists for_regular_clients boolean not null default false;

comment on column public.memberships.for_regular_clients is
  'Пакетный формат: цена для постоянных клиентов (повторная покупка). false — для новых клиентов / подписочный формат.';

-- Автопродления у пакетов нет: в пакетной студии auto_renew всегда false,
-- кто бы ни сохранял строку. Он же копируется в client_memberships при
-- продаже (activate_membership_from_sale), так что и купленные пакеты — без
-- автопродления.
create or replace function public.memberships_packages_no_autorenew()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.studios s where s.id = new.studio_id and s.format = 'packages') then
    new.auto_renew := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_memberships_packages_no_autorenew on public.memberships;
create trigger trg_memberships_packages_no_autorenew
  before insert or update on public.memberships
  for each row execute function public.memberships_packages_no_autorenew();

-- Разово: пакетные номенклатуры, заведённые до этой миграции.
update public.memberships m
   set auto_renew = false
  from public.studios s
 where s.id = m.studio_id
   and s.format = 'packages'
   and m.auto_renew;

notify pgrst, 'reload schema';
