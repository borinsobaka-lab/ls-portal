-- Run AFTER db/schema.sql on your external Supabase project.
-- Creates a profile row and assigns the default 'member' role whenever a
-- new auth.users row is inserted (email/password signup or OAuth).
--
-- Studio assignment: takes studio_id from raw_user_meta_data.studio_id when
-- present, otherwise falls back to the oldest studio. Adjust to suit your
-- multi-tenant onboarding flow.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _studio_id uuid;
begin
  _studio_id := nullif(new.raw_user_meta_data->>'studio_id', '')::uuid;
  if _studio_id is null then
    select id into _studio_id from public.studios order by created_at asc limit 1;
  end if;

  if _studio_id is null then
    raise exception 'No studio available for new user %', new.id;
  end if;

  insert into public.profiles (id, studio_id, full_name, email)
  values (
    new.id,
    _studio_id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, studio_id, role)
  values (new.id, _studio_id, 'member')
  on conflict (user_id, studio_id, role) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
