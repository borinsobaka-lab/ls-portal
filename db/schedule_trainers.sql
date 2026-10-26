-- Join table: schedule entry ↔ trainers (many-to-many).

create table if not exists public.schedule_entry_trainers (
  entry_id uuid not null references public.schedule_entries(id) on delete cascade,
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  primary key (entry_id, trainer_id)
);
create index if not exists schedule_entry_trainers_entry_idx on public.schedule_entry_trainers(entry_id);
create index if not exists schedule_entry_trainers_trainer_idx on public.schedule_entry_trainers(trainer_id);

grant select, insert, update, delete on public.schedule_entry_trainers to authenticated;
grant all on public.schedule_entry_trainers to service_role;

alter table public.schedule_entry_trainers enable row level security;

drop policy if exists "set studio select" on public.schedule_entry_trainers;
create policy "set studio select" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
    where e.id = entry_id
      and e.studio_id = public.current_studio_id(auth.uid())
  ));

drop policy if exists "set trainer write" on public.schedule_entry_trainers;
create policy "set trainer write" on public.schedule_entry_trainers
  for all to authenticated
  using (exists (
    select 1 from public.schedule_entries e
    where e.id = entry_id
      and public.is_trainer(auth.uid(), e.studio_id)
  ))
  with check (exists (
    select 1 from public.schedule_entries e
    where e.id = entry_id
      and public.is_trainer(auth.uid(), e.studio_id)
  ));
