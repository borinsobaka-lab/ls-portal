-- ============================================================================
-- Типы занятий в расписании (решение владельца 2026-10-11, оба формата студий).
--
-- Кроме групповых занятий в расписание ставятся:
--   personal — персональное занятие: без тренировки, ведёт один тренер
--              (его ставка за персональную — trainer_pay_rates);
--   other    — прочая активность: своё название, тренеры по желанию и
--              ставка, введённая вручную (pay_rate, лари каждому отмеченному).
-- Тренеры занятия по-прежнему в schedule_entry_trainers. Зарплаты из этого
-- посчитаем следующим шагом.
--
-- Совместимо: kind по умолчанию 'group' — существующие занятия групповые,
-- у них workout_id обязателен, как раньше.
--
-- Клиентам (приложения) — только групповые: персональные и прочие видят и
-- правят сотрудники студии; записаться на них нельзя (триггер ниже).
-- Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

alter table public.schedule_entries
  add column if not exists kind text not null default 'group';
alter table public.schedule_entries
  add column if not exists title text;
alter table public.schedule_entries
  add column if not exists pay_rate numeric(10,2);

alter table public.schedule_entries
  alter column workout_id drop not null;

alter table public.schedule_entries
  drop constraint if exists schedule_entries_kind_check;
alter table public.schedule_entries
  add constraint schedule_entries_kind_check
  check (kind in ('group', 'personal', 'other'));

-- Групповое — с тренировкой; персональное и прочее — без неё, у прочего
-- обязательно название.
alter table public.schedule_entries
  drop constraint if exists schedule_entries_kind_fields;
alter table public.schedule_entries
  add constraint schedule_entries_kind_fields
  check (
    (kind = 'group' and workout_id is not null)
    or (kind = 'personal' and workout_id is null)
    or (kind = 'other' and workout_id is null and nullif(btrim(title), '') is not null)
  );

alter table public.schedule_entries
  drop constraint if exists schedule_entries_pay_rate_check;
alter table public.schedule_entries
  add constraint schedule_entries_pay_rate_check
  check (pay_rate is null or pay_rate >= 0);

comment on column public.schedule_entries.kind is
  'Тип занятия: group — групповое (тренировка), personal — персональное, other — прочая активность.';
comment on column public.schedule_entries.title is
  'Название прочей активности (kind = other).';
comment on column public.schedule_entries.pay_rate is
  'Ставка за прочую активность, лари каждому отмеченному тренеру (kind = other).';

-- Чтение: клиент студии — только групповые занятия; сотрудник студии видит
-- все (и через "schedule trainer write", for all).
drop policy if exists "schedule studio select" on public.schedule_entries;
create policy "schedule studio select" on public.schedule_entries
  for select to authenticated
  using (
    studio_id = public.current_studio_id(auth.uid())
    and (kind = 'group' or public.is_trainer(auth.uid(), studio_id))
  );

-- Тренеры занятия — с той же видимостью, что и само занятие.
drop policy if exists "set studio select" on public.schedule_entry_trainers;
create policy "set studio select" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
    where e.id = entry_id
      and e.studio_id = public.current_studio_id(auth.uid())
      and (e.kind = 'group' or public.is_trainer(auth.uid(), e.studio_id))
  ));

-- Записаться можно только на групповое: RPC записи — security definer и
-- видимость занятий не проверяют. Функция тоже security definer — иначе при
-- прямой вставке RLS спрятал бы от клиента само занятие и проверка прошла бы.
create or replace function public.schedule_bookings_group_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.schedule_entries
    where id = new.entry_id and kind <> 'group'
  ) then
    raise exception 'На это занятие нельзя записаться: оно не групповое';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_group_only_bi on public.schedule_bookings;
create trigger schedule_bookings_group_only_bi
  before insert on public.schedule_bookings
  for each row execute function public.schedule_bookings_group_only();

notify pgrst, 'reload schema';
