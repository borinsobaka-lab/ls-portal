-- ============================================================================
-- Полная очистка клиентской базы всех студий (решение владельца 2026-10-12:
-- снова «фантомные» пользователи в клиентском приложении — начинаем с нуля).
--
-- ⚠️ РАЗОВАЯ И НЕОБРАТИМАЯ. Мигратор выполняет файл один раз; вручную
-- повторно не запускать — сотрёт клиентов, заведённых после очистки.
--
-- Стирается во всех студиях (оба формата):
--   * клиенты (clients) и всё, что на них висит: абонементы клиентов
--     (client_memberships, заморозки membership_freezes), продажи (sales,
--     платежи рассрочки sale_installments, прочие продажи other_sales,
--     возвраты refunds);
--   * записи на занятия (schedule_bookings) и история записей (bookings_log),
--     счётчики мест занятий (schedule_entries.booked_count) — в ноль;
--   * анкеты приложения (member_profiles), оценки тренеров клиентами
--     (trainer_reviews; рейтинг из прежнего сервиса — rating_base_* —
--     остаётся), обратная связь (feedback), опросы NPS (nps_responses);
--   * аватарки клиентов (бакет avatars, кроме папки staff/);
--   * учётные записи GoTrue всех, кто не сотрудник (каскадом — профили,
--     роли, сессии). Сотрудник — роль owner/admin/trainer, права в
--     «Доступах» или метка staff_account (client_account_is_staff): его
--     учётная запись, роли, права и профиль остаются, стирается только
--     клиентская часть (она в таблицах выше).
--
-- Не трогаем: студии, сотрудников (справочник, ставки, реквизиты, график,
-- зарплатные вычеты и выплаты), расписание (занятия), тренировки,
-- номенклатуру абонементов и прочих продаж, промокоды, кассу
-- (cash_operations), новости, услуги, пуши, настройки, скрипты LS.
--
-- Триггеры клиентских таблиц на время очистки выключены: они на каждую
-- строку пересчитывают балансы, возвращают заменённые абонементы, пишут
-- журнал и удаляют учётные записи по одной — при удалении всего это лишняя
-- работа и лишние ошибки. Внешние ключи при этом работают как обычно.
--
-- Порядок: после 2026-10-12_zzz_staff_client_separation.sql. Выполняет
-- мигратор при старте админки (db/migrate.ts), в одной транзакции.
-- ============================================================================

do $$
declare
  -- Порядок удаления — по внешним ключам: сначала то, что ссылается.
  _tables text[] := array[
    'refunds',
    'membership_freezes',
    'sale_installments',
    'bookings_log',
    'schedule_bookings',
    'client_memberships',
    'sales',
    'other_sales',
    'member_profiles',
    'trainer_reviews',
    'feedback',
    'nps_responses',
    'clients'
  ];
  _present text[] := '{}';
  _t text;
  _n bigint;
  _uid uuid;
  _deleted int := 0;
  _kept int := 0;
  _staff int := 0;
begin
  foreach _t in array _tables loop
    if to_regclass('public.' || _t) is not null then
      _present := _present || _t;
    end if;
  end loop;

  foreach _t in array _present loop
    execute format('alter table public.%I disable trigger user', _t);
  end loop;

  foreach _t in array _present loop
    execute format('delete from public.%I', _t);
    get diagnostics _n = row_count;
    raise notice 'Очистка %: удалено строк %', _t, _n;
  end loop;

  foreach _t in array _present loop
    execute format('alter table public.%I enable trigger user', _t);
  end loop;

  -- Аватарки клиентов: папки {uid}/ бакета avatars (staff/ — сотрудники).
  -- До учётных записей: в старых версиях Storage objects.owner ссылается на
  -- auth.users и не дал бы их удалить. Не вышло — только предупреждение:
  -- карточек, которые на них ссылались, больше нет.
  if to_regclass('storage.objects') is not null then
    begin
      -- Новые версии Storage запрещают такое удаление без этого флага.
      perform set_config('storage.allow_delete_query', 'true', true);
      delete from storage.objects
       where bucket_id = 'avatars'
         and name not like 'staff/%';
      get diagnostics _n = row_count;
      raise notice 'Аватарки клиентов удалены: %', _n;
    exception when others then
      raise warning 'Очистка: аватарки клиентов не удалены: %', sqlerrm;
    end;
  end if;

  -- Учётные записи: остаются только сотрудники.
  for _uid in select u.id from auth.users u loop
    if public.client_account_is_staff(_uid) then
      _staff := _staff + 1;
      continue;
    end if;
    begin
      delete from auth.users where id = _uid;
      _deleted := _deleted + 1;
    exception when others then
      _kept := _kept + 1;
      raise warning 'Очистка: учётная запись % не удалена: %', _uid, sqlerrm;
    end;
  end loop;
  raise notice 'Учётные записи: удалено %, сотрудников оставлено %, не удалось удалить %',
    _deleted, _staff, _kept;

  -- Роль member — клиентская часть (её ставит вход в приложение); у
  -- сотрудников она вернётся, когда им заведут карточку клиента.
  delete from public.user_roles where role::text = 'member';
  get diagnostics _n = row_count;
  raise notice 'Клиентских ролей member снято: %', _n;

  -- Места на занятиях — записей больше нет.
  update public.schedule_entries set booked_count = 0 where booked_count <> 0;
  get diagnostics _n = row_count;
  raise notice 'Счётчик мест обнулён у занятий: %', _n;

  -- Рейтинг тренеров — без оценок клиентов (пересчитывает trainers_rating_calc).
  if to_regclass('public.trainer_reviews') is not null then
    update public.trainers set rating_count = rating_count;
  end if;

  -- Статистика за 30 дней (если матвью есть) — без удалённых клиентов.
  if to_regclass('public.client_stats_30d_mv') is not null then
    begin
      execute 'refresh materialized view public.client_stats_30d_mv';
    exception when others then
      raise warning 'Очистка: client_stats_30d_mv не обновлена: %', sqlerrm;
    end;
  end if;
end;
$$;
