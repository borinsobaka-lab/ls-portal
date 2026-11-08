/**
 * Видеозвонки чатов — уборка (фоновый цикл сервера портала, раз в 15 с):
 * `chat_call_sweep` закрывает звонки по срокам (не ответили 45 с, окно
 * звонка молчит 75 с — db/migrations/2026-11-08_zzz_chat_calls.sql) и отдаёт
 * комнаты оконченных — их удаляем в Kinescope. Ошибка — в лог, следующий
 * проход повторит. Без ключа Kinescope или сервис-ключа не запускается;
 * `PUSH_WORKER=off` — уборку ведёт другой сервер.
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";
import { deleteSpeakRoom, kinescopeConfigured } from "./kinescope.server";

const TICK_MS = 15_000;

const g = globalThis as typeof globalThis & {
  __chatCallSweep?: { started: boolean; running: boolean };
};
const state = (g.__chatCallSweep ??= { started: false, running: false });

export function startChatCallSweep() {
  if (state.started || !hasSupabaseAdmin() || !kinescopeConfigured()) return;
  if (process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setInterval(() => void runChatCallSweep(), TICK_MS);
}

export async function runChatCallSweep(): Promise<void> {
  if (state.running) return;
  state.running = true;
  const admin = getSupabaseAdmin();
  try {
    const { data, error } = await admin.rpc("chat_call_sweep");
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { call_id: string; room_id: string }[]) {
      try {
        await deleteSpeakRoom(row.room_id);
        const { error: doneError } = await admin.rpc("chat_call_room_deleted", {
          p_call: row.call_id,
        });
        if (doneError) throw new Error(doneError.message);
      } catch (e) {
        console.error("[chat-calls] комната", row.room_id, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("[chat-calls]", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}
