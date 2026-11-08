/**
 * Уведомления портала на почту — фоновый цикл сервера портала (решение
 * владельца 2026-11-08). Очередь — portal_email_deliveries
 * (db/migrations/2026-11-08_zzzzzzzzzzzz_notif_email.sql): строку ставит
 * notif_send_ex, когда у вида включена почта, или проверочное письмо из
 * настроек.
 *
 * Проход раз в TICK_MS, письма — через общий sendMail (SMTP почтового
 * хостинга, запасной — Resend; lib/mail.ts), не больше CONCURRENCY сразу —
 * у SMTP пул из двух соединений. Ошибка отправки — повтор следующим
 * проходом (до 3 попыток, считает база). Почта не настроена — очередь не
 * трогается (письма дождутся настройки в пределах суток).
 *
 * `PUSH_WORKER=off` выключает и этот цикл (рассылает другой сервер).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { mailProvider, sendMail } from "@/lib/mail";
import { pushWorkerEnabled } from "@/lib/push/push-worker.server";
import { buildPortalEmail, type PortalEmailRow } from "./email";

const TICK_MS = 10_000;
const BATCH = 20;
const CONCURRENCY = 2;
const MAX_BATCHES = 10;
/** Одно письмо — не дольше 20 с (SMTP: соединение, вход, отправка). */
const SEND_TIMEOUT_MS = 20_000;

type Claimed = PortalEmailRow & { delivery_id: string; email: string };
type Result = { id: string; result: "sent" | "retry"; error?: string };

type State = {
  started: boolean;
  running: Promise<void> | null;
  lastError: string | null;
  warnedNoMail: boolean;
};
const g = globalThis as typeof globalThis & { __portalEmailWorker?: State };
const state: State = (g.__portalEmailWorker ??= {
  started: false,
  running: null,
  lastError: null,
  warnedNoMail: false,
});

export function startPortalEmailWorker() {
  if (state.started || !pushWorkerEnabled()) return;
  state.started = true;
  setTimeout(() => void runPortalEmailQueue(), 6_000);
  setInterval(() => void runPortalEmailQueue(), TICK_MS);
}

/** Один проход; уже идёт — ждём его. */
export function runPortalEmailQueue(): Promise<void> {
  if (state.running) return state.running;
  state.running = (async () => {
    try {
      await tick();
      state.lastError = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      if (message !== state.lastError) console.error("[portal-email]", message);
      state.lastError = message;
    } finally {
      state.running = null;
    }
  })();
  return state.running;
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

/** Итог — с повтором: не записанный итог вернул бы пачку, письма ушли бы дважды. */
async function finish(admin: SupabaseClient, results: Result[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.rpc("portal_email_finish", { p_results: results });
    if (!error) return;
    if (attempt >= 3) throw new Error(error.message);
    await sleep(1000 * 2 ** attempt);
  }
}

async function tick() {
  if (!mailProvider()) {
    if (!state.warnedNoMail) {
      console.warn("[portal-email] почта не настроена (SMTP_* или RESEND_API_KEY) — письма ждут");
      state.warnedNoMail = true;
    }
    return;
  }
  const admin = getSupabaseAdmin();
  for (let round = 0; round < MAX_BATCHES; round++) {
    const { data, error } = await admin.rpc("portal_email_claim", { p_limit: BATCH });
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Claimed[];
    if (!batch.length) break;
    const results = await mapLimit(batch, CONCURRENCY, async (d): Promise<Result> => {
      const mail = buildPortalEmail(d);
      const sent = await sendMail(
        { to: d.email, subject: mail.subject, html: mail.html, text: mail.text },
        process.env,
        { deadline: Date.now() + SEND_TIMEOUT_MS },
      );
      return sent.ok
        ? { id: d.delivery_id, result: "sent" }
        : { id: d.delivery_id, result: "retry", error: sent.error };
    });
    await finish(admin, results);
    // Почтовый сервер не принимает — остальное подождёт следующего прохода.
    if (results.some((r) => r.result === "retry")) break;
  }
}
