-- Club-level settings configurable from admin panel and consumed by mobile app.
create table if not exists public.club_settings (
  id boolean primary key default true,
  write_url text,
  call_url text,
  feedback_url text,
  cancel_booking_minutes integer not null default 180,
  updated_at timestamptz not null default now(),
  constraint club_settings_single_row check (id)
);

grant select, insert, update, delete on public.club_settings to authenticated;
grant select on public.club_settings to anon;
grant all on public.club_settings to service_role;

alter table public.club_settings enable row level security;

drop policy if exists "club_settings read" on public.club_settings;
create policy "club_settings read"
  on public.club_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "club_settings write" on public.club_settings;
create policy "club_settings write"
  on public.club_settings for all
  to authenticated
  using (true)
  with check (true);
