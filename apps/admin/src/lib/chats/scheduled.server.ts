/**
 * Отложенные сообщения чатов — отправка (фоновый цикл сервера портала, раз
 * в 20 с): `chat_scheduled_tick` отправляет наступившие от имени автора
 * (db/migrations/2026-11-08_zzzzzz_chat_scheduled_polls.sql). Ошибка — в
 * лог, следующий проход повторит. Без сервис-ключа не запускается;
 * `PUSH_WORKER=off` — отправляет другой сервер.
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

const TICK_MS = 20_000;

const g = globalThis as typeof globalThis & {
  __chatScheduled?: { started: boolean; running: boolean };
};
const state = (g.__chatScheduled ??= { started: false, running: false });

export function startChatScheduledWorker() {
  if (state.started || !hasSupabaseAdmin()) return;
  if (process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setInterval(() => void runChatScheduled(), TICK_MS);
}

export async function runChatScheduled(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const { error } = await getSupabaseAdmin().rpc("chat_scheduled_tick");
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error("[chat-scheduled]", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}
