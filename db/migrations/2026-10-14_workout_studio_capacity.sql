-- ============================================================================
-- Вместимость тренировки по клубам (решение владельца 2026-10-14).
--
-- Тренировки пакетных клубов — общий каталог (2026-10-13_zzzz_packages_
-- shared_catalog.sql), а залы разные: вместимость задаётся в «Тренировках»
-- для каждого клуба отдельно — workout_capacities (тренировка × клуб,
-- capacity null или 0 — без лимита). workouts.capacity остаётся вместимостью
-- по умолчанию: для клуба без своей строки (например, новый пакетный клуб) и
-- для старого кода.
--
-- Занятие в «Расписании» хранит свою вместимость (schedule_entries.capacity):
-- форма занятия подставляет вместимость тренировки в этом клубе, её можно
-- поменять на один день. Групповое занятие без вместимости (копия, «Дублировать
-- неделю», Kate, старые занятия) получает её триггером — так приложение,
-- запись (book_schedule_entry, admin_book_client) и сетка читают одно
-- schedule_entries.capacity, как раньше.
-- Идемпотентно. Выполняет мигратор.
-- ============================================================================

create table if not exists public.workout_capacities (
  workout_id uuid not null references public.workouts(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  capacity int check (capacity is null or capacity >= 0),
  updated_at timestamptz not null default now(),
  primary key (workout_id, studio_id)
);

create index if not exists workout_capacities_studio_idx
  on public.workout_capacities (studio_id);

comment on table public.workout_capacities is
  'Вместимость тренировки в клубе («Тренировки»): null или 0 — без лимита; нет строки — workouts.capacity.';

alter table public.workout_capacities enable row level security;

-- Число мест не тайна: читают все вошедшие (приложение может показать).
drop policy if exists "workout_capacities read" on public.workout_capacities;
create policy "workout_capacities read" on public.workout_capacities
  for select to authenticated
  using (true);

-- Пишет сотрудник клуба строки, если правит каталог тренировки.
drop policy if exists "workout_capacities staff write" on public.workout_capacities;
create policy "workout_capacities staff write" on public.workout_capacities
  for all to authenticated
  using (
    public.is_trainer(auth.uid(), studio_id)
    and exists (
      select 1 from public.workouts w
       where w.id = workout_capacities.workout_id
         and public.can_manage_catalog(auth.uid(), w.studio_id)
    )
  )
  with check (
    public.is_trainer(auth.uid(), studio_id)
    and exists (
      select 1 from public.workouts w
       where w.id = workout_capacities.workout_id
         and public.can_manage_catalog(auth.uid(), w.studio_id)
    )
  );

grant select, insert, update, delete on public.workout_capacities to authenticated;

-- Вместимость тренировки в клубе: своя строка, иначе по умолчанию.
create or replace function public.workout_capacity_in(_workout_id uuid, _studio_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case
    when wc.workout_id is not null then wc.capacity
    else w.capacity
  end
    from public.workouts w
    left join public.workout_capacities wc
      on wc.workout_id = w.id and wc.studio_id = _studio_id
   where w.id = _workout_id
$$;

revoke all on function public.workout_capacity_in(uuid, uuid) from public;
grant execute on function public.workout_capacity_in(uuid, uuid) to authenticated, service_role;

-- Перенос: прежняя общая вместимость — в каждый клуб каталога тренировки
-- (у пакетной — все пакетные клубы, у подписочной — её клуб).
insert into public.workout_capacities (workout_id, studio_id, capacity)
select w.id, s.id, w.capacity
  from public.workouts w
  join public.studios ws on ws.id = w.studio_id
  join public.studios s
    on s.id = w.studio_id
    or (ws.format = 'packages' and s.format = 'packages')
 where w.capacity is not null
on conflict (workout_id, studio_id) do nothing;

-- Новое групповое занятие без вместимости — вместимость тренировки в клубе.
create or replace function public.schedule_entries_fill_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.capacity is null and new.kind = 'group' and new.workout_id is not null then
    new.capacity := public.workout_capacity_in(new.workout_id, new.studio_id);
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_entries_fill_capacity_bi on public.schedule_entries;
create trigger schedule_entries_fill_capacity_bi
  before insert on public.schedule_entries
  for each row execute function public.schedule_entries_fill_capacity();

-- Занятия, ещё не начавшиеся, без своей вместимости: раньше брали её из
-- тренировки на лету — теперь записана та же цифра.
update public.schedule_entries se
   set capacity = public.workout_capacity_in(se.workout_id, se.studio_id)
 where se.capacity is null
   and se.kind = 'group'
   and se.workout_id is not null
   and se.starts_at > now();

notify pgrst, 'reload schema';
