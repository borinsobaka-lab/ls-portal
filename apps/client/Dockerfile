# Сборка и запуск клиентского приложения для Coolify (Nitro node-server, порт 3000).
# Контекст сборки — КОРЕНЬ монорепозитория (Coolify: Base Directory «/»,
# Dockerfile Location «/apps/client/Dockerfile») — так же, как у админки.
# Версия Bun закреплена (2026-10-16): плавающий тег «1» мог подтянуть новую
# версию в любой деплой — например, в день запуска. Обновлять осознанно.
FROM oven/bun:1.4.3 AS build
WORKDIR /app

COPY apps/client/package.json apps/client/bun.lock apps/client/bunfig.toml ./
RUN bun install --frozen-lockfile

COPY apps/client/ ./

# VITE_* переменные вшиваются в клиентский бандл на этапе сборки —
# в Coolify отметьте их как "Build Variable".
# VITE_APP_FORMAT — формат студий приложения (src/lib/app-format.ts):
# пусто/subscription — app.base40.fit, packages — приложение «пакетных» залов.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_APP_FORMAT
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_APP_FORMAT=$VITE_APP_FORMAT

RUN bun run build

FROM oven/bun:1.4.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

COPY --from=build /app/.output ./.output

EXPOSE 3000
# Health check: Coolify ждёт «healthy» нового контейнера и только потом
# переключает трафик и убирает старый (rolling update). Без проверки каждый
# деплой давал клиентам несколько секунд ошибок. curl/wget в slim-образе нет —
# проверка на bun; /api/health в базу не ходит (src/routes/api/health.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", ".output/server/index.mjs"]
