/**
 * Видеозвонки чатов — браузер (db/migrations/2026-11-08_zzz_chat_calls.sql,
 * сервер — lib/chats/calls.functions.ts, окно — components/chats/call-layer.tsx).
 *
 * - Входящие — ["chat_call_incoming"] (опрос; с Realtime — по событию
 *   `call`), идущий звонок чата — ["chat_call_active", chatId], мой звонок —
 *   ["chat_call", callId] (раз в 20 с — «я в звонке», chat_call_ping).
 * - Звонок этой вкладки — одно на вкладку состояние `useActiveCall`
 *   (окно звонка над порталом: переходы по разделам его не закрывают).
 * - Звук: входящий — мелодия, исходящий — гудки (Web Audio, без файлов).
 *   Браузер даёт звук после первого нажатия на странице — `unlockCallAudio`.
 */
import { useSyncExternalStore } from "react";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/integrations/supabase/env";
import { unwrap } from "@/lib/query";
import type { CallEndReason, CallMemberState } from "./call-logic";
import { startChatCall } from "./calls.functions";
import type { ChatKind } from "./types";

export type CallJson = {
  id: string;
  chat_id: string;
  chat_kind: ChatKind;
  chat_title: string | null;
  started_by: string | null;
  created_at: string;
  ready: boolean;
  link: string | null;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: CallEndReason | null;
  my_state: CallMemberState | null;
  members: { user_id: string; state: CallMemberState }[];
};

export type CallStart = { call: CallJson; link: string | null };

const rpc = async <T>(fn: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(fn, args));

// ---- Запросы ---------------------------------------------------------------

export const incomingCallsQuery = queryOptions({
  queryKey: ["chat_call_incoming"],
  queryFn: async () => (await rpc<CallJson[] | null>("chat_call_incoming")) ?? [],
});

export const activeChatCallQuery = (chatId: string) =>
  queryOptions({
    queryKey: ["chat_call_active", chatId],
    queryFn: () => rpc<CallJson | null>("chat_call_active", { p_chat: chatId }),
  });

/** Мой звонок: заодно отмечает «я в звонке». */
export const myCallQuery = (callId: string) =>
  queryOptions({
    queryKey: ["chat_call", callId],
    queryFn: () => rpc<CallJson>("chat_call_ping", { p_call: callId }),
  });

export const joinCall = (callId: string) =>
  rpc<{ call: CallJson; link: string }>("chat_call_join", { p_call: callId });
export const declineCall = (callId: string) =>
  rpc<CallJson>("chat_call_decline", { p_call: callId });
export const leaveCall = (callId: string) => rpc<CallJson>("chat_call_leave", { p_call: callId });

/** Событие `call` (Realtime) — дозапрос того, что о звонках на экране. */
export function invalidateCalls(qc: QueryClient, chatId?: string, callId?: string) {
  void qc.invalidateQueries({ queryKey: ["chat_call_incoming"] });
  if (chatId) void qc.invalidateQueries({ queryKey: ["chat_call_active", chatId] });
  if (callId) void qc.invalidateQueries({ queryKey: ["chat_call", callId] });
}

// ---- Звонок этой вкладки ---------------------------------------------------

export type ActiveCall = {
  callId: string;
  chatId: string;
  link: string;
  /** Окно свёрнуто в угол. */
  minimized: boolean;
  /** Открыт в отдельной вкладке (iframe не грузим, чтобы не войти дважды). */
  external: boolean;
};

let active: ActiveCall | null = null;
const listeners = new Set<() => void>();

export function setActiveCall(next: ActiveCall | null) {
  active = next;
  listeners.forEach((l) => l());
}

export function patchActiveCall(patch: Partial<ActiveCall>) {
  if (active) setActiveCall({ ...active, ...patch });
}

export function getActiveCall() {
  return active;
}

export function useActiveCall(): ActiveCall | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
    () => null,
  );
}

/**
 * Начать звонок в чате (или присоединиться к идущему). Комнату создаёт
 * сервер; если её создаёт другой участник — ждём ссылку до 20 секунд.
 */
export async function startCall(qc: QueryClient, chatId: string): Promise<CallJson> {
  const current = getActiveCall();
  if (current && current.chatId !== chatId) await leaveCall(current.callId).catch(() => {});
  const started = await startChatCall({ data: { chatId } });
  let { call, link } = started;
  for (let i = 0; !link && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    call = await rpc<CallJson>("chat_call_get", { p_call: call.id });
    if (call.ended_at) throw new Error("chat_call_ended");
    link = call.link;
  }
  if (!link) throw new Error("chat_call_not_ready");
  if (!call.ready) call = { ...call, ready: true, link };
  qc.setQueryData(myCallQuery(call.id).queryKey, call);
  setActiveCall({ callId: call.id, chatId, link, minimized: false, external: false });
  invalidateCalls(qc, chatId);
  return call;
}

/** Принять входящий: выходим из текущего звонка, входим в новый. */
export async function acceptCall(qc: QueryClient, call: CallJson): Promise<void> {
  const current = getActiveCall();
  if (current && current.callId !== call.id) await leaveCall(current.callId).catch(() => {});
  const joined = await joinCall(call.id);
  qc.setQueryData(myCallQuery(call.id).queryKey, joined.call);
  setActiveCall({
    callId: call.id,
    chatId: call.chat_id,
    link: joined.link,
    minimized: false,
    external: false,
  });
  invalidateCalls(qc, call.chat_id);
}

/** Закрытие вкладки: выйти из звонка запросом, который переживёт страницу. */
export function leaveOnUnload(callId: string, accessToken: string | null) {
  if (!accessToken || !SUPABASE_URL) return;
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/chat_call_leave`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_call: callId }),
    });
  } catch {
    // Не вышло — звонок закроет срок (75 с без отметки).
  }
}

// ---- Звук ------------------------------------------------------------------

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audio ??= new Ctor();
  return audio;
}

/** Первое нажатие на странице — разрешить звук звонка (правило браузеров). */
export function unlockCallAudio() {
  const ctx = context();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

function beep(ctx: AudioContext, at: number, freq: number, length: number, volume: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.02);
  gain.gain.setValueAtTime(volume, at + length - 0.04);
  gain.gain.linearRampToValueAtTime(0, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/**
 * Входящий — три ноты вверх дважды, раз в 2,5 с; исходящий — гудок 425 Гц
 * 1 с через 4 с (как в телефонной сети). Возвращает «выключить».
 */
export function startCallTone(kind: "incoming" | "outgoing"): () => void {
  const ctx = context();
  if (!ctx) return () => {};
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  const play = () => {
    if (ctx.state !== "running") return;
    const t = ctx.currentTime + 0.05;
    if (kind === "incoming") {
      [0, 0.6].forEach((offset) =>
        [784, 988, 1319].forEach((f, i) => beep(ctx, t + offset + i * 0.16, f, 0.15, 0.18)),
      );
    } else {
      beep(ctx, t, 425, 1, 0.08);
    }
  };
  play();
  const timer = window.setInterval(play, kind === "incoming" ? 2500 : 4000);
  return () => window.clearInterval(timer);
}
