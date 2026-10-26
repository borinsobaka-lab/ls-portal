# Сборка и запуск админки для Coolify (Nitro preset: node-server, порт 3000).
# Контекст сборки — КОРЕНЬ монорепозитория (Coolify: Base Directory «/»,
# Dockerfile Location «/apps/admin/Dockerfile»): кроме apps/admin нужен общий
# db/ — мигратор и миграции.
# Версия Bun закреплена (2026-10-16): плавающий тег «1» мог подтянуть новую
# версию в любой деплой — например, в день запуска. Обновлять осознанно.
FROM oven/bun:1.4.3 AS build
WORKDIR /app

COPY apps/admin/package.json apps/admin/bun.lock apps/admin/bunfig.toml ./
RUN bun install --frozen-lockfile

COPY apps/admin/ ./

# VITE_* переменные вшиваются в клиентский бандл на этапе сборки —
# в Coolify отметьте их как "Build Variable".
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

RUN bun run build

FROM oven/bun:1.4.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

COPY --from=build /app/.output ./.output
# Мигратор схемы БД и его файлы: при старте сначала миграции (без
# DATABASE_URL — пропускаются), упали — сервер не запускается.
COPY db/migrate.ts ./db/migrate.ts
COPY db/migrations ./db/migrations

EXPOSE 3000
# Health check: Coolify ждёт «healthy» нового контейнера и только потом
# убирает старый — упала миграция, контейнер не стартовал, работает прежний.
# Проверка из панели Coolify требует curl/wget, которых в slim-образе нет,
# поэтому она здесь, на bun (Coolify берёт HEALTHCHECK из Dockerfile).
# start-period — запас на выполнение миграций до старта сервера.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/auth').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# DATABASE_URL (прямой доступ к Postgres в обход RLS) нужен только мигратору —
# веб-серверу его не передаём.
CMD ["sh", "-c", "bun db/migrate.ts && exec env -u DATABASE_URL bun .output/server/index.mjs"]
