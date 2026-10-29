/**
 * Приём синхронизации со старого портала аналитики (ANALYTICS_PLAN.md, §3).
 * Агент на их сервере (deploy/analytics-replica) шлёт пачки изменений:
 *
 *   POST /api/analytics/replica
 *   X-Replica-Time: <unix-секунды>
 *   X-Replica-Signature: hex(HMAC-SHA256(ANALYTICS_REPLICA_SECRET,
 *                                        "<время>.<sha256 тела hex>"))
 *   X-Replica-Gzip: 1          — тело сжато gzip
 *   { "batch": "…", "items": [{ "target": "an_…", "rows": [...], "delete": [...] }],
 *     "secrets": [{ "kind": "…", "ref": "…", "name": "…", "value": "<RSA-блоки>" }] }
 *
 * Строки — колонки таблицы-получателя (её регистрирует миграция модуля в
 * an_replica_targets): upsert по ключу и удаление ключей — RPC
 * an_replica_apply (service_role), пачками. Ключи интеграций — в an_secrets.
 * Повтор пачки безопасен (upsert).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptFromAgent, saveSecret } from "./secrets.server";

const MAX_BODY = 30 * 1024 * 1024;
const MAX_UNZIPPED = 300 * 1024 * 1024;
const MAX_SKEW_SECONDS = 600;
/** Строк в одном вызове RPC: тело запроса к PostgREST — до пары мегабайт. */
const RPC_ROWS = 1500;
const RPC_BYTES = 1_500_000;

export type ReplicaItem = { target: string; rows?: unknown[]; delete?: unknown[] };
export type ReplicaSecret = { kind: string; ref: string; name: string; value: string };
export type ReplicaBody = { batch?: string; items?: ReplicaItem[]; secrets?: ReplicaSecret[] };

export function replicaSecret(): string | null {
  const s = process.env.ANALYTICS_REPLICA_SECRET?.trim();
  return s && s.length >= 32 ? s : null;
}

/** Подпись тела, как её считает агент. */
export function replicaSignature(secret: string, time: string, body: Uint8Array): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${time}.${digest}`).digest("hex");
}

export function verifyReplicaRequest(
  secret: string,
  time: string | null,
  signature: string | null,
  body: Uint8Array,
  now = Date.now(),
): string | null {
  if (!time || !/^\d{9,12}$/.test(time) || !signature || !/^[0-9a-f]{64}$/.test(signature)) {
    return "Нет подписи";
  }
  if (Math.abs(now / 1000 - Number(time)) > MAX_SKEW_SECONDS) return "Подпись устарела";
  const expected = Buffer.from(replicaSignature(secret, time, body), "hex");
  const got = Buffer.from(signature, "hex");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "Неверная подпись";
  return null;
}

/** Разрезать строки на пачки для RPC: по числу и примерному объёму. */
export function chunkRows<T>(rows: T[], maxRows = RPC_ROWS, maxBytes = RPC_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const row of rows) {
    const len = JSON.stringify(row).length;
    if (cur.length > 0 && (cur.length >= maxRows || size + len > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(row);
    size += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export async function readReplicaBody(
  request: Request,
): Promise<{ raw: Uint8Array; json: ReplicaBody }> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new ReplicaError(413, "Пачка слишком большая");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY) throw new ReplicaError(413, "Пачка слишком большая");
  const text =
    request.headers.get("x-replica-gzip") === "1"
      ? gunzipSync(raw, { maxOutputLength: MAX_UNZIPPED }).toString("utf8")
      : new TextDecoder().decode(raw);
  let json: ReplicaBody;
  try {
    json = JSON.parse(text) as ReplicaBody;
  } catch {
    throw new ReplicaError(400, "Неверный JSON");
  }
  return { raw, json };
}

export class ReplicaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ReplicaResult = { target: string; upserts: number; deletes: number; error?: string };

export async function applyReplicaBody(body: ReplicaBody): Promise<ReplicaResult[]> {
  const admin = getSupabaseAdmin();
  const batch = typeof body.batch === "string" ? body.batch.slice(0, 120) : null;
  const results: ReplicaResult[] = [];

  for (const item of body.items ?? []) {
    if (!item || typeof item.target !== "string" || !/^an_[a-z0-9_]{1,60}$/.test(item.target)) {
      throw new ReplicaError(400, "Неверная таблица в пачке");
    }
    const started = Date.now();
    const result: ReplicaResult = { target: item.target, upserts: 0, deletes: 0 };
    try {
      const deletes = Array.isArray(item.delete) ? item.delete : [];
      for (const part of chunkRows(deletes)) {
        const { data, error } = await admin.rpc("an_replica_apply", {
          p_target: item.target,
          p_rows: null,
          p_delete: part,
        });
        if (error) throw new Error(error.message);
        result.deletes += Number((data as { deletes: number }).deletes ?? 0);
      }
      const rows = Array.isArray(item.rows) ? item.rows : [];
      for (const part of chunkRows(rows)) {
        const { data, error } = await admin.rpc("an_replica_apply", {
          p_target: item.target,
          p_rows: part,
          p_delete: null,
        });
        if (error) throw new Error(error.message);
        result.upserts += Number((data as { upserts: number }).upserts ?? 0);
      }
    } catch (e) {
      result.error = (e as Error).message.slice(0, 1000);
    }
    await admin.from("an_replica_log").insert({
      batch,
      target: item.target,
      upserts: result.upserts,
      deletes: result.deletes,
      duration_ms: Date.now() - started,
      error: result.error ?? null,
    });
    results.push(result);
  }

  for (const s of body.secrets ?? []) {
    if (!s || [s.kind, s.ref, s.name, s.value].some((v) => typeof v !== "string" || !v)) continue;
    try {
      await saveSecret({ kind: s.kind, ref: s.ref, name: s.name }, decryptFromAgent(s.value));
      results.push({ target: `secret:${s.kind}`, upserts: 1, deletes: 0 });
    } catch (e) {
      results.push({
        target: `secret:${s.kind}`,
        upserts: 0,
        deletes: 0,
        error: (e as Error).message,
      });
    }
  }
  return results;
}
