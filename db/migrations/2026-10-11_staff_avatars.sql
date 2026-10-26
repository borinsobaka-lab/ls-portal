-- ============================================================================
-- Аватарки сотрудников админки (2026-10-11).
--
-- profiles.avatar_url — путь в бакете avatars (папка staff/). Ставит владелец
-- в «Доступах» через серверную функцию updateEmployee (сервис-ключ, проверка
-- владельца) — из браузера в profiles он не пишется. Показывается в списке
-- «Доступов» и в рейке админки над «Доступами» (пункт «Выход»).
--
-- Бакет avatars уже есть (клиентское приложение кладёт туда фото клиента в
-- папку {uid}/, db/storage_avatars.sql). Здесь — только загрузка в папку
-- staff/ любым сотрудником: имя файла случайное, перезапись и удаление не
-- нужны (как у ImageUploadField: снятая картинка остаётся в бакете). Чтение —
-- публичное, как в db/storage_avatars.sql (тот файл в новом инстансе мог быть
-- не выполнен; загрузке Storage нужно и право select на свою строку).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'avatars');

drop policy if exists "avatars staff folder insert" on storage.objects;
create policy "avatars staff folder insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'staff'
    and public.is_staff(auth.uid())
  );
