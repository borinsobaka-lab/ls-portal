-- ============================================================================
-- Раздел «О нас» в приложении пакетных студий (решение владельца 2026-10-12)
-- ============================================================================
-- Вкладка «О студии» в «Студии» (по каждой студии: фото, описание, карты,
-- соцсети — studio_app_settings) заменена историей бренда Lady Stretch:
-- обложка, первая и вторая студии с галереями, сообщество в цифрах,
-- Instagram, благодарность. Тексты и даты — в коде приложения
-- (apps/client/src/formats/packages/about-config.ts), здесь — то, что меняют
-- из админки («Мобильное приложение» → «О нас»):
--
--   app_about_settings — строка на приложение (формат студий, как
--   app_install_settings): фото обложки, галереи студий, широкое фото
--   сообщества, цифры (посетившие девушки, проведённые групповые
--   тренировки, посещения; null — показатель скрыт), подписчики
--   Instagram (в плашке профиля, null — без строки), шесть фото
--   Instagram со ссылками на посты (заполняются вручную; ссылка пустая —
--   фото ведёт в профиль). Читается публично, правит раздел рейки 'app' +
--   роль хоть в одной студии этого формата.
--
-- Фото — бакет studio-photos (публичный, запись — раздел 'app'), папка
-- about/. Колонки «О студии» в studio_app_settings (about, photo_path,
-- google_maps_url, yandex_maps_url, instagram_url, whatsapp_url,
-- messenger_url) больше не читаются и не правятся, данные не удалены.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

create table if not exists public.app_about_settings (
  format text primary key check (format in ('subscription', 'packages')),
  cover_photo_path text,
  first_studio_photos text[] not null default '{}',
  second_studio_photos text[] not null default '{}',
  community_photo_path text,
  visitors_count integer check (visitors_count is null or visitors_count > 0),
  group_trainings_count integer
    check (group_trainings_count is null or group_trainings_count > 0),
  visits_count integer check (visits_count is null or visits_count > 0),
  instagram_followers integer check (instagram_followers is null or instagram_followers > 0),
  -- [{ "path": "about/…", "url": "https://www.instagram.com/p/…" | null }]
  instagram_posts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(instagram_posts) = 'array'),
  updated_at timestamptz not null default now()
);

comment on table public.app_about_settings is
  'Раздел «О нас» клиентского приложения: строка на формат (приложение). Фото — пути в бакете studio-photos.';
comment on column public.app_about_settings.visitors_count is
  'Сколько девушек посетили студии; в приложении — «N+». null — показатель не показывается.';
comment on column public.app_about_settings.group_trainings_count is
  'Сколько групповых тренировок проведено; в приложении — «N+». null — не показывается.';
comment on column public.app_about_settings.visits_count is
  'Сколько было посещений; в приложении — «N+». null — не показывается.';
comment on column public.app_about_settings.instagram_followers is
  'Подписчики Instagram, вручную; в плашке профиля — «N+ подписчиков». null — не показывается.';
comment on column public.app_about_settings.instagram_posts is
  'Последние фото Instagram, вручную: массив {path, url}; url пустой — фото ведёт в профиль.';

grant select on public.app_about_settings to anon, authenticated;
grant insert, update, delete on public.app_about_settings to authenticated;
grant all on public.app_about_settings to service_role;

alter table public.app_about_settings enable row level security;

drop policy if exists "app_about_settings read" on public.app_about_settings;
create policy "app_about_settings read" on public.app_about_settings
  for select to anon, authenticated using (true);

drop policy if exists "app_about_settings write" on public.app_about_settings;
create policy "app_about_settings write" on public.app_about_settings
  for all to authenticated
  using (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = app_about_settings.format and public.is_trainer(auth.uid(), s.id)
    )
  )
  with check (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = app_about_settings.format and public.is_trainer(auth.uid(), s.id)
    )
  );

-- Цифры от владельца (2026-10-12): 3 500+ девушек посетили студии,
-- 10 000+ групповых тренировок, 45 000+ посещений, 7 200 подписчиков Instagram.
insert into public.app_about_settings
  (format, visitors_count, group_trainings_count, visits_count, instagram_followers)
values ('packages', 3500, 10000, 45000, 7200)
on conflict (format) do nothing;

notify pgrst, 'reload schema';
