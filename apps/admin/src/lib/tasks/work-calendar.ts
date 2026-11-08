/**
 * Производственный календарь России (TASKS_CHATS_PLAN.md, 4.4): дни —
 * рабочий, выходной, сокращённый. Источник — isdayoff.ru
 * (`/api/getdata?year=Y&pre=1`: строка цифр на каждый день года, 0 —
 * рабочий, 1 — выходной, 2 — сокращённый, 4 — рабочий особый), хранит база
 * (`work_calendar`). Дня нет в базе — суббота и воскресенье выходные.
 */
export type DayKind = "work" | "off" | "short";

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** Ответ isdayoff.ru за год — строка для базы или null (ошибка, не тот год). */
export function parseIsDayOff(year: number, body: string): string | null {
  const text = body.trim();
  if (text.length !== daysInYear(year) || !/^[0124]+$/.test(text)) return null;
  return text;
}

/** «2026-01-09» — локальная дата календаря (без часового пояса). */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Вид дня: из календаря, иначе по дню недели. */
export function dayKind(day: string, calendar: ReadonlyMap<string, DayKind>): DayKind {
  const known = calendar.get(day);
  if (known) return known;
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6 ? "off" : "work";
}
