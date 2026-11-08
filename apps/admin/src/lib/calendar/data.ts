/**
 * Календарь — запросы и кэш (RPC `cal_*`,
 * db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql). Ключи ["cal", …]: после
 * записи — invalidateCalendar; событие Realtime «calendar» в личной теме
 * (lib/chats/realtime.ts) делает то же, без соединения — опрос.
 *
 * Какие календари и слои показаны — у каждого человека в браузере
 * (localStorage: это удобство, не данные).
 */
import { keepPreviousData, queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useRealtimeConnected } from "@/lib/chats/realtime-state";
import { unwrap } from "@/lib/query";
import type {
  CalEvent,
  CalInvite,
  CalLayer,
  CalOccurrence,
  CalOverlays,
  CalSourceOptions,
  Calendar,
  CalendarFull,
  Response,
} from "./types";

export async function calRpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  return (await unwrap<T>(supabase.rpc(fn, args))) as T;
}

export const invalidateCalendar = (qc: QueryClient) => qc.invalidateQueries({ queryKey: ["cal"] });

// ---- Чтение ----------------------------------------------------------------------------

export const calendarsQuery = queryOptions({
  queryKey: ["cal", "calendars"],
  queryFn: async () => (await calRpc<Calendar[] | null>("cal_calendars_list")) ?? [],
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить календари" },
});

export function useCalendarEvents(from: string | null, to: string | null, calendars: string[]) {
  const live = useRealtimeConnected();
  const ids = [...calendars].sort();
  return useQuery({
    queryKey: ["cal", "range", from, to, ids.join(",")],
    queryFn: async () =>
      (await calRpc<CalOccurrence[] | null>("cal_events_range", {
        p_from: from,
        p_to: to,
        p_calendars: ids,
      })) ?? [],
    enabled: !!from && !!to,
    placeholderData: keepPreviousData,
    refetchInterval: live ? 120_000 : 30_000,
    meta: { errorMessage: "Не удалось загрузить события" },
  });
}

export function useCalendarOverlays(from: string | null, to: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["cal", "overlays", from, to],
    queryFn: () => calRpc<CalOverlays>("cal_overlays", { p_from: from, p_to: to }),
    enabled: enabled && !!from && !!to,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export const calEventQuery = (id: string, occ: string | null) =>
  queryOptions({
    queryKey: ["cal", "event", id, occ],
    queryFn: () => calRpc<CalEvent>("cal_event_get", { p_id: id, p_occ: occ }),
    retry: false,
  });

export function useCalCounters(enabled = true) {
  const live = useRealtimeConnected();
  const { data } = useQuery({
    queryKey: ["cal", "counters"],
    queryFn: () => calRpc<{ invites: number }>("cal_counters"),
    refetchInterval: live ? 300_000 : 60_000,
    refetchOnWindowFocus: true,
    enabled,
  });
  return data ?? { invites: 0 };
}

export const calInvitesQuery = queryOptions({
  queryKey: ["cal", "invites"],
  queryFn: async () => (await calRpc<CalInvite[] | null>("cal_invites")) ?? [],
});

export const calendarQuery = (id: string) =>
  queryOptions({
    queryKey: ["cal", "calendar", id],
    queryFn: () => calRpc<CalendarFull>("cal_calendar_get", { p_id: id }),
  });

export const calSourceOptionsQuery = queryOptions({
  queryKey: ["cal", "source-options"],
  queryFn: () => calRpc<CalSourceOptions>("cal_source_options"),
  staleTime: 5 * 60_000,
});

// ---- Запись ----------------------------------------------------------------------------

export async function saveEvent(qc: QueryClient, id: string | null, p: Record<string, unknown>) {
  const r = await calRpc<string>("cal_event_save", { p_id: id, p });
  void invalidateCalendar(qc);
  return r;
}

export async function saveOccurrence(
  qc: QueryClient,
  id: string,
  occ: string,
  p: Record<string, unknown>,
) {
  const r = await calRpc<string>("cal_event_occurrence_save", { p_id: id, p_occ: occ, p });
  void invalidateCalendar(qc);
  return r;
}

export async function deleteEvent(qc: QueryClient, id: string, occ: string | null) {
  await calRpc("cal_event_delete", { p_id: id, p_occ: occ });
  void invalidateCalendar(qc);
}

export async function respondEvent(
  qc: QueryClient,
  id: string,
  response: Exclude<Response, "pending">,
) {
  await calRpc("cal_event_respond", { p_id: id, p_response: response });
  void invalidateCalendar(qc);
}

export async function saveMyReminders(qc: QueryClient, id: string, minutes: number[] | null) {
  await calRpc("cal_event_my_reminders", { p_id: id, p_minutes: minutes });
  void invalidateCalendar(qc);
}

export async function openEventChat(qc: QueryClient, id: string) {
  const chatId = await calRpc<string>("cal_event_chat_open", { p_id: id });
  void invalidateCalendar(qc);
  void qc.invalidateQueries({ queryKey: ["chat_list"] });
  return chatId;
}

export async function saveCalendar(qc: QueryClient, id: string | null, p: Record<string, unknown>) {
  const r = await calRpc<string>("cal_calendar_save", { p_id: id, p });
  void invalidateCalendar(qc);
  return r;
}

export async function deleteCalendar(qc: QueryClient, id: string) {
  await calRpc("cal_calendar_delete", { p_id: id });
  void invalidateCalendar(qc);
}

// ---- Что показано (в браузере человека) ------------------------------------------------

type Prefs = { hidden: string[]; layers: Record<CalLayer, boolean> };
const PREFS_KEY = "calendar_prefs";
const DEFAULT_PREFS: Prefs = {
  hidden: [],
  layers: { tasks: true, birthdays: true, absences: true },
};

let prefs: Prefs | null = null;
const listeners = new Set<() => void>();

function readPrefs(): Prefs {
  if (prefs) return prefs;
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    prefs = {
      hidden: Array.isArray(p.hidden) ? p.hidden.filter((x) => typeof x === "string") : [],
      layers: { ...DEFAULT_PREFS.layers, ...(p.layers ?? {}) },
    };
  } catch {
    prefs = DEFAULT_PREFS;
  }
  return prefs;
}

function writePrefs(next: Prefs) {
  prefs = next;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // приватный режим — настройка живёт до перезагрузки
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCalendarPrefs() {
  const p = useSyncExternalStore(subscribe, readPrefs, () => DEFAULT_PREFS);
  const toggleCalendar = useCallback((id: string) => {
    const cur = readPrefs();
    writePrefs({
      ...cur,
      hidden: cur.hidden.includes(id) ? cur.hidden.filter((x) => x !== id) : [...cur.hidden, id],
    });
  }, []);
  const showCalendar = useCallback((id: string) => {
    const cur = readPrefs();
    if (cur.hidden.includes(id)) writePrefs({ ...cur, hidden: cur.hidden.filter((x) => x !== id) });
  }, []);
  const toggleLayer = useCallback((layer: CalLayer) => {
    const cur = readPrefs();
    writePrefs({ ...cur, layers: { ...cur.layers, [layer]: !cur.layers[layer] } });
  }, []);
  return { ...p, toggleCalendar, showCalendar, toggleLayer };
}
