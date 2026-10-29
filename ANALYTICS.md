# Аналитика — перенос портала аналитики Lady Stretch

Раздел рейки «Аналитика» — весь портал аналитики Lady Stretch
(analytics.lady-stretching.ru) и их отдельные программы (обработка 1С для
Windows, очистка Excel, сборщики, диалоги VK) в нашем портале. План, что
изучено и этапы — **ANALYTICS_PLAN.md**; здесь — что уже сделано и как
устроено.

## Решения владельца (2026-10-29)

1. Старый портал продолжает работать: оба портала работают одновременно
   на одних данных (вдруг что-то перенесено неправильно).
2. Их ошибки не исправляем — переносим как есть.
3. Переносим всё из файлов компании; «Очистка Excel» — отдельный
   инструмент на портале.
4. Оформление — нашего портала (плашки, поля, таблицы).
5. Доступ — из «Пользователей и ролей»; суперадминистратор видит всё.
6. Ничего не видоизменяем: те же разделы, отчёты, правила.
7. Разработчик аналитики продолжает работать в репозитории после переноса.
8. В нашей базе аналитических данных нет: это отдельный подпродукт,
   переносим его целиком.

Прежняя «Аналитика сети» (2026-10-26, по контексту, без их кода) удалена:
`db/migrations/2026-10-29_analytics_reset.sql` (таблицы, функции, права
`analytics.*` и роли «Аналитика сети», «Партнёр — аналитика», «Владелец
клуба — аналитика»).

## Статус

| Этап | Что | Статус |
| --- | --- | --- |
| 0 | Фундамент: права и роли, каркас раздела, ключи интеграций, фоновые задачи, приём синхронизации, агент на старом сервере, «Синхронизация», перенос людей | **сделано 2026-10-29** |
| 1 | 1С: отчёты, главная, партнёры, посещаемость, журнал, API для GPT | дальше |
| 2–8 | 1С-инструменты и «Очистка Excel», отзывы, VK Ads, amoCRM / Авито / квиз, FitBase, диалоги VK, контент | по плану |

Пока модуль не перенесён, раздел видит только тот, кому выданы права
«Аналитики» (по умолчанию — суперадминистратор).

## Как работают два портала

- **Режим модуля** («Аналитика» → «Синхронизация со старым порталом»):
  «Зеркало» (по умолчанию: данные приходят со старого портала, здесь только
  показываются), «Проверка» (наш сборщик по кнопке, сверка с зеркалом),
  «Основной» (свои сборщики, правки — здесь; решение владельца). Таблица
  `an_modules`.
- **Агент синхронизации** — `deploy/analytics-replica/` (README.md там же):
  Python на их сервере, раз в 2 минуты, базы только на чтение; изменения —
  `POST /api/analytics/replica` (gzip, подпись HMAC `ANALYTICS_REPLICA_SECRET`),
  приём — `lib/analytics/server/replica.server.ts`, запись — RPC
  `an_replica_apply` (service_role: upsert по ключу из `an_replica_targets`,
  пишутся только присланные колонки, удаление ключей). Журнал приёма и
  отметки «агент на связи» — `an_replica_log` (30 дней).
- **Ключи интеграций** (VK Ads, amoCRM, Авито, FitBase, сообщества VK,
  Telegram, Google) — `an_secrets`, AES-256-GCM ключом
  `ANALYTICS_SECRETS_KEY`, только сервер. От агента ключи приходят
  зашифрованными открытым ключом портала (`ANALYTICS_REPLICA_PRIVATE_KEY`,
  RSA-OAEP-SHA256) — `lib/analytics/server/secrets.server.ts`.
- **Фоновые задачи** — `lib/analytics/server/jobs.server.ts`: цикл сервера
  портала раз в минуту, одна задача — один процесс (аренда в базе
  `an_job_claim` / `an_job_finish`, журнал `an_job_runs` 30 дней);
  `ANALYTICS_JOBS=off` (или `PUSH_WORKER=off`) — не выполнять на этом
  сервере. Задачи модулей включаются только в режиме «Основной».

## Доступ

Права блока «Аналитика» в каталоге (`access_permissions`) — по одному на
каждый их «дашборд» и их типы людей; что открыто — RPC `an_me`, их
алгоритм `allowed_dashboards`:

| Их право / тип | Наше право |
| --- | --- |
| `role = 'admin'` | `an.admin` «Администратор аналитики» (и суперадминистратор) — все отчёты |
| `revenue_city_dashboard.html` … `zero_nomenclature_dashboard.html` | `an.onec.revenue`, `an.onec.sales`, `an.onec.classes`, `an.onec.trials`, `an.onec.zero` |
| `partner_city_dashboard.html` | `an.onec.mycity` |
| `fitbase-*.html` | `an.fb.revenue`, `an.fb.marketing`, `an.fb.sales`, `an.fb.attendance`, `an.fb.trials`; `an.fb.mycity` — студии FitBase партнёра |
| `marketing_lady_stretch` / `_jump` | `an.mkt.ls` / `an.mkt.lj` |
| `target_register`, `avito_register`, `reviews` | `an.vk.register`, `an.avito.register`, `an.reviews` |
| партнёр (есть города) | `an.partner`: «Мой город» + из выданного маркетинг, отзывы, FitBase; данные — только его города (`an_partner_cities`; с правом и без городов — ничего) |
| таргетолог | `an.targetologist`: реестр таргета и маркетинг всегда, по парам «бренд + город», где записано его ФИО (перенесённому — ФИО со старого портала) |
| лид-менеджер | `an.inbox` |

Стартовые роли: «Администратор аналитики», «Партнёр — аналитика»,
«Таргетолог», «Лид-менеджер», «Сотрудник — аналитика» (6 отчётов 1С).

## Люди старого портала

Зеркало ядра (`portal.sqlite3`, как у них, время — unix-секунды):
`an_legacy_users` (без паролей), `an_legacy_dashboard_access`,
`an_legacy_partner_cities`, `an_legacy_partner_profiles`,
`an_legacy_partner_city_settings`, `an_legacy_fitbase_connections`,
`an_legacy_sessions` (без токенов), `an_legacy_activity`, `an_legacy_audit`.

«Синхронизация» → «Пользователи со старого портала» (RPC
`an_legacy_people`): суперадминистратор переносит людей один раз
(`lib/analytics/legacy.functions.ts`, логика — `lib/analytics/legacy-people.ts`
+ тест): учётная запись (логин-почта; есть — к ней; нет почты — вписать),
тип («Партнёр» / УК), должность (по названию), роль — стартовая, если набор
прав совпал, иначе личные права с тем же набором; `an_legacy_link` переносит
города, карточку и условия партнёра и связывает запись. Дальше доступ в
двух порталах ведётся независимо. Студии FitBase партнёров и сообщества
лид-менеджеров переносятся с модулями FitBase и «Диалоги VK».

## Код

- Схема: `db/migrations/2026-10-29_analytics_reset.sql`,
  `2026-10-29_z_analytics_core.sql` (права, роли, `an_me`, партнёры,
  зеркало ядра, режимы, ключи, задачи, приём, люди). Тесты —
  `db/analytics.test.ts`.
- Админка: `lib/analytics/` (`access.ts` — права и `anCan`, `data.ts` —
  запросы, ключ `["analytics", …]`, `labels.ts`, `jobs.ts`,
  `legacy-people.ts`, `admin.functions.ts`, `legacy.functions.ts`,
  `server/` — секреты, приём, задачи), `components/analytics/`,
  `routes/_authenticated/analytics/` (главная `/analytics`,
  «Синхронизация» `/analytics/admin/sync`), приём —
  `routes/api/analytics/replica.ts`. Меню — `ANALYTICS_GROUPS` в
  `lib/nav-sections.ts` (пункт — `need`: `home` / `admin` / `inbox` / отчёт).
- Агент: `deploy/analytics-replica/` (`agent.py`, `install.py`, батники).

## Переменные (Coolify, DEPLOY.md)

`ANALYTICS_REPLICA_SECRET` (от 32 символов — подпись пачек агента),
`ANALYTICS_SECRETS_KEY` (ключ шифрования ключей интеграций),
`ANALYTICS_REPLICA_PRIVATE_KEY` (закрытый RSA-ключ: агент шифрует ключи
интеграций открытым), `ANALYTICS_JOBS=off` — не выполнять задачи на этом
сервере.
