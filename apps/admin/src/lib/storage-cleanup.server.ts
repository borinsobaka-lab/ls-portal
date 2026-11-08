/**
 * Стирание файлов удалённого — фоновый цикл сервера портала (сервис-ключ;
 * db/migrations/2026-11-08_zzzz_deletion_cleanup.sql).
 *
 * Раз в 5 минут — очередь `storage_purge_queue` (`storage_purge_due`): её
 * ставят триггеры базы, когда удаляют чат, сообщение, задачу, проект, файл
 * задачи, аватарку, клуб, пост контент-плана, выгрузку 1С. База отдаёт только
 * файлы, на которые больше ничто не ссылается (пересланное сообщение, другая
 * задача постановки, шаблон). Раз в сутки — страховка: файлы без ссылок
 * старше запаса (`storage_gc_candidates`). Storage удаляет файлы только своим
 * API — строка storage.objects без файла на диске осталась бы мусором.
 * Ошибка — в лог, следующий проход повторит. `PUSH_WORKER=off` — уборку
 * ведёт другой сервер. База знаний и «Академия» — `lib/kb/trash-purge.server.ts`.
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

const TICK_MS = 5 * 60 * 1000;
const QUEUE_BATCH = 500;
const GC_LIMIT = 2000;

type FileRow = { bucket_id: string; name: string };

const g = globalThis as typeof globalThis & {
  __storageCleanup?: { started: boolean; running: boolean; dailyDone: string };
};
const state = (g.__storageCleanup ??= { started: false, running: false, dailyDone: "" });

export function startStorageCleanup() {
  if (state.started || !hasSupabaseAdmin() || process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setTimeout(() => void runStorageCleanup(), 90_000);
  setInterval(() => void runStorageCleanup(), TICK_MS);
}

/** Стереть файлы пачками по 100 на бакет; сколько стёрто. */
async function removeFiles(rows: FileRow[]): Promise<number> {
  const admin = getSupabaseAdmin();
  const byBucket = new Map<string, string[]>();
  for (const r of rows) byBucket.set(r.bucket_id, [...(byBucket.get(r.bucket_id) ?? []), r.name]);
  let removed = 0;
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 100) {
      const part = names.slice(i, i + 100);
      const { error } = await admin.storage.from(bucket).remove(part);
      if (error) {
        console.error(`[storage-cleanup] ${bucket}:`, error.message);
        continue;
      }
      removed += part.length;
    }
  }
  return removed;
}

export async function runStorageCleanup(now = new Date()): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    await runQueue();
    await runDaily(now);
  } finally {
    state.running = false;
  }
}

async function runQueue() {
  const admin = getSupabaseAdmin();
  try {
    // Очередь — пока отдаёт полные пачки (большой удалённый чат).
    for (let round = 0; round < 20; round++) {
      const { data, error } = await admin.rpc("storage_purge_due", { p_limit: QUEUE_BATCH });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as FileRow[];
      // Пусто — очередь разобрана (или в пачке были только файлы со
      // ссылками: остаток — в следующий проход).
      if (!rows.length) break;
      await removeFiles(rows);
    }
  } catch (e) {
    console.error("[storage-cleanup]", e instanceof Error ? e.message : e);
  }
}

/** Раз в сутки — файлы управляемых бакетов без ссылок старше запаса. */
async function runDaily(now: Date) {
  const admin = getSupabaseAdmin();
  const day = now.toISOString().slice(0, 10);
  if (state.dailyDone !== day) {
    try {
      const { data, error } = await admin.rpc("storage_gc_candidates", { p_limit: GC_LIMIT });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as FileRow[];
      const removed = rows.length ? await removeFiles(rows) : 0;
      state.dailyDone = day;
      if (removed) console.log(`[storage-cleanup] удалено файлов без ссылок: ${removed}`);
    } catch (e) {
      console.error("[storage-cleanup] уборка:", e instanceof Error ? e.message : e);
    }
  }
}
