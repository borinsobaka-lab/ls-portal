/**
 * «Обработка 1С» — отдельный процесс (ANALYTICS_PLAN.md §8.1). Его запускает
 * сервер портала, когда в очереди есть запуск (lib/analytics/server/onec.server.ts):
 * обработка всей истории — минуты счёта и до ~1 ГБ памяти, в процессе
 * веб-сервера она останавливала бы ответы портала. Процесс берёт запуски,
 * пока очередь не опустеет, и завершается — память возвращается системе.
 *
 * Только этот каталог и стандартные модули: в образе портала он лежит
 * отдельно от сборки (apps/admin/Dockerfile, /app/onec) и выполняется bun
 * как есть. В базу и хранилище — через PostgREST и Storage API сервис-ключом
 * (ONEC_SUPABASE_URL, ONEC_SERVICE_KEY — передаёт сервер портала), только
 * RPC an_onec_* для service_role.
 *
 * Как у них: «Проверка новых номенклатур…» → окно новых номенклатур (запуск
 * останавливается со списком, ответ — новым запуском) → своды → снимок.
 * Снимок становится данными отчётов только после «2. Загрузить».
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import {
  OnecError,
  processOnec,
  reviewKey,
  type BreakEvenRow,
  type FactRow,
  type ItemRow,
  type NomenclatureRow,
  type OnecFileInput,
  type OnecKind,
  type StudioRefRow,
} from "./process";
import type { CleanPlan, Inflate } from "./xlsx-read";

const BASE = (process.env.ONEC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.ONEC_SERVICE_KEY ?? "";

/** Сколько фактов в одном запросе (~1 МБ JSON). */
const FACTS_CHUNK = 10_000;
const ITEMS_CHUNK = 5_000;
/** Как часто сообщать о ходе (и узнавать об отмене). */
const PROGRESS_MS = 3_000;

class Cancelled extends Error {}

type Claim = {
  id: number;
  answered: [string, string][];
  files: {
    id: string;
    kind: OnecKind;
    name: string;
    path: string;
    size: number;
    cleaned: boolean;
    plan: CleanPlan | null;
  }[];
  studios: StudioRefRow[];
  nomenclature: NomenclatureRow[];
  break_even: { direction: string | null; board_city: string | null; amount: string | null }[];
};

const headers = () => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
});

/** Временный сбой: сеть, перегрузка, 5xx — запрос можно повторить. */
function transient(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

class RetryableError extends Error {}

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof RetryableError)) throw e;
    }
  }
  throw new Error(`${what}: ${(last as Error).message}`);
}

/**
 * Вызов RPC. Повторяется только идемпотентное: факты — с номером пачки
 * (повтор не складывается дважды), позиции — без повторной вставки.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return withRetry(fn, async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new RetryableError((e as Error).message);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // не JSON — как есть
      }
      const error = transient(res.status) ? RetryableError : Error;
      throw new error(`${res.status} ${message.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  });
}

async function download(path: string): Promise<Uint8Array> {
  return withRetry(`файл ${path}`, async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/storage/v1/object/an-onec/${path}`, {
        headers: headers(),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (e) {
      throw new RetryableError((e as Error).message);
    }
    if (!res.ok) {
      const error = transient(res.status) ? RetryableError : Error;
      throw new error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  });
}

const inflate: Inflate = async function* (data) {
  const stream = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]).pipe(
    createInflateRaw({ chunkSize: 1 << 20 }),
  );
  for await (const chunk of stream) yield chunk as Uint8Array;
};

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Строка журнала, которая у них становилась строкой состояния окна. */
const STATUS_PREFIXES = ["Пересчёт:", "Читаю:", "Нулевые продажи", "Проверка новых номенклатур"];

async function runOne(claim: Claim) {
  const started = Date.now();
  const runId = claim.id;
  let pending: string[] = [];
  let status: string | null = null;
  let cancelled = false;
  let flushing: Promise<void> = Promise.resolve();

  const flush = () => {
    flushing = flushing
      .catch(() => {})
      .then(async () => {
        const lines = pending;
        pending = [];
        const s = status;
        status = null;
        if (
          await rpc<boolean>("an_onec_run_progress", { p_run: runId, p_progress: s, p_log: lines })
        ) {
          cancelled = true;
        }
      });
    return flushing;
  };
  const timer = setInterval(() => void flush().catch(() => {}), PROGRESS_MS);
  const log = (line: string) => {
    pending.push(line);
    if (STATUS_PREFIXES.some((p) => line.startsWith(p))) status = line;
  };
  const check = () => {
    if (cancelled) throw new Cancelled("Обработка отменена.");
  };

  type Snapshot = { id: number; slot: number };
  let snapshot: Snapshot | null = null;
  let seq = 0;
  const begin = async (): Promise<Snapshot> => {
    snapshot ??= await rpc<Snapshot>("an_onec_snapshot_begin", { p_run: runId });
    return snapshot;
  };
  const plans: Promise<unknown>[] = [];

  try {
    const files: OnecFileInput[] = claim.files.map((f) => ({
      kind: f.kind,
      name: f.name,
      plan: f.plan ?? undefined,
      onPlan: (plan) => {
        if (!f.plan) plans.push(rpc("an_onec_file_plan", { p_file: f.id, p_plan: plan }));
      },
      load: async () => {
        check();
        return download(f.path);
      },
    }));
    const breakEven: BreakEvenRow[] = claim.break_even.map((r) => ({
      direction: r.direction,
      city_for_board: r.board_city,
      amount: r.amount,
    }));
    const result = await processOnec(
      {
        files,
        studios: claim.studios,
        nomenclature: claim.nomenclature,
        breakEven,
        sha256Hex,
        answeredReview: new Set(claim.answered.map(([code, name]) => reviewKey({ code, name }))),
      },
      {
        inflate,
        log,
        saveNomenclature: async (rows) => {
          check();
          await rpc("an_onec_nomenclature_store", { p_run: runId, p_rows: rows });
        },
        writer: {
          items: async (rows: ItemRow[]) => {
            check();
            const s = await begin();
            for (let i = 0; i < rows.length; i += ITEMS_CHUNK) {
              const part = rows.slice(i, i + ITEMS_CHUNK);
              await rpc("an_onec_snapshot_items", {
                p_snapshot: s.id,
                p_ids: part.map((r) => r.no),
                p_report: part.map((r) => r.report),
                p_city: part.map((r) => r.city),
                p_studio: part.map((r) => r.studio),
                p_dimension: part.map((r) => r.dimension),
                p_code: part.map((r) => r.code),
                p_status: part.map((r) => r.status),
              });
            }
          },
          facts: async (rows: FactRow[]) => {
            check();
            const s = await begin();
            for (let i = 0; i < rows.length; i += FACTS_CHUNK) {
              const part = rows.slice(i, i + FACTS_CHUNK);
              const v = (n: number) => part.map((r) => r[n + 2]);
              await rpc("an_onec_snapshot_facts", {
                p_snapshot: s.id,
                p_seq: ++seq,
                p_item: part.map((r) => r[0]),
                p_day: part.map((r) => r[1]),
                p_v1: v(0),
                p_v2: v(1),
                p_v3: v(2),
                p_v4: v(3),
                p_v5: v(4),
                p_v6: v(5),
                p_v7: v(6),
                p_v8: v(7),
              });
            }
          },
        },
      },
    );
    await Promise.all(plans);
    check();
    if (result.status === "review") {
      log(
        `Найдены новые номенклатуры: ${result.review.items.length}. Выберите их категории — обработка продолжится.`,
      );
      clearInterval(timer);
      await flush();
      await rpc("an_onec_run_review", { p_run: runId, p_review: result.review });
      return;
    }
    const s = await begin();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    log(`Время: ${seconds} сек.`);
    log("Обработка завершена. Можно загрузить данные в отчёты.");
    clearInterval(timer);
    await flush();
    await rpc("an_onec_run_finish", {
      p_run: runId,
      p_snapshot: s.id,
      p_result: {
        source_rows: result.sourceRows,
        issues: result.issues,
        breakEven: result.breakEven,
        zeroControls: result.zeroControls,
        stats: result.stats,
        seconds,
      },
    });
  } catch (e) {
    clearInterval(timer);
    const isCancel = e instanceof Cancelled;
    const message =
      e instanceof OnecError || isCancel
        ? (e as Error).message
        : `Обработка завершилась с ошибкой: ${(e as Error).message}`;
    if (!isCancel && !(e instanceof OnecError)) console.error("[onec]", e);
    log(message);
    await flush().catch(() => {});
    await rpc("an_onec_run_fail", { p_run: runId, p_error: message, p_cancelled: isCancel });
  }
}

async function main() {
  if (!BASE || !KEY) {
    console.error("[onec] не заданы ONEC_SUPABASE_URL / ONEC_SERVICE_KEY");
    process.exit(1);
  }
  for (;;) {
    const claim = await rpc<Claim | null>("an_onec_run_claim", {});
    if (!claim) break;
    console.log(`[onec] запуск ${claim.id}`);
    await runOne(claim);
    console.log(`[onec] запуск ${claim.id} завершён`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[onec]", e);
    process.exit(1);
  },
);
