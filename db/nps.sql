-- NPS responses (account-wide pool, no studio scoping).
create table if not exists public.nps_responses (
  id uuid primary key default gen_random_uuid(),
  score int not null check (score between 0 and 10),
  client_name text,
  comment text,
  language text default 'ru',
  survey_type text not null default 'general'
    check (survey_type in ('first_lessons','first_month','before_renewal','after_return','general')),
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists nps_responses_created_idx on public.nps_responses(created_at desc);
create index if not exists nps_responses_type_idx on public.nps_responses(survey_type);

grant select, insert, update, delete on public.nps_responses to authenticated;
grant all on public.nps_responses to service_role;

alter table public.nps_responses enable row level security;

-- ВНИМАНИЕ: политики доступа к этой таблице заданы в
-- db/security_hardening.sql (принцип «своя строка или сотрудник»).
-- Здесь их намеренно НЕ создаём: этот файл идемпотентный и его
-- перезапускают ради новых колонок — раньше он при этом молча
-- возвращал широкую политику и заново открывал доступ.
