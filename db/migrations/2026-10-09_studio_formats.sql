-- ============================================================================
-- Форматы студий и брендинг (2026-10-09). Подробности — STUDIO_FORMATS.md.
--
-- 1) studios.format — формат студии:
--      subscription — «Зал с подписочной моделью» (всё, что сделано до сих пор);
--      packages     — «Зал с пакетами тренировок» (новый формат, в разработке).
--    Существующие студии получают subscription.
-- 2) studios.brand_color (#rrggbb) — основной цвет студии в админке (иконки
--    меню, акценты); studios.logo_url — логотип в шапке бокового меню
--    (путь в бакете studio-logos или полный URL). Существующим студиям
--    логотип ставится разово — прежний встроенный (Lady Stretch).
-- 3) Чтение studios — публичное (как news/services/club_settings): название,
--    формат, цвет и логотип — витрина; нужны клиентскому приложению ещё до
--    входа (выбор студии при регистрации). Колонки отдаются только
--    перечисленные — новые поля сами наружу не попадут.
-- 4) Создание студии — RPC create_studio: только владелец (owner) хотя бы
--    одной студии; создатель сразу получает роль owner в новой студии.
--    Правка — владелец этой студии (политика «studios updatable by owners»),
--    только колонки name/format/brand_color/logo_url. Удаления нет намеренно:
--    каскадом ушли бы все данные студии.
-- 5) Бакет studio-logos (публичный): запись — только сотрудник.
--
-- Идемпотентно. Выполняет мигратор при старте админки (scripts/migrate.ts);
-- без DATABASE_URL — вручную в Supabase SQL Editor (Studio) до мержа кода.
-- ============================================================================

-- 1-2) Колонки -----------------------------------------------------------------
alter table public.studios add column if not exists format text not null default 'subscription';

alter table public.studios drop constraint if exists studios_format_check;
alter table public.studios
  add constraint studios_format_check check (format in ('subscription', 'packages'));

alter table public.studios add column if not exists brand_color text not null default '#f763fc';

alter table public.studios drop constraint if exists studios_brand_color_check;
alter table public.studios
  add constraint studios_brand_color_check check (brand_color ~ '^#[0-9a-fA-F]{6}$');

-- Логотип: при первом добавлении колонки существующим студиям ставим прежний
-- встроенный логотип (файл public/logos/lady-stretch.svg админки), чтобы меню
-- не осталось без логотипа. Повторный прогон новые студии не трогает.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'studios' and column_name = 'logo_url'
  ) then
    alter table public.studios add column logo_url text;
    update public.studios set logo_url = 'https://admin.base40.fit/logos/lady-stretch.svg';
  end if;
end $$;

-- slug обязателен и уникален, но в форме админки его нет — генерируем.
alter table public.studios
  alter column slug set default ('studio-' || substr(md5(gen_random_uuid()::text), 1, 8));

-- 3) Доступ --------------------------------------------------------------------
drop policy if exists "studios readable by members" on public.studios;
drop policy if exists "studios public read" on public.studios;
create policy "studios public read" on public.studios
  for select to anon, authenticated using (true);

revoke select, insert, update, delete on public.studios from anon, authenticated;
grant select (id, name, slug, format, brand_color, logo_url, created_at)
  on public.studios to anon, authenticated;
grant update (name, format, brand_color, logo_url) on public.studios to authenticated;

drop policy if exists "studios updatable by owners" on public.studios;
create policy "studios updatable by owners" on public.studios
  for update to authenticated
  using (public.has_role(auth.uid(), id, 'owner'))
  with check (public.has_role(auth.uid(), id, 'owner'));

-- 4) Создание студии -------------------------------------------------------------
create or replace function public.create_studio(
  _name text,
  _format text,
  _brand_color text,
  _logo_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _id uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Создавать студии может только владелец' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(_name, '')), '') is null then
    raise exception 'Укажите название студии' using errcode = '22023';
  end if;

  insert into public.studios (name, format, brand_color, logo_url)
  values (trim(_name), _format, _brand_color, nullif(trim(coalesce(_logo_url, '')), ''))
  returning id into _id;

  insert into public.user_roles (user_id, studio_id, role)
  values (auth.uid(), _id, 'owner')
  on conflict (user_id, studio_id, role) do nothing;

  return _id;
end;
$$;

revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated;

-- 5) Логотипы ------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('studio-logos', 'studio-logos', true)
on conflict (id) do update set public = true;

drop policy if exists "studio-logos public read" on storage.objects;
create policy "studio-logos public read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'studio-logos');

drop policy if exists "studio-logos staff insert" on storage.objects;
create policy "studio-logos staff insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'studio-logos' and public.is_staff(auth.uid()));

drop policy if exists "studio-logos staff update" on storage.objects;
create policy "studio-logos staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'studio-logos' and public.is_staff(auth.uid()))
  with check (bucket_id = 'studio-logos' and public.is_staff(auth.uid()));

drop policy if exists "studio-logos staff delete" on storage.objects;
create policy "studio-logos staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'studio-logos' and public.is_staff(auth.uid()));
