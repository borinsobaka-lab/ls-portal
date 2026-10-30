# Деплой портала Lady Stretch на Selectel

Инструкция браузерному агенту — **Задача 16, Часть B** (в репозитории
Base40, AGENT_TASKS.md) с решениями владельца от 2026-10-26. Зачем и как
устроено — RU_SELECTEL.md. Выполнять только по команде владельца.

**Правила**

- На Hetzner (Coolify, Supabase, DNS `base40.fit` / `lady-stretch.one`,
  Resend) ничего не трогать; ключи и пароли оттуда не копировать — у
  копии всё новое.
- Секреты — только в поля, указанные ниже, и в менеджер паролей
  владельца. В отчёт — только имена переменных.
- ИИ не включать: переменные `AI_*` не задавать.
- Шаг не получается или экран выглядит иначе — остановиться и написать
  владельцу, что видно.
- Перед каждым шагом проверить, не сделан ли он уже.

## Что где

| Что                   | Значение                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Домен                 | `lady-stretching.ru`, DNS на reg.ru (`ns1.reg.ru`, `ns2.reg.ru`)                                             |
| Портал                | `https://portal.lady-stretching.ru`                                                                          |
| API Supabase и Studio | `https://api.lady-stretching.ru`                                                                             |
| Coolify               | `https://coolify.lady-stretching.ru`                                                                         |
| Сервер                | Selectel, облачный Standard 4 vCPU / 8 ГБ / 80 ГБ «Универсальный SSD v2», Москва, Ubuntu 24.04, публичный IP |
| Бэкапы                | S3 Selectel, холодный класс, Санкт-Петербург (`ru-1`), бакет `ls-portal-backups`                             |
| Почта с кодом         | `noreply@lady-stretching.ru`, почтовый хостинг reg.ru, SMTP `mail.hosting.reg.ru:465` (SSL)                  |
| Репозиторий           | `github.com/borinsobaka-lab/ls-portal`, ветка `main`                                                         |

**Заняты, не трогать:** записи `@`, `www`, `analytics`, `inbox`, `quiz`,
`test.analytics` и **MX** (`emx.mail.ru` — входящая почта домена остаётся
на Mail.ru).

## Шаги

### 1. Проект и сервер Selectel

1. Проект создал основатель Lady Stretch, 2FA включена, владелец —
   участник проекта.
2. Облачный сервер `ls-portal`: Standard, 4 vCPU / 8 ГБ, загрузочный диск
   80 ГБ «Универсальный SSD v2», регион Москва, Ubuntu 24.04, публичный
   IP, SSH-ключ владельца (нет ключа — root-пароль в менеджер паролей).
   Записать IP — дальше `<IP>`.
3. Файрвол (группа безопасности): входящие TCP 80, 443 и ICMP — отовсюду;
   TCP 22 — отовсюду (сузить — по согласованию с владельцем); **TCP 8000
   открыть только на время шага 4**, 5432 — закрыт.

### 2. DNS на reg.ru

В зоне `lady-stretching.ru` добавить три A-записи → `<IP>`:
`portal`, `api`, `coolify`. Остальные записи не менять. Проверить на
dnschecker.org, что все три отвечают `<IP>`.

### 3. Docker Hub

На сервере: `curl -fsSI https://registry-1.docker.io/v2/` (ответ 401 —
доступен). После установки Coolify (шаг 4) — `docker pull oven/bun:1.4.3`.
Если не скачивается: своего зеркала у Selectel нет, поэтому в
`/etc/docker/daemon.json`:

```json
{ "registry-mirrors": ["https://mirror.gcr.io", "https://dockerhub.timeweb.cloud"] }
```

`systemctl restart docker`, повторить `docker pull`. В отчёт — напрямую
или через какое зеркало.

### 4. Coolify

1. `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`.
2. Сразу открыть `http://<IP>:8000` → Register (почта владельца, пароль —
   в менеджер паролей).
3. Settings → Instance Settings → Domain `https://coolify.lady-stretching.ru`,
   дождаться сертификата и открыть по нему.
4. Settings → Concurrent Builds = **1** (8 ГБ памяти: сборки по одной).
5. Закрыть TCP 8000 в файрволе и проверить, что `http://<IP>:8000`
   снаружи не открывается.

### 5. S3 для бэкапов

1. Объектное хранилище → бакет `ls-portal-backups`: **приватный**, класс
   **холодный**, регион Санкт-Петербург (`ru-1`).
2. Сервисный пользователь `ls-portal-backup` с ролью **`s3.bucket.user`**;
   политика бакета — доступ только этому пользователю, только к
   `ls-portal-backups`. S3-ключи (Access Key, Secret Key) — в менеджер
   паролей.
3. Coolify → Storages → + Add (S3): Endpoint
   `https://s3.ru-1.storage.selcloud.ru`, Region `ru-1`, Bucket
   `ls-portal-backups`, ключи из п. 2 (адресация path-style). Validate.

### 6. Supabase

Coolify → + New → Service → **Supabase**.

1. Домен сервиса Kong — `https://api.lady-stretching.ru` (Studio открывается
   через него; логин и пароль — `SERVICE_USER_ADMIN` /
   `SERVICE_PASSWORD_ADMIN` или `DASHBOARD_*` в переменных сервиса — в
   менеджер паролей).
2. Включить **Connect To Predefined Network** у сервиса: портал ходит в
   Postgres по внутренней сети Docker, порт 5432 наружу не открывается.
3. Переменные сервиса **auth** (GoTrue) — задать или проверить:

   | Переменная                      | Значение                                                                        |
   | ------------------------------- | ------------------------------------------------------------------------------- |
   | `GOTRUE_SITE_URL`               | `https://portal.lady-stretching.ru`                                             |
   | `GOTRUE_URI_ALLOW_LIST`         | `https://portal.lady-stretching.ru/**`                                          |
   | `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `true`                                                                          |
   | `GOTRUE_DISABLE_SIGNUP`         | `true` (сотрудников заводит портал; клиентского приложения на первом этапе нет) |
   | `GOTRUE_MAILER_OTP_LENGTH`      | `6`                                                                             |
   | `GOTRUE_MAILER_OTP_EXP`         | `3600`                                                                          |
   | `GOTRUE_RATE_LIMIT_EMAIL_SENT`  | `300` (писем в час; лимит ящика reg.ru — 3000 в сутки)                          |
   | `GOTRUE_HOOK_SEND_EMAIL_*`      | **не задавать до шага 9**                                                       |

4. Переменная сервиса **storage**: `FILE_SIZE_LIMIT=209715200` (200 МБ —
   общий лимит файла Storage; по умолчанию 50 МБ, и бакет базы знаний
   `kb-media` с лимитом 200 МБ больше не принял бы).
5. Deploy, дождаться: все контейнеры «healthy».
6. В менеджер паролей (это **новые** ключи копии): anon-ключ
   (`SERVICE_SUPABASEANON_KEY`), service_role-ключ
   (`SERVICE_SUPABASESERVICE_KEY`), секрет JWT (`SERVICE_PASSWORD_JWT`),
   пароль Postgres (`SERVICE_PASSWORD_POSTGRES`). Записать имя контейнера
   базы `supabase-db-…` (Coolify → сервис → db) — дальше `<db-host>`.

### 7. Почта на reg.ru

1. Почтовый хостинг клиента → создать ящик `noreply@lady-stretching.ru`,
   пароль — в менеджер паролей.
2. **SPF** — одна TXT-запись на `@`, с обоими отправителями. Если SPF уже
   есть (с Mail.ru) — дописать в неё reg.ru, вторую не создавать:
   `v=spf1 include:_spf.mail.ru include:_spf.hosting.reg.ru ~all`
   (точный include reg.ru — из справки почтового хостинга).
3. **DKIM** — в панели почтового хостинга reg.ru получить DKIM-ключ домена
   и вручную добавить TXT `<селектор>._domainkey` в DNS reg.ru. DKIM
   Mail.ru (если есть) не трогать.
4. **DMARC** — если нет записи `_dmarc`, добавить TXT `_dmarc`:
   `v=DMARC1; p=none`.
5. MX не менять.

### 8. Портал

1. Coolify → Sources → + Add → GitHub App, доступ **только к
   `borinsobaka-lab/ls-portal`** (`club-40-hub` не выбирать).
2. - New → Private Repository (GitHub App) → `ls-portal`, ветка `main`.
     Build Pack — Dockerfile, Base Directory `/`, Dockerfile
     `/apps/admin/Dockerfile`, порт `3000`, домен
     `https://portal.lady-stretching.ru`, Watch Paths `apps/admin/**` и
     `db/**`.
3. Переменные (значения — из шагов 6 и 7; секрет хука сгенерировать:
   `echo "v1,whsec_$(openssl rand -base64 32)"`, в менеджер паролей):

   | Переменная                      | Тип            | Значение                                                        |
   | ------------------------------- | -------------- | --------------------------------------------------------------- |
   | `VITE_SUPABASE_URL`             | Build Variable | `https://api.lady-stretching.ru`                                |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Build Variable | anon-ключ                                                       |
   | `APP_SUPABASE_SERVICE_KEY`      | секрет         | service_role-ключ                                               |
   | `DATABASE_URL`                  | секрет         | `postgres://postgres:<пароль Postgres>@<db-host>:5432/postgres` |
   | `ADMIN_APP_URL`                 |                | `https://portal.lady-stretching.ru`                             |
   | `SEND_EMAIL_HOOK_SECRET`        | секрет         | `v1,whsec_…`                                                    |
   | `SMTP_HOST`                     |                | `mail.hosting.reg.ru`                                           |
   | `SMTP_PORT`                     |                | `465` (если не соединяется — `587`)                             |
   | `SMTP_USER`                     |                | `noreply@lady-stretching.ru`                                    |
   | `SMTP_PASS`                     | секрет         | пароль ящика                                                    |
   | `MAIL_FROM`                     |                | `noreply@lady-stretching.ru`                                    |
   | `MAIL_FROM_NAME`                |                | `Lady Stretch`                                                  |

   Больше ничего не задавать (полный список с пояснениями —
   `apps/admin/.env.example`).

4. Deploy. При первом старте на пустой базе мигратор сам собирает схему
   (в логе: «пустая база — собираю старую схему», три прохода, затем
   миграции, «выполнено: N»), потом стартует сервер. Дождаться «healthy».
   Упало — лог деплоя целиком Claude.

### 9. Хук писем

Сервис **auth** Supabase → переменные:

```
GOTRUE_HOOK_SEND_EMAIL_ENABLED=true
GOTRUE_HOOK_SEND_EMAIL_URI=https://portal.lady-stretching.ru/api/auth-email
GOTRUE_HOOK_SEND_EMAIL_SECRETS=<тот же v1,whsec_… из шага 8>
```

Перезапустить сервис auth.

### 10. Бэкапы

1. **База**: Coolify → сервис Supabase → db → Backups: хранилище S3 из
   шага 5, ежедневно `0 3 * * *` (часовой пояс сервера — проверить, чтобы
   было 03:00 по Москве), хранить 30. Сделать первый бэкап вручную и
   убедиться, что файл появился в бакете.
2. **Файлы** (картинки и видео статей и курсов — в бэкап базы не входят):
   на сервере `apt install -y rclone`; в `/root/.config/rclone/rclone.conf`:

   ```
   [selectel]
   type = s3
   provider = Other
   endpoint = https://s3.ru-1.storage.selcloud.ru
   region = ru-1
   force_path_style = true
   access_key_id = <S3 Access Key>
   secret_access_key = <S3 Secret Key>
   ```

   Скрипт: `mkdir -p /opt/ls-portal && curl -fsSL
https://raw.githubusercontent.com/borinsobaka-lab/ls-portal/main/deploy/backup-storage.sh
-o /opt/ls-portal/backup-storage.sh && chmod +x /opt/ls-portal/backup-storage.sh`.
   Папка файлов — `/data/coolify/services/<uuid сервиса Supabase>/volumes/storage`.
   Запустить вручную один раз, проверить файл в бакете (`storage/`), затем
   `crontab -e`:

   ```
   15 3 * * * /opt/ls-portal/backup-storage.sh /data/coolify/services/<uuid>/volumes/storage >> /var/log/ls-storage-backup.log 2>&1
   ```

### 11. Первый суперадминистратор

Studio (`https://api.lady-stretching.ru`) → SQL Editor → текст
`deploy/first-superadmin.sql` из репозитория. В блоке «Поменять» —
почта, имя и фамилия владельца, название клуба (`Lady Stretch`). Run:
в конце строка с почтой и `portal_admin = true`.

Войти в `https://portal.lady-stretching.ru` по коду из письма. Отметить,
где письмо: «Входящие» или спам — в Яндексе, Mail.ru и Gmail.

### 12. Мониторинг

UptimeRobot (бесплатно): `https://portal.lady-stretching.ru` и
`https://api.lady-stretching.ru/auth/v1/health` раз в 5 минут, уведомления —
на почту владельца.

### 13. Смоук-тест

Под суперадминистратором:

- база знаний: создать базу, папку, статью с картинкой и видео до 200 МБ,
  опубликовать, найти поиском;
- Академия: курс с уроком и тестом, назначить себе, пройти;
- «Пользователи и роли»: тестовый сотрудник с ролью только на базу знаний
  и Академию; войти им в другом браузере — видит только их;
- Kate — «временно недоступен» (так и должно быть).

### 14. Нагрузочный прогон (когда скажет владелец)

Перед выходом всех сотрудников, вечером. 500 виртуальных сотрудников
читают статьи, ищут и проходят тест — скрипт `deploy/load/k6.js`.

1. Studio → SQL Editor → `deploy/load/seed.sql` (500 тестовых
   сотрудников `@loadtest.invalid`, база и курс «Нагрузочный тест»): в
   конце — `500`.
2. На сервере, в папке с клоном репозитория (`git clone
https://github.com/borinsobaka-lab/ls-portal`):

   ```
   docker run --rm -i --network host -v "$PWD/deploy/load:/load" grafana/k6:1.3.0 run \
     -e SUPABASE_URL=https://api.lady-stretching.ru \
     -e ANON_KEY=<anon-ключ> -e JWT_SECRET=<SERVICE_PASSWORD_JWT> /load/k6.js
   ```

   (Docker Hub недоступен — образ `mirror.gcr.io/grafana/k6:1.3.0`.) Около
   16 минут: разгон до 100, до 500, 10 минут на 500.

3. Во время прогона в соседнем окне раз в минуту: `docker stats
--no-stream`, `free -h`, `uptime`.
4. Итог k6 (таблица THRESHOLDS и TOTAL RESULTS) и цифры из п. 3 —
   владельцу и Claude.
5. Studio → SQL Editor → `deploy/load/cleanup.sql`: в конце — `0`.

### 15. Аналитика

Раздел «Аналитика» работает параллельно со старым порталом аналитики и с ним
не связан (ANALYTICS.md): старый портал, его домены (`analytics`, `inbox`,
`quiz`) и сервер не меняются, подключения к 1С, FitBase, amoCRM, VK, Авито
вводятся в новом портале заново.

1. Coolify → портал → переменная `ANALYTICS_SECRETS_KEY` (секрет:
   `openssl rand -base64 32`, в менеджер паролей; не менять — иначе
   сохранённые ключи подключений не расшифровать). Redeploy.
   «Аналитика» → «Фоновые задачи» — предупреждения о переменной нет.
2. Задачи с внешним действием (Google-таблицы, Telegram, публикации VK) в
   новом портале выключены, пока их не включат на «Фоновых задачах»: старый
   портал делает то же самое.

3. API для Custom GPT: схема — `https://portal.<домен>/api/analytics/openapi.json`
   (адрес сервера в ней — `ADMIN_APP_URL`), ключ — «Аналитика» →
   «API для GPT» → «Новый ключ» (показывается один раз). Маршруты
   `/api/analytics/*` публичные: без ключа отвечают `unauthorized`.
4. «Топ-10 городов» (с версии 1.19): после выкатки один раз запустить
   «Обработку 1С» и загрузить данные в отчёты — снимок, сделанный раньше, не
   содержит «возвращённых», страница об этом предупреждает.
5. «Отзывы» (с версии 1.20): форма отзыва партнёра о сотруднике —
   публичная страница `https://portal.<домен>/analytics-feedback/<токен>`
   (без входа, `noindex`; приостановленная или неизвестная ссылка —
   «Ссылка не найдена»). Ничего настраивать не нужно: ссылки создаются в
   «Аналитика» → «Отзывы» → «Ссылки на отзывы сотрудников». Историю
   оценок клиентов загружают выгрузками 1С на «Загрузке выгрузки».
6. VK Ads (с версии 1.21): кабинеты — «Аналитика» → «Инструменты» →
   «Обслуживание VK Ads» → импорт файла API_VK_ADS.xlsx (или по одному в
   «Рекламных кабинетах»). Нужен `ANALYTICS_SECRETS_KEY` (ключи кабинетов
   шифруются им) и выход сервера на `ads.vk.com`. Сбор — задача «VK Ads» на
   «Фоновых задачах», раз в час.

`ANALYTICS_JOBS=off` — не выполнять фоновые задачи «Аналитики» и обработку
1С на этом контейнере (их можно вынести во второй контейнер того же образа).

«Обработка 1С» считает всю историю отдельным процессом внутри контейнера
портала (`bun /app/onec/worker.ts`, его поднимает сервер, когда нажали
«1. Обработать»): ~4–5 минут и до ~1,4 ГБ памяти, затем процесс
завершается. В это время не запускать деплой — сборка ещё 2–3 ГБ;
прерванная обработка через 3 минуты помечается ошибкой, её запускают снова.
Снимок отчётов 1С в базе — до трёх копий по ~250 МБ (текущая, предыдущая,
новая); выгрузки 1С — бакет `an-onec` (в архиве файлов Storage вместе с
остальными бакетами).

## Отчёт владельцу

- Сервер: конфигурация, линейка, регион, IP, цена в месяц.
- Адреса: Coolify, портал, API; даты сертификатов.
- Docker Hub: напрямую или через зеркало (какое).
- Бэкапы: где лежат первые (база и файлы), расписание, хранение.
- Почта: ящик создан, SPF/DKIM/DMARC, в какие ящики письмо дошло, где
  спам.
- Смоук-тест — по пунктам шага 13.
- Где сохранены пароли и ключи, 2FA по каждому сервису.
- Подтверждение, что на Hetzner и в существующих записях reg.ru (сайт,
  MX, занятые поддомены) ничего не менялось.
