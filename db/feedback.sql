-- Feedback (client requests) — account-wide pool, no studio scoping.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  topic text not null
    check (topic in ('training','staff','cleanliness','app','idea','thanks','other')),
  message text not null,
  mood text check (mood in ('negative','neutral','positive') or mood is null),
  client_name text,
  client_contact text,
  status text not null default 'pending' check (status in ('pending','resolved')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_by_name text,
  resolved_at timestamptz,
  resolution_comment text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_status_idx on public.feedback(status, created_at desc);

grant select, insert, update, delete on public.feedback to authenticated;
grant all on public.feedback to service_role;

alter table public.feedback enable row level security;

-- ВНИМАНИЕ: политики доступа к этой таблице заданы в
-- db/security_hardening.sql (принцип «своя строка или сотрудник»).
-- Здесь их намеренно НЕ создаём: этот файл идемпотентный и его
-- перезапускают ради новых колонок — раньше он при этом молча
-- возвращал широкую политику и заново открывал доступ.
