/**
 * «Обработка 1С»: запуск отдельного процесса обработки (lib/analytics/onec/worker.ts).
 * Раз в 15 секунд и сразу по «1. Обработать» (kickOnecWorker) сервер смотрит
 * очередь an_onec_runs; есть запуск — поднимает процесс, если он ещё не
 * идёт. Процесс сам берёт запуски (an_onec_run_claim, skip locked — два
 * контейнера при выкатке не возьмут один запуск) и завершается.
 *
 * ANALYTICS_JOBS=off (или PUSH_WORKER=off) — не обрабатывать на этом сервере.
 * Путь к процессу — ONEC_WORKER (по умолчанию /app/onec/worker.ts в образе,
 * src/lib/analytics/onec/worker.ts при разработке).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { SUPABASE_URL } from "@/integrations/supabase/env";

const CHECK_MS = 15_000;
/** Запуск без heartbeat дольше этого — процесс умер (как в an_onec_run_claim). */
const STALE_MS = 3 * 60_000;

const g = globalThis as typeof globalThis & {
  __lsOnec?: { started: boolean; child: ChildProcess | null; checking: boolean };
};
const state = (g.__lsOnec ??= { started: false, child: null, checking: false });

function workerOn() {
  return (
    hasSupabaseAdmin() && process.env.ANALYTICS_JOBS !== "off" && process.env.PUSH_WORKER !== "off"
  );
}

function workerScript(): string | null {
  const candidates = [
    process.env.ONEC_WORKER,
    "/app/onec/worker.ts",
    join(process.cwd(), "src/lib/analytics/onec/worker.ts"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function startOnecWorker() {
  if (state.started || !workerOn()) return;
  state.started = true;
  setTimeout(() => void check(), 20_000);
  setInterval(() => void check(), CHECK_MS);
}

/** Сразу проверить очередь (после «1. Обработать» или ответа в окне номенклатур). */
export function kickOnecWorker() {
  if (workerOn()) void check();
}

async function check() {
  if (state.child || state.checking) return;
  state.checking = true;
  try {
    const stale = new Date(Date.now() - STALE_MS).toISOString();
    const { count, error } = await getSupabaseAdmin()
      .from("an_onec_runs")
      .select("id", { count: "exact", head: true })
      .or(`status.eq.queued,and(status.eq.running,heartbeat_at.lt.${stale})`);
    if (error) {
      console.error("[onec] очередь:", error.message);
      return;
    }
    if (count) spawnWorker();
  } finally {
    state.checking = false;
  }
}

function spawnWorker() {
  const script = workerScript();
  if (!script) {
    console.error("[onec] не найден процесс обработки (ONEC_WORKER)");
    return;
  }
  // Сервер портала работает под bun; при разработке (vite под node) — bun из PATH.
  const bun = process.versions.bun ? process.execPath : "bun";
  const child = spawn(bun, ["--smol", script], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ONEC_SUPABASE_URL: SUPABASE_URL,
      ONEC_SERVICE_KEY: process.env.APP_SUPABASE_SERVICE_KEY ?? "",
    },
  });
  state.child = child;
  const done = () => {
    if (state.child === child) state.child = null;
  };
  child.on("exit", (code) => {
    if (code) console.error("[onec] процесс обработки завершился с кодом", code);
    done();
  });
  child.on("error", (e) => {
    console.error("[onec] не удалось запустить обработку:", e.message);
    done();
  });
}
