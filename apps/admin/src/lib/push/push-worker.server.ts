/**
 * Рассылка пуш-уведомлений — фоновый цикл сервера админки (решение владельца
 * 2026-10-15). Запускается при старте сервера (src/server.ts), раз в
 * TICK_MS и сразу по «Отправить» в админке (kickPushQueue):
 *
 * 0) push_triggers_run — раз в TRIGGERS_EVERY_MS: триггерные уведомления
 *    (напоминание о занятии, абонемент заканчивается…) — сразу в очередь
 *    доставки (db/migrations/2026-10-15_push_triggers.sql);
 * 1) push_start_due — наступившие запланированные: выборка получателей и
 *    очередь доставки (уведомление × устройство);
 * 2) push_claim_deliveries — пачка доставок, параллельно CONCURRENCY
 *    запросов к службам доставки (2000 устройств — порядка 10–20 секунд);
 * 3) push_finish_deliveries — итог пачки (счётчики, удаление устройств,
 *    которых больше нет), рассылка без ждущих — «Отправлено».
 *
 * Очередь — в базе (db/migrations/2026-10-15_push_delivery.sql): перезапуск
 * сервера посреди рассылки её не теряет, два контейнера при выкатке не
 * отправят одно и то же дважды. Ключи VAPID — push_vapid_keys: нет —
 * создаются при первом запуске (их открытый ключ — в подписках устройств,
 * менять нельзя).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { SUPABASE_URL } from "@/integrations/supabase/env";
import { defaultSender } from "@/lib/mail";
import { buildPushPayload, type PushContent } from "./payload";
import {
  VapidSigner,
  generateVapidKeys,
  sendWebPush,
  type PushOutcome,
  type VapidKeyPair,
} from "./web-push.server";

const TICK_MS = 15_000;
/** Проверка триггерных уведомлений — не чаще раза в минуту. */
const TRIGGERS_EVERY_MS = 60_000;
const BATCH = 200;
const CONCURRENCY = 25;
/** Пачек за один проход (дальше — следующий проход). */
const MAX_BATCHES = 100;
/** Подпись VAPID: адрес для связи службы доставки с отправителем (VAPID_SUBJECT,
 * иначе — отправитель писем MAIL_FROM). */
const defaultSubject = () => `mailto:${defaultSender().email}`;

type Claimed = {
  delivery_id: string;
  notification_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: string;
  app_format: string | null;
};

type DeliveryResult = { id: string; result: PushOutcome; error?: string };

// Состояние — на globalThis: в дев-сервере модуль перезагружается, а таймер
// должен остаться один.
type WorkerState = {
  started: boolean;
  running: Promise<void> | null;
  rerun: boolean;
  signer: Promise<VapidSigner> | null;
  lastError: string | null;
  /** Когда последний раз проверяли триггеры (Date.now()). */
  triggersAt: number;
  lastTriggersError: string | null;
};
const g = globalThis as typeof globalThis & { __base40PushWorker?: WorkerState };
const state: WorkerState = (g.__base40PushWorker ??= {
  started: false,
  running: null,
  rerun: false,
  signer: null,
  lastError: null,
  triggersAt: 0,
  lastTriggersError: null,
});

/** Готова ли рассылка на этом сервере (нужен сервис-ключ Supabase). */
export function pushWorkerReady() {
  return hasSupabaseAdmin();
}

/** Рассылает ли этот сервер: `PUSH_WORKER=off` — нет (рассылает другой). */
export function pushWorkerEnabled() {
  return hasSupabaseAdmin() && process.env.PUSH_WORKER !== "off";
}

export function startPushWorker() {
  if (state.started || !pushWorkerEnabled()) return;
  state.started = true;
  setTimeout(() => void runPushQueue(), 3_000);
  setInterval(() => void runPushQueue(), TICK_MS);
}

/** Один проход очереди; уже идёт — повторится сразу после него. */
export function runPushQueue(): Promise<void> {
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
      // Одна и та же ошибка (например, база без миграции) — в лог один раз.
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      if (message !== state.lastError) console.error("[push] рассылка:", message);
      state.lastError = message;
      // Ключи перечитаем: их могли создать или восстановить.
      state.signer = null;
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

async function loadVapidKeys(admin: SupabaseClient): Promise<VapidKeyPair> {
  const read = async () =>
    check(await admin.from("push_vapid_keys").select("public_key, private_jwk").maybeSingle()) as {
      public_key: string;
      private_jwk: JsonWebKey;
    } | null;
  let row = await read();
  if (!row) {
    const keys = await generateVapidKeys();
    // Два сервера одновременно — останутся ключи того, кто записал первым.
    check(
      await admin
        .from("push_vapid_keys")
        .upsert(
          { id: true, public_key: keys.publicKey, private_jwk: keys.privateJwk },
          { onConflict: "id", ignoreDuplicates: true },
        ),
    );
    row = await read();
    if (!row) throw new Error("Не удалось сохранить ключи VAPID");
    console.info("[push] созданы ключи VAPID");
  }
  return { publicKey: row.public_key, privateJwk: row.private_jwk };
}

function getSigner(admin: SupabaseClient): Promise<VapidSigner> {
  state.signer ??= loadVapidKeys(admin).then(
    (keys) => new VapidSigner(keys, process.env.VAPID_SUBJECT?.trim() || defaultSubject()),
  );
  return state.signer;
}

/** Иконка приложения для Android — своя у каждого формата (app_install_settings). */
async function loadIcons(admin: SupabaseClient): Promise<Record<string, string>> {
  const rows = check(await admin.from("app_install_settings").select("format, app_icon_path")) as
    | { format: string; app_icon_path: string | null }[]
    | null;
  const icons: Record<string, string> = {};
  for (const r of rows ?? []) {
    if (!r.app_icon_path || !SUPABASE_URL) continue;
    const folder = r.app_icon_path.split("/").map(encodeURIComponent).join("/");
    icons[r.format] = `${SUPABASE_URL}/storage/v1/object/public/app-icons/${folder}/icon-192.png`;
  }
  return icons;
}

async function loadContent(
  admin: SupabaseClient,
  cache: Map<string, PushContent | null>,
  ids: string[],
) {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const rows = check(
    await admin
      .from("push_notifications")
      .select("id, title, message, action_url, translations")
      .in("id", missing),
  ) as PushContent[] | null;
  for (const id of missing) cache.set(id, null);
  for (const r of rows ?? []) cache.set(r.id, r);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Итог пачки — с повтором: не записанный итог вернул бы пачку в очередь
 * через 10 минут, и принятые пуши ушли бы второй раз.
 */
async function finish(admin: SupabaseClient, results: DeliveryResult[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.rpc("push_finish_deliveries", { p_results: results });
    if (!error) return;
    if (attempt >= 3) throw new Error(error.message);
    await sleep(1000 * 2 ** attempt);
  }
}

/**
 * Триггерные уведомления: ошибка (например, база без миграции) не мешает
 * рассылкам из админки — в лог один раз.
 */
async function runTriggers(admin: SupabaseClient) {
  if (Date.now() - state.triggersAt < TRIGGERS_EVERY_MS) return;
  state.triggersAt = Date.now();
  const { error } = await admin.rpc("push_triggers_run");
  if (error && error.message !== state.lastTriggersError) {
    console.error("[push] триггерные уведомления:", error.message);
  }
  state.lastTriggersError = error?.message ?? null;
}

async function tick() {
  const admin = getSupabaseAdmin();
  const signer = await getSigner(admin);
  await runTriggers(admin);
  check(await admin.rpc("push_start_due"));

  const content = new Map<string, PushContent | null>();
  let icons: Record<string, string> | null = null;
  for (let round = 0; round < MAX_BATCHES; round++) {
    const batch = check(await admin.rpc("push_claim_deliveries", { p_limit: BATCH })) as
      | Claimed[]
      | null;
    if (!batch?.length) break;
    icons ??= await loadIcons(admin).catch(() => ({}));
    await loadContent(
      admin,
      content,
      batch.map((d) => d.notification_id),
    );

    const results = await mapLimit(batch, CONCURRENCY, async (d): Promise<DeliveryResult> => {
      const notification = content.get(d.notification_id);
      if (!notification)
        return { id: d.delivery_id, result: "failed", error: "Уведомление удалено" };
      const payload = buildPushPayload(
        notification,
        d.locale,
        d.delivery_id,
        (d.app_format && icons?.[d.app_format]) || null,
      );
      const sent = await sendWebPush(
        { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth },
        payload,
        signer,
      );
      return { id: d.delivery_id, result: sent.outcome, error: sent.error };
    });
    await finish(admin, results);
    // Служба доставки перегружена (429/5xx у заметной части пачки): повторы
    // вернулись в очередь первыми — не тратить на них попытки в этом же
    // проходе, подождать следующего (15 с).
    if (results.filter((r) => r.result === "retry").length > results.length / 4) break;
  }
  check(await admin.rpc("push_finalize"));
}
