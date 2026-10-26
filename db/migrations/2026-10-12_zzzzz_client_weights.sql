-- История веса клиента (решение владельца 2026-10-12). Первая запись — вес из
-- анкеты приложения (source = 'onboarding', дата — когда анкету отправили);
-- потом в приложении появится раздел, где клиент взвешивается снова
-- (source = 'manual') и смотрит динамику.
--
-- Вес — про человека, не про карточку студии: привязка к учётной записи
-- (user_id), как у анкеты member_profiles. Учётную запись удаляют — история
-- уходит вместе с ней (on delete cascade).

create table if not exists public.client_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  weight_kg numeric(5, 1) not null,
  measured_at timestamptz not null default now(),
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

alter table public.client_weights drop constraint if exists client_weights_weight_range;
alter table public.client_weights add constraint client_weights_weight_range
  check (weight_kg between 20 and 300);

alter table public.client_weights drop constraint if exists client_weights_source_check;
alter table public.client_weights add constraint client_weights_source_check
  check (source in ('onboarding', 'manual'));

create index if not exists client_weights_user_measured_idx
  on public.client_weights (user_id, measured_at desc);

-- Вес из анкеты — один на учётную запись (повторное нажатие «Начать» не
-- задвоит запись).
create unique index if not exists client_weights_onboarding_once
  on public.client_weights (user_id)
  where source = 'onboarding';

grant select, insert, update, delete on public.client_weights to authenticated;
grant all on public.client_weights to service_role;

alter table public.client_weights enable row level security;

-- Клиент видит и ведёт только свою историю.
drop policy if exists "client_weights own" on public.client_weights;
create policy "client_weights own" on public.client_weights
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Сотрудник студии клиента — читает (как анкету member_profiles).
drop policy if exists "client_weights staff read" on public.client_weights;
create policy "client_weights staff read" on public.client_weights
  for select to authenticated
  using (
    exists (
      select 1 from public.clients c
       where c.user_id = client_weights.user_id
         and public.is_trainer(auth.uid(), c.studio_id)
    )
  );

-- Уже пройденные анкеты: их вес — первая запись истории, датой отправки.
-- member_profiles создан вне мигратора (db/member_profiles.sql) — на чистой
-- базе без него пропускаем.
do $$
begin
  if to_regclass('public.member_profiles') is not null then
    insert into public.client_weights (user_id, weight_kg, measured_at, source)
    select mp.user_id, mp.weight_kg, mp.onboarding_completed_at, 'onboarding'
      from public.member_profiles mp
     where mp.weight_kg between 20 and 300
       and mp.onboarding_completed_at is not null
       and exists (select 1 from auth.users u where u.id = mp.user_id)
    on conflict do nothing;
  end if;
end;
$$;
