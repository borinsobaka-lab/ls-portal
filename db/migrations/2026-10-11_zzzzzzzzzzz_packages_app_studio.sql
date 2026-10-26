-- ============================================================================
-- Приложение пакетных студий (pack.base40.fit), правки владельца 2026-10-11:
--
-- 1. Раздел «Студия» в приложении: о студии — фото, описание, ссылки на
--    Google и Яндекс.Карты, Instagram. Колонки studio_app_settings (строка
--    на студию, читается публично, правит раздел рейки «Мобильное
--    приложение» — прежняя политика "studio_app_settings write"). Фото —
--    бакет studio-photos (публичное чтение, запись — раздел 'app').
-- 2. Биография тренера (вкладка «Тренеры» в «Студии»): trainers.bio —
--    текст с разметкой (**жирный**, *курсив*, списки «- », ссылки), правится
--    в «Сотрудниках». Колонка была в db/trainers.sql, но живая таблица
--    создана раньше — добавляем явно.
-- 3. Порядок абонементов: memberships.sort_order — в этом порядке номенклатура
--    стоит в админке и в приложении (перетаскивание строк в «Номенклатурах»).
--    Существующим — по возрастанию цены, как их показывало приложение.
-- 4. Переключатель студий в приложении: клиент смотрит расписание,
--    тренировки, тренеров и абонементы ДРУГОЙ студии того же формата, что и
--    его (раньше всё читалось только по current_studio_id). Записаться
--    по-прежнему можно только туда, где у клиента абонемент
--    (book_schedule_entry). Политики добавлены рядом с прежними (permissive —
--    складываются через OR), прежние не тронуты.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. О студии ---------------------------------------------------------------

alter table public.studio_app_settings add column if not exists about text;
alter table public.studio_app_settings add column if not exists photo_path text;
alter table public.studio_app_settings add column if not exists google_maps_url text;
alter table public.studio_app_settings add column if not exists yandex_maps_url text;
alter table public.studio_app_settings add column if not exists instagram_url text;

comment on column public.studio_app_settings.about is
  'Краткое описание студии для раздела «Студия» в приложении (текст с разметкой).';
comment on column public.studio_app_settings.photo_path is
  'Фото студии: путь в бакете studio-photos (или полный URL).';

insert into storage.buckets (id, name, public)
values ('studio-photos', 'studio-photos', true)
on conflict (id) do nothing;

drop policy if exists "studio-photos public read" on storage.objects;
create policy "studio-photos public read" on storage.objects
  for select using (bucket_id = 'studio-photos');

drop policy if exists "studio-photos staff insert" on storage.objects;
create policy "studio-photos staff insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'studio-photos' and public.has_admin_section(auth.uid(), 'app'));

drop policy if exists "studio-photos staff update" on storage.objects;
create policy "studio-photos staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'studio-photos' and public.has_admin_section(auth.uid(), 'app'))
  with check (bucket_id = 'studio-photos' and public.has_admin_section(auth.uid(), 'app'));

drop policy if exists "studio-photos staff delete" on storage.objects;
create policy "studio-photos staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'studio-photos' and public.has_admin_section(auth.uid(), 'app'));

-- 2. Биография тренера --------------------------------------------------------

alter table public.trainers add column if not exists bio text;

comment on column public.trainers.bio is
  'Биография тренера для приложения (вкладка «Тренеры» в «Студии»), текст с разметкой.';

-- 3. Порядок абонементов ------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'memberships' and column_name = 'sort_order'
  ) then
    alter table public.memberships add column sort_order integer not null default 0;
    -- Только при добавлении колонки: повторный прогон не сбивает порядок,
    -- выставленный в админке.
    update public.memberships m
       set sort_order = o.rn
      from (
        select id, row_number() over (partition by studio_id order by price, name, id) as rn
          from public.memberships
      ) o
     where o.id = m.id;
  end if;
end;
$$;

comment on column public.memberships.sort_order is
  'Порядок в «Номенклатурах» админки и в приложении (по возрастанию).';

create index if not exists memberships_studio_sort_idx
  on public.memberships (studio_id, sort_order);

-- 4. Просмотр других студий того же формата ----------------------------------

-- Студия того же формата, что и студия вызывающего (profiles.studio_id).
-- security definer: studios и profiles читаются без оглядки на RLS.
create or replace function public.client_can_browse_studio(_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.studios s
      join public.studios mine on mine.id = public.current_studio_id(auth.uid())
     where s.id = _studio_id
       and s.format = mine.format
  )
$$;

revoke all on function public.client_can_browse_studio(uuid) from public;
grant execute on function public.client_can_browse_studio(uuid) to authenticated;

drop policy if exists "schedule client browse" on public.schedule_entries;
create policy "schedule client browse" on public.schedule_entries
  for select to authenticated
  using (
    kind = 'group'
    and cancelled_at is null
    and public.client_can_browse_studio(studio_id)
  );

drop policy if exists "set client browse" on public.schedule_entry_trainers;
create policy "set client browse" on public.schedule_entry_trainers
  for select to authenticated
  using (exists (
    select 1 from public.schedule_entries e
     where e.id = entry_id
       and e.kind = 'group'
       and e.cancelled_at is null
       and public.client_can_browse_studio(e.studio_id)
  ));

drop policy if exists "workouts client browse" on public.workouts;
create policy "workouts client browse" on public.workouts
  for select to authenticated
  using (public.client_can_browse_studio(studio_id));

drop policy if exists "trainer_studios client browse" on public.trainer_studios;
create policy "trainer_studios client browse" on public.trainer_studios
  for select to authenticated
  using (public.client_can_browse_studio(studio_id));

drop policy if exists "trainers client browse" on public.trainers;
create policy "trainers client browse" on public.trainers
  for select to authenticated
  using (exists (
    select 1 from public.trainer_studios ts
     where ts.trainer_id = trainers.id
       and public.client_can_browse_studio(ts.studio_id)
  ));

-- Чужой студии — только то, что показывается в приложении (is_active).
drop policy if exists "memberships client browse" on public.memberships;
create policy "memberships client browse" on public.memberships
  for select to authenticated
  using (is_active and public.client_can_browse_studio(studio_id));

notify pgrst, 'reload schema';
