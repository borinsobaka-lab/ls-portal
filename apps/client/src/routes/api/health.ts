import { createFileRoute } from "@tanstack/react-router";

/**
 * Проверка живости контейнера (HEALTHCHECK в apps/client/Dockerfile, внешний
 * мониторинг): сервер запущен и отвечает. В базу не ходит — сбой Supabase не
 * должен заставлять Coolify считать приложение мёртвым и перезапускать его.
 * Coolify переключает трафик на новый контейнер только после «healthy», без
 * проверки каждый деплой давал клиентам несколько секунд ошибок.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        new Response("ok", {
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        }),
    },
  },
});
