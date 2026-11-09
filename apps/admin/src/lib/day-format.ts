/**
 * Дни и время для полей «Дата» и «Время» (`components/ui/date-field.tsx`):
 * YYYY-MM-DD ↔ Date в часах компьютера, подпись «вт, 11 нояб.», шкала времени.
 */
export const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = [
  "янв.",
  "февр.",
  "марта",
  "апр.",
  "мая",
  "июня",
  "июля",
  "авг.",
  "сент.",
  "окт.",
  "нояб.",
  "дек.",
];

/** «вт, 11 нояб.» (другой год — с годом). */
export function dayLabel(day: string, today = new Date()): string {
  const d = dateOf(day);
  const year = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** Частые часы — сверху списка времени. */
export const COMMON_TIMES = ["09:00", "10:00", "12:00", "15:00", "18:00"];

export function timeSlots(step: 15 | 30, extra: string[] = []): string[] {
  const set = new Set<string>(extra.filter(Boolean));
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += step) set.add(`${pad(h)}:${pad(m)}`);
  return [...set].sort();
}
