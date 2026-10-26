-- Push notifications for the mobile app

create table if not exists public.push_notifications (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null,
  message text,
  -- Если указана, в мобильном приложении показывается кнопка «Перейти»
  action_url text,
  -- Segments: any subset of {'chk','bchk','pchk'} or {'all'}
  segments text[] not null default '{all}',
  scheduled_at timestamptz,
  sent_at timestamptz,
  status text not null default 'draft', -- draft | scheduled | sent
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  read_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_notifications add column if not exists action_url text;

create index if not exists push_notifications_studio_created_idx
  on public.push_notifications(studio_id, created_at desc);

notify pgrst, 'reload schema';

grant select, insert, update, delete on public.push_notifications to authenticated;
grant all on public.push_notifications to service_role;

alter table public.push_notifications enable row level security;

drop policy if exists "push studio read" on public.push_notifications;
create policy "push studio read" on public.push_notifications
  for select to authenticated
  using (public.is_trainer(auth.uid(), studio_id));

drop policy if exists "push studio write" on public.push_notifications;
create policy "push studio write" on public.push_notifications
  for all to authenticated
  using (public.is_trainer(auth.uid(), studio_id))
  with check (public.is_trainer(auth.uid(), studio_id));
