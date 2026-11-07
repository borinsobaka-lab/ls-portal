/**
 * Пуши сотрудникам — фоновый цикл сервера портала (TASKS_CHATS_PLAN.md,
 * веха 1). Очередь — portal_push_deliveries
 * (db/migrations/2026-11-07_zz_portal_notifications.sql): строку ставит
 * notif_send, когда событие нужно человеку, а он не смотрит на портал.
 *
 * Проход раз в TICK_MS: очередь почти всегда пуста (частичный индекс —
 * запрос стоит копейки), а сообщение в чате должно дойти за секунды, не за
 * 15 секунд, как рассылки клиентам. Шифрование и подпись VAPID — общие с
 * рассылкой клиентам (lib/push/*), ключи — те же (push_vapid_keys).
 * Раз в сутки — уборка ленты и очереди (notif_housekeeping).
 *
 * `PUSH_WORKER=off` выключает и этот цикл (рассылает другой сервер).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { getSigner, pushWorkerEnabled, resetSigner } from "@/lib/push/push-worker.server";
import { sendWebPush, type PushOutcome } from "@/lib/push/web-push.server";
import { buildPortalPushPayload, type PortalPushRow } from "./push-payload";

const TICK_MS = 2_000;
const BATCH = 200;
const CONCURRENCY = 25;
const MAX_BATCHES = 50;
const HOUSEKEEPING_MS = 24 * 60 * 60 * 1000;
/** Пуш сотруднику старше суток не нужен: служба его не держит дольше. */
const TTL_S = 24 * 60 * 60;

type Claimed = PortalPushRow & {
  delivery_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type Result = { id: string; result: PushOutcome; error?: string };

type State = {
  started: boolean;
  running: Promise<void> | null;
  rerun: boolean;
  lastError: string | null;
  housekeepingAt: number;
};
const g = globalThis as typeof globalThis & { __portalPushWorker?: State };
const state: State = (g.__portalPushWorker ??= {
  started: false,
  running: null,
  rerun: false,
  lastError: null,
  housekeepingAt: 0,
});

export function startPortalPushWorker() {
  if (state.started || !pushWorkerEnabled()) return;
  state.started = true;
  setTimeout(() => void runPortalPushQueue(), 4_000);
  setInterval(() => void runPortalPushQueue(), TICK_MS);
}

/** Один проход; уже идёт — повторится сразу после него. */
export function runPortalPushQueue(): Promise<void> {
  if (state.running) {
    state.rerun = true;
    return state.running;
  }
  state.running = (async () => {
    try {
      do {
        state.rerun = false;
        await tick();
      } while (state.rerun);
      state.lastError = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      if (message !== state.lastError) console.error("[portal-push]", message);
      state.lastError = message;
      resetSigner();
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Итог — с повтором: не записанный итог вернул бы пачку и пуши ушли бы дважды. */
async function finish(admin: SupabaseClient, results: Result[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.rpc("portal_push_finish", { p_results: results });
    if (!error) return;
    if (attempt >= 3) throw new Error(error.message);
    await sleep(1000 * 2 ** attempt);
  }
}

async function housekeeping(admin: SupabaseClient) {
  if (Date.now() - state.housekeepingAt < HOUSEKEEPING_MS) return;
  state.housekeepingAt = Date.now();
  const { error } = await admin.rpc("notif_housekeeping");
  if (error) console.error("[portal-push] уборка:", error.message);
}

async function tick() {
  const admin = getSupabaseAdmin();
  await housekeeping(admin);
  for (let round = 0; round < MAX_BATCHES; round++) {
    const batch = check(await admin.rpc("portal_push_claim", { p_limit: BATCH })) as
      | Claimed[]
      | null;
    if (!batch?.length) break;
    const signer = await getSigner(admin);
    const results = await mapLimit(batch, CONCURRENCY, async (d): Promise<Result> => {
      const sent = await sendWebPush(
        { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth },
        buildPortalPushPayload(d),
        signer,
        { ttl: TTL_S },
      );
      return { id: d.delivery_id, result: sent.outcome, error: sent.error };
    });
    await finish(admin, results);
    if (results.filter((r) => r.result === "retry").length > results.length / 4) break;
  }
}
