/**
 * Даты для AI-ассистента. Сервер работает в UTC, а «сегодня» и границы суток
 * считаются по времени студии (Тбилиси, UTC+4, без перехода на летнее время).
 */
export const STUDIO_TIME_ZONE = "Asia/Tbilisi";
const STUDIO_UTC_OFFSET = "+04:00";

/** Сегодняшняя дата студии (YYYY-MM-DD). */
export function studioToday(now: Date = new Date()) {
  // en-CA форматирует дату как YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TIME_ZONE }).format(now);
}

/** Дата студии со сдвигом на `days` дней (YYYY-MM-DD). */
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Начало суток студии как момент времени — граница для timestamptz-колонок. */
export function studioDayStart(date: string) {
  return `${date}T00:00:00${STUDIO_UTC_OFFSET}`;
}
