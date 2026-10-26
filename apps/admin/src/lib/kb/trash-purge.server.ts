/**
 * Очистка корзины базы знаний — фоновый цикл сервера админки (раз в час,
 * сервис-ключ). Истёкшее (30 дней) — kb_trash_purge_due; файлы статей,
 * удалённых навсегда, удалённых баз и шаблонов — из очереди kb_file_purge: Storage
 * удаляет файлы только своим API (строки storage.objects без файлов на
 * диске остались бы мусором). Ошибка — в лог, следующий проход повторит.
 *
 * Раз в сутки (первый проход после смены даты) — уборка
 * (db/migrations/2026-10-25_zzzzz_kb_storage_perf.sql): файлы бакета, на
 * которые не ссылается ни статья, ни черновик, ни версия, ни шаблон, ни
 * корзина, старше недели (kb_file_gc_candidates — неделя запаса на правку,
 * которая ещё не сохранилась), и сроки журналов (kb_housekeeping).
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

/** Бакет файлов статей (как KB_BUCKET в lib/kb/files.ts — тот тянет браузерный клиент). */
const KB_BUCKET = "kb-media";

const TICK_MS = 60 * 60 * 1000;
const BATCH = 50;

/** Неделя запаса: загруженное, но ещё не сохранённое в черновик, не трогаем. */
const GC_GRACE_DAYS = 7;
/** Сколько файлов за сутки удаляем не больше (пачками по 100). */
const GC_MAX_ROUNDS = 10;

const g = globalThis as typeof globalThis & {
  __base40KbPurge?: { started: boolean; dailyDone: string };
};
const state = (g.__base40KbPurge ??= { started: false, dailyDone: "" });

export function startKbTrashPurge() {
  if (state.started || !hasSupabaseAdmin() || process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setTimeout(() => void runKbTrashPurge(), 60_000);
  setInterval(() => void runKbTrashPurge(), TICK_MS);
}

/** Все пути файлов в папке бакета (вложенные папки — вглубь). */
async function listFiles(prefix: string): Promise<string[]> {
  const storage = getSupabaseAdmin().storage.from(KB_BUCKET);
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.list(prefix, { limit: 1000, offset });
    if (error) throw new Error(error.message);
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`;
      // У папки в списке Storage нет id — заходим внутрь.
      if (item.id) out.push(path);
      else out.push(...(await listFiles(path)));
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function runKbTrashPurge(): Promise<void> {
  const admin = getSupabaseAdmin();
  try {
    const { error: dueError } = await admin.rpc("kb_trash_purge_due");
    if (dueError) throw new Error(dueError.message);

    const { data: queue, error } = await admin
      .from("kb_file_purge")
      .select("id, base_id, node_id, folder")
      .order("id")
      .limit(BATCH);
    if (error) throw new Error(error.message);
    for (const row of (queue ?? []) as {
      id: number;
      base_id: string | null;
      node_id: string | null;
      folder: string | null;
    }[]) {
      // Папка шаблона (templates/<id>) — своей строкой, у статьи и базы — base_id.
      const prefix = row.folder ?? (row.node_id ? `${row.base_id}/${row.node_id}` : row.base_id);
      if (!prefix) continue;
      const files = await listFiles(prefix);
      for (let i = 0; i < files.length; i += 100) {
        const { error: removeError } = await admin.storage
          .from(KB_BUCKET)
          .remove(files.slice(i, i + 100));
        if (removeError) throw new Error(removeError.message);
      }
      const { error: doneError } = await admin.from("kb_file_purge").delete().eq("id", row.id);
      if (doneError) throw new Error(doneError.message);
    }
  } catch (e) {
    console.error("[kb-trash-purge]", e instanceof Error ? e.message : e);
  }
  await runKbDaily();
}

/** Уборка раз в сутки: файлы без ссылок и старые строки журналов. */
export async function runKbDaily(now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (state.dailyDone === day) return;
  const admin = getSupabaseAdmin();
  try {
    let removed = 0;
    for (let round = 0; round < GC_MAX_ROUNDS; round++) {
      const { data, error } = await admin.rpc("kb_file_gc_candidates", {
        p_grace_days: GC_GRACE_DAYS,
        p_limit: 100,
      });
      if (error) throw new Error(error.message);
      const names = ((data ?? []) as { name: string }[]).map((r) => r.name);
      if (!names.length) break;
      const { error: removeError } = await admin.storage.from(KB_BUCKET).remove(names);
      if (removeError) throw new Error(removeError.message);
      removed += names.length;
      if (names.length < 100) break;
    }
    const { data: kept, error: houseError } = await admin.rpc("kb_housekeeping");
    if (houseError) throw new Error(houseError.message);
    state.dailyDone = day;
    if (removed) console.log(`[kb-daily] удалено файлов без ссылок: ${removed}`, kept);
  } catch (e) {
    console.error("[kb-daily]", e instanceof Error ? e.message : e);
  }
}
