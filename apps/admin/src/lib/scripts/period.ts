/**
 * Период для статистики: даты по часам браузера (тбилисское время) и
 * готовые отрезки «сегодня / 7 дней / 30 дней / всё время».
 *
 * В поле даты — YYYY-MM-DD; в запрос уходит ISO начала дня, поэтому
 * «сегодня» — это тбилисское сегодня, а не UTC.
 */

/** Локальная дата YYYY-MM-DD n дней назад (не toISOString — он в UTC). */
export function daysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Начало дня по местному времени в ISO; shift=1 — следующий день («по дату включительно»). */
export function dayStart(value: string, shift = 0): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + shift).toISOString();
}

export type Period = {
  /** Пусто — без нижней границы. */
  from: string;
  to: string;
};

export const PERIOD_PRESETS = [
  { key: "today", label: "Сегодня", from: () => daysAgo(0) },
  { key: "7", label: "7 дней", from: () => daysAgo(6) },
  { key: "30", label: "30 дней", from: () => daysAgo(29) },
  { key: "all", label: "Всё время", from: () => "" },
] as const;

/** Последние 30 дней — считается при открытии: вкладка может жить дольше суток. */
export function defaultPeriod(): Period {
  return { from: daysAgo(29), to: daysAgo(0) };
}

/** Какой отрезок выбран сейчас; пусто — даты заданы руками. */
export function activePreset(p: Period): string {
  return PERIOD_PRESETS.find((x) => x.from() === p.from && p.to === daysAgo(0))?.key ?? "";
}

/** Границы периода для запроса; null — без границы. */
export function periodBounds(p: Period): { from: string | null; to: string | null } {
  return { from: p.from ? dayStart(p.from) : null, to: p.to ? dayStart(p.to, 1) : null };
}
