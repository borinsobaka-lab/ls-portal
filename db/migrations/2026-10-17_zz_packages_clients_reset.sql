-- ============================================================================
-- Очистка клиентской базы пакетных клубов (решение владельца 2026-10-17:
-- перед запуском — чистые клиенты, абонементы, прочие продажи и история
-- записей во всех клубах формата «пакеты тренировок»).
--
-- ⚠️ РАЗОВАЯ И НЕОБРАТИМАЯ. Мигратор выполняет файл один раз; вручную
-- повторно не запускать — сотрёт клиентов, заведённых после очистки.
--
-- Стирается в пакетных клубах (studios.format = 'packages'):
--   * клиенты (clients — общая база сети, 2026-10-17_packages_shared_clients.sql)
--     и всё, что на них висит каскадом: заявки (client_requests);
--   * абонементы клиентов (client_memberships, заморозки membership_freezes)
--     и продажи абонементов (sales, платежи sale_installments, возвраты
--     refunds) — продажи пакетных клубов и любые продажи этих клиентов;
--   * прочие продажи (other_sales) и возвраты по ним;
--   * записи на занятия (schedule_bookings) и история записей
--     (bookings_log); диагностики тела (schedule_entries.kind = 'diagnostic'
--     — занятие на одного клиента, без него пустое); счётчики мест занятий
--     (booked_count) — в ноль;
--   * учётная запись приложения — как при удалении карточки в «Клиентах»
--     (триггеры clients_wipe_account_ad, clients_push_cleanup_ad,
--     clients_app_activity_cleanup_ad, clients_nps_anonymize_bd): если у неё
--     не осталось карточки в подписочном клубе — стирается (анкета, вес,
--     оценки тренеров, устройства, активность, пуши; у сотрудника — только
--     клиентская часть); ответы NPS остаются обезличенными.
--
-- Не трогаем: подписочные клубы целиком; в пакетных — клубы, сотрудников
-- (справочник, ставки, реквизиты, график, вычеты и выплаты зарплат),
-- расписание (групповые, персональные, прочая активность), каталог
-- тренировок и номенклатуры, промокоды, кассу (cash_operations), обратную
-- связь, новости, услуги, пуши, триггеры, настройки приложения.
--
-- Продажи, абонементы и записи удаляются с выключенными триггерами: они на
-- каждую строку возвращают тренировки, восстанавливают заменённые абонементы,
-- двигают очередь продлений и пишут журнал — при удалении всего это лишняя
-- работа и лишние ошибки. Внешние ключи работают как обычно. Карточки
-- клиентов — уже с включёнными триггерами (стирают учётные записи).
--
-- Порядок: после 2026-10-17_packages_shared_clients.sql. Выполняет мигратор
-- при старте админки (db/migrate.ts), в одной транзакции.
-- ============================================================================

do $$
declare
  -- Таблицы, где на время удаления выключаются триггеры.
  _tables text[] := array[
    'refunds',
    'membership_freezes',
    'sale_installments',
    'bookings_log',
    'schedule_bookings',
    'client_memberships',
    'sales',
    'other_sales'
  ];
  _t text;
  _n bigint;
  _users uuid[];
  _gone uuid[];
begin
  create temp table _pk_studios on commit drop as
    select id from public.studios where format = 'packages';
  if not exists (select 1 from _pk_studios) then
    raise notice 'Очистка пакетных клубов: пакетных клубов нет';
    return;
  end if;

  create temp table _pk_clients on commit drop as
    select c.id, c.user_id
      from public.clients c
     where c.studio_id in (select id from _pk_studios);

  create temp table _pk_sales on commit drop as
    select s.id from public.sales s
     where s.studio_id in (select id from _pk_studios)
        or s.client_id in (select id from _pk_clients);

  create temp table _pk_other_sales on commit drop as
    select o.id from public.other_sales o
     where o.studio_id in (select id from _pk_studios)
        or o.client_id in (select id from _pk_clients);

  create temp table _pk_memberships on commit drop as
    select cm.id from public.client_memberships cm
     where cm.studio_id in (select id from _pk_studios)
        or cm.client_id in (select id from _pk_clients)
        or cm.sale_id in (select id from _pk_sales);

  _users := array(select distinct user_id from _pk_clients where user_id is not null);

  foreach _t in array _tables loop
    execute format('alter table public.%I disable trigger user', _t);
  end loop;

  delete from public.refunds
   where studio_id in (select id from _pk_studios)
      or sale_id in (select id from _pk_sales)
      or other_sale_id in (select id from _pk_other_sales);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: возвратов %', _n;

  delete from public.membership_freezes
   where studio_id in (select id from _pk_studios)
      or client_membership_id in (select id from _pk_memberships);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: заморозок %', _n;

  delete from public.sale_installments where sale_id in (select id from _pk_sales);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: платежей рассрочки %', _n;

  delete from public.bookings_log
   where studio_id in (select id from _pk_studios)
      or client_id in (select id from _pk_clients);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: строк истории записей %', _n;

  delete from public.schedule_bookings
   where studio_id in (select id from _pk_studios)
      or client_id in (select id from _pk_clients);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: записей на занятия %', _n;

  delete from public.client_memberships where id in (select id from _pk_memberships);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: абонементов клиентов %', _n;

  delete from public.sales where id in (select id from _pk_sales);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: продаж абонементов %', _n;

  delete from public.other_sales where id in (select id from _pk_other_sales);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: прочих продаж %', _n;

  foreach _t in array _tables loop
    execute format('alter table public.%I enable trigger user', _t);
  end loop;

  -- Диагностики тела — занятие на одного клиента; записей больше нет.
  delete from public.schedule_entries
   where kind = 'diagnostic'
     and studio_id in (select id from _pk_studios);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: диагностик в расписании %', _n;

  -- Места на занятиях — записей больше нет.
  update public.schedule_entries set booked_count = 0
   where studio_id in (select id from _pk_studios)
     and booked_count <> 0;
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: счётчик мест обнулён у занятий %', _n;

  -- Карточки — с триггерами: учётная запись без других карточек стирается
  -- (wipe_client_app_account), устройства, активность и пуши — тоже.
  delete from public.clients where id in (select id from _pk_clients);
  get diagnostics _n = row_count;
  raise notice 'Очистка пакетных клубов: клиентов %', _n;

  _gone := array(
    select u from unnest(_users) u
     where not exists (select 1 from auth.users au where au.id = u));
  raise notice 'Очистка пакетных клубов: учётных записей приложения удалено % из %',
    coalesce(array_length(_gone, 1), 0), coalesce(array_length(_users, 1), 0);

  -- Аватарки удалённых учётных записей (папки {uid}/ бакета avatars). Не
  -- вышло — только предупреждение: ссылок на них больше нет.
  if to_regclass('storage.objects') is not null and coalesce(array_length(_gone, 1), 0) > 0 then
    begin
      perform set_config('storage.allow_delete_query', 'true', true);
      delete from storage.objects
       where bucket_id = 'avatars'
         and split_part(name, '/', 1) in (select u::text from unnest(_gone) u);
      get diagnostics _n = row_count;
      raise notice 'Очистка пакетных клубов: аватарок %', _n;
    exception when others then
      raise warning 'Очистка пакетных клубов: аватарки не удалены: %', sqlerrm;
    end;
  end if;

  -- Рейтинг тренеров — без стёртых оценок (пересчитывает trainers_rating_calc).
  update public.trainers set rating_count = rating_count;

  if to_regclass('public.client_stats_30d_mv') is not null then
    begin
      execute 'refresh materialized view public.client_stats_30d_mv';
    exception when others then
      raise warning 'Очистка пакетных клубов: client_stats_30d_mv не обновлена: %', sqlerrm;
    end;
  end if;
end;
$$;
