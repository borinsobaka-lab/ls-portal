import { startAccessSync } from "./lib/access/sync.server";
import { startAnalyticsJobs } from "./lib/analytics/server/jobs.server";
import { errorResponse } from "./lib/error-page";
import { startKbTrashPurge } from "./lib/kb/trash-purge.server";
import { startPushWorker } from "./lib/push/push-worker.server";

// Серверная точка входа (vite.config: tanstackStart({ server: { entry: "server" } })).
// Обёртка ловит то, что не дошло до errorMiddleware в start.ts.

// Рассылка пуш-уведомлений — фоновый цикл этого же процесса (без сервис-ключа
// Supabase не запускается).
startPushWorker();
// Корзина базы знаний: истёкшее — навсегда, файлы удалённого — из бакета.
startKbTrashPurge();
// Сроки ролей и «Доступ до»: доступ включается и выключается сам.
startAccessSync();
// «Аналитика»: сборщики модулей и служебные задачи (ANALYTICS_PLAN.md).
startAnalyticsJobs();

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

function getServerEntry(): Promise<ServerEntry> {
  serverEntryPromise ??= import("@tanstack/react-start/server-entry").then(
    (m) => (m.default ?? m) as ServerEntry,
  );
  return serverEntryPromise;
}

// h3 превращает исключение внутри обработчика в обычный 500 с телом
// {"unhandled":true,"message":"HTTPError"} — try/catch его не видит. Сам h3
// исключение уже залогировал; здесь только подменяем ответ на понятный.
async function normalizeUnhandledResponse(request: Request, response: Response) {
  if (response.status < 500) return response;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const body = await response.clone().text();
  if (!body.includes('"unhandled":true')) return response;
  return errorResponse(request);
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeUnhandledResponse(request, response);
    } catch (error) {
      console.error(error);
      return errorResponse(request);
    }
  },
};
