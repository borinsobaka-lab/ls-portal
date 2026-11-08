/**
 * Задачи — фоновый цикл сервера портала (сервис-ключ, TASKS_CHATS_PLAN.md,
 * веха 3): раз в минуту `task_tick` — «срок через час», «просрочена» (один
 * раз), свои напоминания, сводка постановщику раз в день; раз в 6 часов —
 * производственный календарь из isdayoff.ru (текущий год, с октября — и
 * следующий), если его ещё нет в базе. Там же раз в минуту — поздравления с
 * днём рождения (`people_birthday_tick`) и напоминания календаря (`cal_tick`). `PUSH_WORKER=off` выключает цикл
 * (как рассылку пушей).
 */
import { getSupabaseAdmin, hasSupabaseAdmin } from "@/integrations/supabase/client.server";

import { parseIsDayOff } from "./work-calendar";

const TICK_MS = 60_000;
const CALENDAR_MS = 6 * 60 * 60 * 1000;
const CALENDAR_ORIGIN = process.env.WORK_CALENDAR_ORIGIN || "https://isdayoff.ru";

const g = globalThis as typeof globalThis & {
  __portalTaskWorker?: { started: boolean; busy: boolean };
};
const state = (g.__portalTaskWorker ??= { started: false, busy: false });

export function startTaskWorker() {
  if (state.started || !hasSupabaseAdmin() || process.env.PUSH_WORKER === "off") return;
  state.started = true;
  setTimeout(() => void loadWorkCalendar(), 30_000);
  setInterval(() => void loadWorkCalendar(), CALENDAR_MS);
  setInterval(() => void runTaskTick(), TICK_MS);
}

export async function runTaskTick(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    const { error } = await getSupabaseAdmin().rpc("task_tick");
    if (error) console.error("task_tick:", error.message);
    // Поздравления с днём рождения коллегам по подразделению (с 9:00 их пояса).
    const { error: bdError } = await getSupabaseAdmin().rpc("people_birthday_tick");
    if (bdError) console.error("people_birthday_tick:", bdError.message);
    // Напоминания о событиях календаря (db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql).
    const { error: calError } = await getSupabaseAdmin().rpc("cal_tick");
    if (calError) console.error("cal_tick:", calError.message);
  } catch (e) {
    console.error("task_tick:", e);
  } finally {
    state.busy = false;
  }
}

/** Годы, которых нет в базе: текущий и (с октября) следующий. */
export function yearsToLoad(loaded: number[], now = new Date()): number[] {
  const year = now.getUTCFullYear();
  const want = now.getUTCMonth() >= 9 ? [year, year + 1] : [year];
  return want.filter((y) => !loaded.includes(y));
}

export async function loadWorkCalendar(): Promise<void> {
  const admin = getSupabaseAdmin();
  try {
    const { data, error } = await admin.rpc("work_calendar_years_loaded");
    if (error) throw new Error(error.message);
    for (const year of yearsToLoad((data as number[] | null) ?? [])) {
      const res = await fetch(`${CALENDAR_ORIGIN}/api/getdata?year=${year}&pre=1`, {
        signal: AbortSignal.timeout(15_000),
      });
      // Следующего года ещё может не быть (постановление выходит осенью).
      if (!res.ok) continue;
      const days = parseIsDayOff(year, await res.text());
      if (!days) continue;
      const { error: storeError } = await admin.rpc("work_calendar_store", {
        p_year: year,
        p_days: days,
        p_source: new URL(CALENDAR_ORIGIN).host,
      });
      if (storeError) throw new Error(storeError.message);
    }
  } catch (e) {
    // Нет календаря — портал считает выходными субботу и воскресенье.
    console.error("work calendar:", e);
  }
}
