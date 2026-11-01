# Переезд портала на домен ladyfitpro.ru

Инструкция браузерному агенту (решение владельца 2026-11-01: основной домен
Lady Stretch сменился). Выполнять только по команде владельца, переключение
(Часть B) — вечером, когда в портале мало людей.

| Что                  | Было                                 | Стало                           |
| -------------------- | ------------------------------------ | ------------------------------- |
| Портал               | `https://portal.lady-stretching.ru`  | `https://portal.ladyfitpro.ru`  |
| API Supabase, Studio | `https://api.lady-stretching.ru`     | `https://api.ladyfitpro.ru`     |
| Coolify              | `https://coolify.lady-stretching.ru` | `https://coolify.ladyfitpro.ru` |
| Почта с кодом входа  | `noreply@lady-stretching.ru`         | `noreply@ladyfitpro.ru`         |

Сервер, IP, база, файлы, ключи Supabase, репозиторий — **не меняются**.
DNS и почта нового домена — reg.ru, как у старого.

**Правила**

- Корень `ladyfitpro.ru` (`@`), `www`, MX и прочие существующие записи зоны
  `ladyfitpro.ru` не трогать — там сайт и почта компании. Добавляются
  только записи, перечисленные ниже.
- В зоне `lady-stretching.ru` ничего не удалять: старый портал аналитики
  (`analytics`, `inbox`, `quiz`, `test.analytics`) работает на ней дальше;
  записи `portal`, `api`, `coolify` остаются (старый адрес портала
  переадресует на новый).
- Секреты — только в поля, указанные ниже, и в менеджер паролей владельца.
  В отчёт — только имена переменных.
- Ключи Supabase (anon, service_role, JWT), `SEND_EMAIL_HOOK_SECRET`,
  `ANALYTICS_SECRETS_KEY`, `DATABASE_URL` **не менять** — от домена они не
  зависят, а новый `ANALYTICS_SECRETS_KEY` сделал бы нечитаемыми все ключи
  подключений «Аналитики».
- Перед каждым шагом проверить, не сделан ли он уже. Шаг не получается или
  экран выглядит иначе, чем описано, — остановиться и написать владельцу,
  что видно. Понадобилась покупка (почтовый хостинг для нового домена и
  т. п.) — сначала цена владельцу.

Обозначения: `<IP>` — публичный IP сервера Selectel (тот же, на который
сейчас смотрит `portal.lady-stretching.ru`; проверить на dnschecker.org).

---

## Часть A. Подготовка (портал работает как раньше)

### A1. Бэкап

Coolify → сервис Supabase → db → Backups → «Backup now». Дождаться файла в
бакете S3 `ls-portal-backups`.

### A2. DNS на reg.ru

Зона `ladyfitpro.ru` → три A-записи → `<IP>`: `portal`, `api`, `coolify`
(если какая-то из них уже занята чем-то другим — стоп, написать владельцу).
Проверить на dnschecker.org, что все три отвечают `<IP>` по миру. Дальше —
только после этого.

### A3. Почта `noreply@ladyfitpro.ru`

1. reg.ru → почтовый хостинг. Если `ladyfitpro.ru` уже подключён к
   почтовому хостингу reg.ru — создать в нём ящик `noreply@ladyfitpro.ru`.
   Если нет — посмотреть, можно ли добавить домен в существующий тариф
   (тот, где `noreply@lady-stretching.ru`), или нужен новый тариф; цену —
   владельцу, без покупки.
   **Важно:** если входящая почта `ladyfitpro.ru` живёт не на reg.ru
   (MX смотрит на Яндекс, Mail.ru, Google и т. п.), MX не менять — ящик
   нужен только для отправки по SMTP.
   Пароль ящика — в менеджер паролей.
2. **SPF** — одна TXT-запись на `@` зоны `ladyfitpro.ru`. Если SPF уже
   есть — дописать в неё include reg.ru перед `~all`/`-all`, вторую запись
   не создавать. Если нет — `v=spf1 include:_spf.hosting.reg.ru ~all`
   (точный include — из справки почтового хостинга reg.ru).
3. **DKIM** — в панели почтового хостинга reg.ru получить DKIM-ключ домена
   `ladyfitpro.ru` и, если reg.ru не добавил его сам, добавить TXT
   `<селектор>._domainkey`. Чужие DKIM-записи не трогать.
4. **DMARC** — если нет записи `_dmarc`, добавить TXT `_dmarc`:
   `v=DMARC1; p=none`. Есть — не менять.
5. Проверка: войти в веб-почту reg.ru под `noreply@ladyfitpro.ru`,
   отправить письмо себе на Gmail → «Показать оригинал»: SPF и DKIM —
   `PASS`. Нет — стоп, написать владельцу.

### A4. Где ещё записан старый адрес в базе (только чтение)

Studio (`https://api.lady-stretching.ru`) → SQL Editor → выполнить:

```sql
do $$
declare r record; n bigint;
begin
  for r in
    select table_schema s, table_name t, column_name c
    from information_schema.columns
    where table_schema in ('public','storage')
      and data_type in ('text','character varying','jsonb','json')
  loop
    execute format('select count(*) from %I.%I where %I::text ilike %L',
                   r.s, r.t, r.c, '%lady-stretching.ru%') into n;
    if n > 0 then raise notice '%.%.% — % строк', r.s, r.t, r.c, n; end if;
  end loop;
end $$;
```

Список из вкладки «Messages» (что за таблица и колонка, сколько строк) —
в отчёт. Ничего не править: это решит Claude. Ожидаемо пусто или только
тексты статей / подключения «Аналитики», где упомянут старый портал
аналитики (`analytics.lady-stretching.ru`) — их менять не нужно.

---

## Часть B. Переключение (вечером, ~30–40 минут)

Предупредить владельца о начале. Пока идут шаги B1–B3, вход в портал может
1–3 минуты не работать — это ожидаемо.

### B1. Supabase: новый адрес API

Coolify → сервис Supabase.

1. Домен сервиса Kong (supabase-kong) — **оба через запятую, новый
   первым**: `https://api.ladyfitpro.ru,https://api.lady-stretching.ru`
   (старый нужен, пока портал не пересобран с новым адресом).
2. Environment Variables сервиса — найти **каждое** значение, где есть
   `lady-stretching.ru`, и выписать имя и значение в отчёт (до правки).
   Затем поменять:

   | Переменная                                                                                                  | Новое значение                                                         |
   | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | `GOTRUE_SITE_URL`                                                                                           | `https://portal.ladyfitpro.ru`                                         |
   | `GOTRUE_URI_ALLOW_LIST`                                                                                     | `https://portal.ladyfitpro.ru/**,https://portal.lady-stretching.ru/**` |
   | `GOTRUE_HOOK_SEND_EMAIL_URI`                                                                                | **пока не трогать** (шаг B3)                                           |
   | остальные с `api.lady-stretching.ru` (например `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL`, если заданы явно) | то же с `api.ladyfitpro.ru`                                            |
   | прочие с `lady-stretching.ru` (например `SMTP_ADMIN_EMAIL`)                                                 | то же с `ladyfitpro.ru`                                                |

3. Save → Restart (Redeploy) сервиса. Дождаться: все контейнеры «healthy»,
   сертификат выпущен.
4. Проверка: `https://api.ladyfitpro.ru/auth/v1/health` — JSON с версией
   GoTrue; `https://api.lady-stretching.ru/auth/v1/health` — тоже отвечает;
   Studio открывается по `https://api.ladyfitpro.ru` (логин и пароль —
   прежние). Старый портал `https://portal.lady-stretching.ru` открывается.

### B2. Портал: новый адрес и почта

Coolify → приложение портала (`ls-portal`).

1. Domains — **оба через запятую, новый первым**:
   `https://portal.ladyfitpro.ru,https://portal.lady-stretching.ru`.
2. Переменные (выписать прежние значения в отчёт — без секретов):

   | Переменная          | Тип            | Новое значение                 |
   | ------------------- | -------------- | ------------------------------ |
   | `VITE_SUPABASE_URL` | Build Variable | `https://api.ladyfitpro.ru`    |
   | `ADMIN_APP_URL`     |                | `https://portal.ladyfitpro.ru` |
   | `SMTP_USER`         |                | `noreply@ladyfitpro.ru`        |
   | `SMTP_PASS`         | секрет         | пароль нового ящика (шаг A3)   |
   | `MAIL_FROM`         |                | `noreply@ladyfitpro.ru`        |

   `MAIL_FROM_NAME` = `LadyFitPro` (ребрендинг портала; было `Lady Stretch`).
   `SMTP_HOST`, `SMTP_PORT` — как были. Если заданы
   `VAPID_SUBJECT`, `EMAIL_LOGO_URL`, `ANALYTICS_QUIZ_ORIGINS` или любая
   другая переменная со `lady-stretching.ru` — заменить домен на
   `ladyfitpro.ru` и перечислить в отчёте (`ANALYTICS_QUIZ_ORIGINS` со
   старым `quiz.lady-stretching.ru` — оставить как есть, это старый
   квиз). Остальные переменные не трогать.

3. **Redeploy** (нужна сборка: `VITE_SUPABASE_URL` вшивается при сборке).
   Не запускать, пока идёт «Обработка 1С» («Аналитика» → «Инструменты» →
   «Обработка 1С» — нет активного запуска). Дождаться «healthy».
4. Проверка: `https://portal.ladyfitpro.ru` открывает экран входа с
   действующим сертификатом.

### B3. Хук писем на новый адрес

Coolify → сервис Supabase → переменные **auth**:

```
GOTRUE_HOOK_SEND_EMAIL_URI=https://portal.ladyfitpro.ru/api/auth-email
```

`GOTRUE_HOOK_SEND_EMAIL_SECRETS` и `GOTRUE_HOOK_SEND_EMAIL_ENABLED` не
трогать. Save → перезапустить сервис auth (или весь Supabase).

Проверка: открыть `https://portal.ladyfitpro.ru` в окне инкогнито, войти
почтой владельца. Письмо пришло от `noreply@ladyfitpro.ru`, логотип в шапке
письма виден, код подошёл. Отметить, где письмо: «Входящие» или спам — в
Gmail, Яндексе, Mail.ru. Не пришло за 2 минуты — Coolify → портал → Logs,
строки `[auth-email]` → владельцу и Claude, и **вернуть**
`GOTRUE_HOOK_SEND_EMAIL_URI` на старый адрес до выяснения.

### B4. Старый адрес портала → переадресация на новый

1. Coolify → портал → Domains: оставить только
   `https://portal.ladyfitpro.ru`. Save → Redeploy (сборка не нужна —
   Coolify возьмёт готовый образ). Дождаться «healthy».
2. Coolify → Servers → (сервер) → Proxy → **Dynamic Configurations** →
   добавить файл `old-portal-redirect.yaml`. Сначала открыть там же
   существующий `coolify.yaml` и сверить имена: entryPoints (обычно `http`
   и `https`) и certResolver (обычно `letsencrypt`); если другие — подставить
   их. Содержимое:

   ```yaml
   http:
     routers:
       old-portal-redirect-https:
         rule: Host(`portal.lady-stretching.ru`)
         entryPoints:
           - https
         middlewares:
           - old-portal-redirect
         service: noop@internal
         tls:
           certResolver: letsencrypt
       old-portal-redirect-http:
         rule: Host(`portal.lady-stretching.ru`)
         entryPoints:
           - http
         middlewares:
           - old-portal-redirect
         service: noop@internal
     middlewares:
       old-portal-redirect:
         redirectRegex:
           regex: '^https?://portal\.lady-stretching\.ru/(.*)'
           replacement: "https://portal.ladyfitpro.ru/${1}"
           permanent: true
   ```

   Save (прокси подхватывает файл сам; если нет — Restart Proxy).

3. Проверка: `https://portal.lady-stretching.ru/kb` в браузере переходит на
   `https://portal.ladyfitpro.ru/kb` без предупреждения о сертификате;
   `http://portal.lady-stretching.ru` — тоже на новый адрес.

Переадресация остаётся, пока владелец не скажет убрать (ссылки на статьи
базы знаний, формы отзывов, квиз, закладки сотрудников).

### B5. Coolify на новый адрес и GitHub App

Без этого шага **перестанет работать автодеплой** после пуша в `main`.

1. Coolify → Settings → Instance Settings → Domain
   `https://coolify.ladyfitpro.ru` → Save. Дождаться сертификата, открыть
   Coolify по новому адресу и войти.
2. GitHub → Settings → Developer settings → GitHub Apps (у владельца
   приложения — пользователь или организация `borinsobaka-lab`) →
   приложение Coolify, подключённое к `ls-portal` → General: во всех полях
   с `coolify.lady-stretching.ru` — **Homepage URL, Callback URL, Setup
   URL, Webhook URL** — заменить домен на `coolify.ladyfitpro.ru`, путь не
   менять. Save changes. Webhook secret не трогать.
3. Проверка: там же → Advanced → Recent Deliveries → последняя доставка →
   Redeliver → ответ `200`. Coolify → Sources → GitHub App — статус без
   ошибок.
4. Coolify → Settings → Notifications / Email: если где-то отправителем
   или адресом указан `lady-stretching.ru` — заменить на `ladyfitpro.ru`,
   отправить тестовое уведомление.

### B6. Смоук-тест под суперадминистратором на `portal.ladyfitpro.ru`

- база знаний: открыть статью с картинкой и видео, загрузить картинку в
  черновик тестовой статьи, найти статью поиском, «Скопировать ссылку» —
  в ссылке `portal.ladyfitpro.ru`;
- Академия: открыть курс, урок с картинкой;
- «Пользователи и роли» — список открывается;
- «Аналитика» → «Администрирование» → «Фоновые задачи»: предупреждений о
  переменных нет, задачи отрабатывают как раньше;
- «Аналитика» → «Администрирование» → «API для GPT»: адрес схемы —
  `https://portal.ladyfitpro.ru/api/analytics/openapi.json`, по нему
  открывается JSON, `servers.url` в нём — новый адрес.

---

## Часть C. Внешние сервисы со старым адресом портала

Делать сразу после части B. Каждый пункт — проверить, используется ли он
сейчас; не используется — так и написать в отчёте.

### C1. Диалоги VK (Callback API)

«Аналитика» → «Диалоги VK» → «Подключения» (по новому адресу портала).
Для **каждой** подключённой группы:

1. VK → группа → «Управление» → «Работа с API» → «Callback API» → сервер
   нового портала (адрес вида
   `https://portal.lady-stretching.ru/api/analytics/vk-callback/<id>`;
   сервер старого портала аналитики `inbox.lady-stretching.ru` **не
   трогать**).
2. Адрес заменить на `https://portal.ladyfitpro.ru/api/analytics/vk-callback/<тот же id>`,
   секретный ключ не менять → «Сохранить» → «Подтвердить» (портал сам
   ответит строкой подтверждения). Статус — подтверждён.
3. Типы событий не менять.

Проверка: написать в группу тестовое сообщение — появилось в «Все
диалоги» нового портала. Переадресация из B4 VK-событиям не помогает
(VK не повторяет POST по 301), поэтому этот шаг обязателен.

### C2. Google Cloud (сбор лид-форм)

Если в «Аналитика» → «VK Ads» → «Сбор лид-форм» Google Drive подключён
или загружен OAuth-клиент:

1. Google Cloud → APIs & Services → OAuth consent screen → Authorized
   domains — добавить `ladyfitpro.ru` (`lady-stretching.ru` не удалять).
2. Credentials → OAuth-клиент «Веб-приложение» портала → Authorized
   redirect URIs — **добавить**
   `https://portal.ladyfitpro.ru/analytics/vk/lead-forms` (старый пока
   оставить). Если заполнены Authorized JavaScript origins —
   добавить `https://portal.ladyfitpro.ru`. Save.
3. Переподключать Google Drive не нужно: выданный доступ от адреса не
   зависит. Проверка — страница «Сбор лид-форм» показывает подключение
   без ошибок.

### C3. Custom GPT (API для GPT)

Если ключи в «API для GPT» созданы и где-то есть GPT с действиями
портала: ChatGPT → GPT → Configure → Actions → «Import from URL» →
`https://portal.ladyfitpro.ru/api/analytics/openapi.json`; ключ
(Authentication) оставить прежний; если указан Privacy policy со старым
доменом — заменить домен. Update, затем тестовый вопрос к GPT — ответ с
данными.

### C4. Квиз-лендинги

«Аналитика» → «Квиз» → «Квиз-лендинги»: если городов нет — пропустить.
Если есть и реклама ведёт на `https://portal.lady-stretching.ru/quiz/…` —
переадресация (B4) откроет лендинг, но ссылки в рекламе (VK Ads, Авито,
посты) лучше заменить на `https://portal.ladyfitpro.ru/quiz/<город>` —
список, где менять, владельцу (сами объявления без его команды не
трогать). Отправить тестовую заявку с нового адреса — она появилась в
«Заявках квиза».

### C5. Отзывы, FitBase, Telegram

- Ссылки на отзывы сотрудников (`/analytics-feedback/<токен>`) у партнёров
  работают через переадресацию; новые копии со страницы — уже с новым
  адресом. Ничего не делать.
- Помощник входа FitBase: адрес портала приходит в одноразовом коде с
  портала — ничего не делать. В «Сессии и сборщике оснований» статус
  сессии — как до переезда.
- Telegram-шлюз (Cloudflare Worker) от адреса портала не зависит — ничего
  не делать; на «Контроле бюджетов» — «Отправить тестовое сообщение»,
  если бот подключён.

### C6. Мониторинг

UptimeRobot: мониторы поменять на `https://portal.ladyfitpro.ru` и
`https://api.ladyfitpro.ru/auth/v1/health`. Проверить, что оба «Up».

### C7. Сотрудникам

Текст владельцу для рассылки (сам агент не рассылает): «Портал переехал на
https://portal.ladyfitpro.ru. Старый адрес переадресует, но войти нужно
заново (код придёт с noreply@ladyfitpro.ru — проверьте спам). Если
портал установлен как приложение на телефон или компьютер — удалите
значок и установите заново с нового адреса».

---

## Часть D. Через 1–2 дня (по команде владельца)

1. Supabase → Kong: убрать `https://api.lady-stretching.ru`, оставить
   `https://api.ladyfitpro.ru`; `GOTRUE_URI_ALLOW_LIST` →
   `https://portal.ladyfitpro.ru/**`. Restart. Повторить вход в портал
   (B3, проверка).
2. Google Cloud: старый redirect URI можно удалить.
3. Ящик `noreply@lady-stretching.ru` — не удалять, пока владелец не
   скажет (нужен, если придётся откатиться).
4. DNS-записи `api` и `coolify` в зоне `lady-stretching.ru` — удалить
   только по команде владельца; `portal` — оставить, пока нужна
   переадресация.

## Откат

Если после B2–B3 вход не работает и быстро не чинится: вернуть
`GOTRUE_HOOK_SEND_EMAIL_URI`, `GOTRUE_SITE_URL` и переменные портала из
отчёта на старые значения, Domains портала — старый адрес, удалить
`old-portal-redirect.yaml`, Redeploy портала и Supabase. Старые записи DNS,
ящик и домены на месте — портал работает по-старому.

## Отчёт владельцу

- DNS: записи `portal`, `api`, `coolify` в `ladyfitpro.ru` → `<IP>`;
  сертификаты всех трёх адресов (даты).
- Почта: ящик создан (на каком тарифе), SPF/DKIM/DMARC, результат проверки
  Gmail, куда пришло письмо с кодом в Gmail / Яндексе / Mail.ru.
- Что найдено в A4 (таблицы и колонки).
- Какие переменные Supabase и портала изменены: имя, было → стало (без
  секретов).
- Переадресация старого адреса — работает.
- Coolify на новом адресе, GitHub App — URL обновлены, повторная доставка
  вебхука — 200.
- По C1–C6: что сделано, что не используется.
- Смоук-тест B6 — по пунктам.
- Подтверждение, что в зоне `ladyfitpro.ru` не тронуты `@`, `www`, MX и
  прочие прежние записи, а в `lady-stretching.ru` ничего не удалено.
