/**
 * Сроки доступа — фоновый цикл сервера админки (раз в 5 минут, сервис-ключ):
 * назначения ролей «с / до» и «Доступ до» у человека начинают и перестают
 * действовать сами (access_sync_due пересчитывает тех, у кого есть сроки,
 * и пишет только разницу; ACCESS.md). Ошибка — в лог один раз, следующий
 * проход повторит.
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

const TICK_MS = 5 * 60 * 1000;

const g = globalThis as typeof globalThis & {
  __base40AccessSync?: { started: boolean; lastError: string | null };
};
const state = (g.__base40AccessSync ??= { started: false, lastError: null });

export function startAccessSync() {
  // Как у рассылки: PUSH_WORKER=off — фоновую работу делает другой сервер.
  if (state.started || !hasSupabaseAdmin() || process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setTimeout(() => void runAccessSync(), 20_000);
  setInterval(() => void runAccessSync(), TICK_MS);
}

export async function runAccessSync(): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("access_sync_due");
  if (error && error.message !== state.lastError) {
    console.error("[access] сроки доступа:", error.message);
  }
  state.lastError = error?.message ?? null;
}
