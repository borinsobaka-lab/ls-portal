import { createServerFn } from "@tanstack/react-start";

import { requireStaff } from "@/integrations/supabase/auth-middleware";
import {
  pushWorkerEnabled,
  pushWorkerReady,
  runPushQueue,
  startPushWorker,
} from "@/lib/push/push-worker.server";

/**
 * Пуш-уведомления (раздел «Мобильное приложение» → «Пуш-уведомления»).
 * Рассылку ведёт фоновый цикл сервера (lib/push/push-worker.server.ts); что
 * отправлять — решает база (наступившие запланированные), поэтому «толкнуть»
 * очередь может любой сотрудник: лишнего он этим не отправит.
 */

/** «Отправить сейчас»: не ждать очередного прохода (до 15 секунд). */
export const kickPushQueue = createServerFn({ method: "POST" })
  .middleware([requireStaff])
  .handler(async () => {
    // PUSH_WORKER=off — рассылает другой сервер: он заберёт уведомление сам.
    if (!pushWorkerEnabled()) return { ok: true };
    startPushWorker();
    // Не ждём: рассылка на тысячи устройств идёт в фоне, страница следит за
    // статусом сама.
    void runPushQueue();
    return { ok: true };
  });

/** Настроена ли рассылка на сервере (без сервис-ключа — нет). */
export const getPushServiceStatus = createServerFn({ method: "GET" })
  .middleware([requireStaff])
  .handler(async () => ({ ready: pushWorkerReady() }));
