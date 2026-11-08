/**
 * Подключён ли Realtime (личная тема `user:<id>`): от этого зависит, как
 * часто опрашивать базу — с живым соединением реже.
 */
import { useSyncExternalStore } from "react";

let connected = false;
const listeners = new Set<() => void>();

export function setRealtimeConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  listeners.forEach((l) => l());
}

export function isRealtimeConnected() {
  return connected;
}

export function useRealtimeConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connected,
    () => false,
  );
}

// ---- События для открытого окна (печатает, прочитал) ----------------------

export type ChatEvent = {
  type:
    | "message"
    | "edit"
    | "delete"
    | "react"
    | "pin"
    | "read"
    | "members"
    | "chat"
    | "removed"
    | "call";
  chat_id: string;
  /** Видеозвонок (type = call). */
  call_id?: string;
  seq?: number;
  user_id?: string;
};

const eventListeners = new Set<(e: ChatEvent) => void>();

export function emitChatEvent(e: ChatEvent) {
  eventListeners.forEach((l) => l(e));
}

export function onChatEvent(l: (e: ChatEvent) => void) {
  eventListeners.add(l);
  return () => {
    eventListeners.delete(l);
  };
}
