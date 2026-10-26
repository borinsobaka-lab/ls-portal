-- Индексы и вью под серверную пагинацию админки.
-- Выполнять в Supabase SQL Editor целиком, идемпотентно (можно запускать повторно).
--
-- Контекст: до этой миграции страницы «Клиенты», «Продажи», «Касса» и «История
-- записей» грузили всю таблицу студии целиком и листали её в браузере. После
-- перевода на серверную пагинацию запросы стали вида
-- «фильтр по studio_id + сортировка + LIMIT/OFFSET + точный COUNT», и им нужны
-- составные индексы, у которых порядок колонок совпадает с порядком в запросе.
--
-- Примечание для будущего: на таблице с большим объёмом данных индексы лучше
-- создавать через CREATE INDEX CONCURRENTLY (не блокирует запись). Здесь
-- используется обычный CREATE INDEX — на текущих объёмах это доли секунды.

-- ---------------------------------------------------------------------------
-- 1. Составные индексы под «фильтр + сортировка»
-- ---------------------------------------------------------------------------

-- clients: .eq(studio_id).order(created_at desc)
-- Был только clients(studio_id) — сортировка требовала отдельного прохода.
create index if not exists clients_studio_created_idx
  on public.clients (studio_id, created_at desc);

-- bookings_log: .eq(studio_id).order(starts_at desc)
-- Были два раздельных индекса — studio_id и starts_at; для этого запроса
-- планировщик мог использовать только один из них.
create index if not exists bookings_log_studio_starts_idx
  on public.bookings_log (studio_id, starts_at desc);

-- schedule_entries: .eq(studio_id).gte(starts_at, ...) — выборка расписания
-- по диапазону дат.
create index if not exists schedule_entries_studio_starts_idx
  on public.schedule_entries (studio_id, starts_at);

-- client_memberships: вычисление статуса ЧК/ПЧК/БЧК идёт подзапросами
-- «есть ли у клиента активный абонемент» (см. вью ниже).
create index if not exists client_memberships_client_status_idx
  on public.client_memberships (client_id, status, ends_at);

-- schedule_bookings: подсчёт активных записей на занятие.
create index if not exists schedule_bookings_entry_status_idx
  on public.schedule_bookings (entry_id, status);

-- client_memberships.sale_id — внешний ключ, а Postgres под внешние ключи
-- индексы автоматически не создаёт. По нему идёт подзапрос во вью sales_list.
create index if not exists client_memberships_sale_idx
  on public.client_memberships (sale_id);

-- Итоги кассы (вью cash_totals) суммируют все операции студии, поэтому строки
-- всё равно читаются целиком. INCLUDE(kind, amount) даёт Index Only Scan —
-- проверено на 100 тыс. операций: планировщик выбирает этот индекс, как только
-- в таблице появляется больше одной студии.
create index if not exists cash_operations_studio_totals_idx
  on public.cash_operations (studio_id) include (kind, amount);

-- Индексы, которые уже существуют и менять их не нужно (проверено):
--   sales            (studio_id, sold_at desc)
--   cash_operations  (studio_id, occurred_at desc)
--   feedback         (status, created_at desc)
--   nps_responses    (created_at desc)

-- ---------------------------------------------------------------------------
-- 2. Поиск по клиентам (ILIKE '%...%') — триграммные индексы
-- ---------------------------------------------------------------------------
-- Без них серверный поиск по 2500+ клиентам приводит к полному просмотру
-- таблицы. GIN + gin_trgm_ops ускоряет подстрочный поиск.
-- Важно: триграммы работают начиная с 3 символов запроса; на 1–2 символах
-- Postgres всё равно выберет seq scan — это нормально.

create extension if not exists pg_trgm;

-- В браузере поиск шёл по склейке «Фамилия Имя» (см. displayName в
-- clients.tsx), поэтому запрос «Иванов Пётр» находил клиента. Поиск по
-- отдельным колонкам такое не нашёл бы, так что склейка вынесена в
-- вычисляемое поле search_name вью (ниже), а индекс строится по тому же
-- выражению — планировщик сопоставляет их и использует индекс.
create index if not exists clients_search_name_trgm_idx
  on public.clients using gin (
    (
      coalesce(last_name, '') || ' ' ||
      coalesce(first_name, '') || ' ' ||
      coalesce(full_name, '')
    ) gin_trgm_ops
  );

create index if not exists clients_phone_trgm_idx
  on public.clients using gin (phone gin_trgm_ops);

create index if not exists clients_email_trgm_idx
  on public.clients using gin (email gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. Вью clients_with_status — статус клуба на стороne БД
-- ---------------------------------------------------------------------------
-- Статус ЧК/ПЧК/БЧК раньше вычислялся в браузере, поэтому фильтр по нему
-- требовал загрузки всех клиентов и всех их абонементов. Чтобы фильтровать и
-- листать на сервере, та же логика перенесена в SQL — один в один с
-- src/lib/client-status.ts:
--   chk  — есть абонемент status='active' и (ends_at is null или ends_at >= сегодня)
--   bchk — абонементы есть, но активного нет
--   pchk — абонементов никогда не было
--
-- security_invoker = true: вью исполняется с правами вызывающего, поэтому
-- продолжают действовать RLS-политики таблиц clients и client_memberships.
-- Без этого флага вью работала бы с правами владельца и обходила RLS.
--
-- Вью только для чтения списка. Вставка/изменение/удаление клиентов в коде
-- по-прежнему идут напрямую в таблицу public.clients.

-- Статус считается через LEFT JOIN LATERAL, а не двумя EXISTS-подзапросами.
-- Причина практическая: на паре EXISTS планировщик выбирал «hashed subplan» и
-- один раз прочитывал client_memberships целиком — на 5 студий это сотни тысяч
-- строк при открытии каждой страницы. LATERAL выполняется для строк, реально
-- попавших в выдачу (25 на страницу), и берёт их по индексу
-- client_memberships_client_status_idx.

drop view if exists public.clients_with_status;
create view public.clients_with_status
with (security_invoker = true) as
select
  c.*,
  coalesce(c.last_name, '') || ' ' ||
  coalesce(c.first_name, '') || ' ' ||
  coalesce(c.full_name, '') as search_name,
  case
    when st.has_active then 'chk'
    when st.has_any then 'bchk'
    else 'pchk'
  end as club_status
from public.clients c
left join lateral (
  select
    count(*) > 0 as has_any,
    coalesce(
      bool_or(cm.status = 'active' and (cm.ends_at is null or cm.ends_at >= current_date)),
      false
    ) as has_active
  from public.client_memberships cm
  where cm.client_id = c.id
) st on true;

grant select on public.clients_with_status to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Вью sales_list — список продаж со связями и полем для поиска
-- ---------------------------------------------------------------------------
-- Страница «Продажи» ищет одновременно по имени клиента и названию абонемента,
-- то есть по двум связанным таблицам. Выразить такое условие одним фильтром
-- PostgREST по вложенным ресурсам нельзя, поэтому склейка вынесена в колонку
-- search_text, и поиск стал обычным ilike по одному полю.
--
-- Связанные объекты собираются через json_build_object/json_agg ровно в той же
-- форме, что отдавал вложенный select PostgREST (clients / memberships /
-- client_memberships), поэтому код рендера страницы не меняется.

drop view if exists public.sales_list;
create view public.sales_list
with (security_invoker = true) as
select
  s.*,
  coalesce(cl.last_name, '') || ' ' ||
  coalesce(cl.first_name, '') || ' ' ||
  coalesce(cl.full_name, '') || ' ' ||
  coalesce(m.name, '') as search_text,
  case
    when cl.id is null then null
    else json_build_object(
      'id', cl.id,
      'full_name', cl.full_name,
      'first_name', cl.first_name,
      'last_name', cl.last_name,
      'phone', cl.phone,
      'email', cl.email
    )
  end as clients,
  case
    when m.id is null then null
    else json_build_object('id', m.id, 'name', m.name)
  end as memberships,
  coalesce(
    (
      select json_agg(
        json_build_object(
          'id', cm.id,
          'status', cm.status,
          'auto_renew', cm.auto_renew,
          'ends_at', cm.ends_at,
          'cancelled_at', cm.cancelled_at
        )
      )
      from public.client_memberships cm
      where cm.sale_id = s.id
    ),
    '[]'::json
  ) as client_memberships
from public.sales s
left join public.clients cl on cl.id = s.client_id
left join public.memberships m on m.id = s.membership_id;

grant select on public.sales_list to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Вью cash_totals — итоги кассы по студии
-- ---------------------------------------------------------------------------
-- Баланс и суммы прихода/расхода на странице «Касса» раньше считались в
-- браузере по всему загруженному списку операций. После перехода на
-- постраничную загрузку так считать нельзя — иначе итоги показывали бы только
-- текущую страницу. Поэтому суммирование выполняет БД по всем операциям
-- студии, независимо от того, какая страница открыта.

drop view if exists public.cash_totals;
create view public.cash_totals
with (security_invoker = true) as
select
  studio_id,
  coalesce(sum(amount) filter (where kind = 'income'), 0) as income,
  coalesce(sum(amount) filter (where kind = 'expense'), 0) as expense
from public.cash_operations
group by studio_id;

grant select on public.cash_totals to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Вью bookings_log_full — журнал записей вместе с ещё не занесёнными в него
-- ---------------------------------------------------------------------------
-- Страница «История записей» показывала объединение двух источников: строк
-- bookings_log и «восстановленных» строк по тем schedule_bookings, которых в
-- журнале ещё нет. Сшивка делалась в браузере и требовала загрузить оба
-- источника целиком — их обрезали жёстким limit(1000), из-за чего часть
-- записей просто не отображалась.
--
-- Та же сшивка, выполненная в БД, снимает и обрезание, и необходимость
-- грузить всё: страница делает обычный запрос с фильтром, сортировкой и
-- LIMIT/OFFSET.
--
-- Замеры (Postgres 16, 20 000 броней, из них 20 не попали в журнал):
-- страница отдаётся за ~9 мс. Основная часть — сверка «каких броней нет в
-- журнале»: она по своей природе сравнивает множества целиком, поэтому растёт
-- вместе с числом броней (на ~1 млн ожидается несколько сотен мс).
-- Настоящее решение на будущее — сделать журнал единственным источником
-- правды: разово дозаполнить пропуски и убедиться, что триггер
-- schedule_bookings_log_aiu срабатывает всегда. После этого вторую ветку
-- UNION можно будет убрать совсем.

drop view if exists public.bookings_log_full;
create view public.bookings_log_full
with (security_invoker = true) as
select
  bl.id::text as id,
  bl.studio_id,
  bl.booking_id,
  bl.entry_id,
  bl.user_id,
  bl.client_first_name,
  bl.client_last_name,
  bl.client_full_name,
  bl.client_phone,
  bl.client_email,
  bl.workout_name,
  bl.workout_type,
  bl.starts_at,
  bl.ends_at,
  bl.status::text as status,
  bl.booked_at,
  bl.cancelled_at,
  bl.completed_at,
  bl.met_value,
  bl.weight_at_time,
  bl.duration_min,
  bl.calories,
  concat_ws(' ',
    bl.client_full_name, bl.client_first_name, bl.client_last_name,
    bl.client_phone, bl.client_email, bl.workout_name
  ) as search_text
from public.bookings_log bl

union all

select
  'schedule-booking-' || sb.id::text as id,
  sb.studio_id,
  sb.id as booking_id,
  sb.entry_id,
  sb.user_id,
  c.first_name as client_first_name,
  c.last_name as client_last_name,
  coalesce(
    c.full_name,
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')
  ) as client_full_name,
  c.phone as client_phone,
  c.email as client_email,
  w.name as workout_name,
  w.type as workout_type,
  se.starts_at,
  se.ends_at,
  sb.status::text as status,
  sb.created_at as booked_at,
  sb.cancelled_at,
  null::timestamptz as completed_at,
  null::numeric(4, 2) as met_value,
  null::numeric(5, 1) as weight_at_time,
  null::int as duration_min,
  null::int as calories,
  concat_ws(' ',
    coalesce(c.full_name, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')),
    c.first_name, c.last_name, c.phone, c.email, w.name
  ) as search_text
from public.schedule_bookings sb
-- inner join: без занятия строку не восстановить (в браузере такие строки
-- отбрасывались проверкой `if (!entry) return null`).
join public.schedule_entries se on se.id = sb.entry_id
left join public.workouts w on w.id = se.workout_id
left join public.clients c
  on c.user_id = sb.user_id
 and c.studio_id = sb.studio_id
where not exists (
  select 1 from public.bookings_log bl2 where bl2.booking_id = sb.id
);

grant select on public.bookings_log_full to authenticated;

notify pgrst, 'reload schema';
