/**
 * Дни рождения и отсутствия сотрудников (TASKS_CHATS_PLAN.md, этап 2: 3.7,
 * 8.8) — подписи и даты без React. Схема —
 * db/migrations/2026-11-08_zzzzzzzz_people_birthdays_absences.sql.
 */

export type AbsenceKind = "vacation" | "sick" | "trip" | "dayoff" | "other";

export type Absence = {
  id: string;
  user_id: string;
  kind: AbsenceKind;
  /** YYYY-MM-DD, включительно. */
  starts_on: string;
  ends_on: string;
  note: string | null;
  can_edit: boolean;
};

export type UpcomingBirthday = { user_id: string; date: string; age: number | null };

export type BirthdayInfo = {
  /** MM-DD или null — не указан. */
  day: string | null;
  year: number | null;
  show_year: boolean;
  can_edit: boolean;
};

export const ABSENCE_KIND_LABEL: Record<AbsenceKind, string> = {
  vacation: "Отпуск",
  sick: "Больничный",
  trip: "Командировка",
  dayoff: "Отгул",
  other: "Другое",
};

/** «в отпуске», «на больничном»… — для строки «… до 15 ноября». */
const ABSENCE_STATE: Record<AbsenceKind, string> = {
  vacation: "в отпуске",
  sick: "на больничном",
  trip: "в командировке",
  dayoff: "отгул",
  other: "нет на месте",
};

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** «15 ноября» из YYYY-MM-DD или MM-DD. */
export function dayMonth(date: string): string {
  const parts = date.split("-").map(Number);
  const [m, d] = parts.length === 3 ? [parts[1], parts[2]] : [parts[0], parts[1]];
  return `${d} ${MONTHS[m - 1]}`;
}

/** «18–20 ноября», «28 ноября — 3 декабря», «25 ноября». */
export function absencePeriod(from: string, to: string): string {
  if (from === to) return dayMonth(from);
  const [, m1, d1] = from.split("-").map(Number);
  const [, m2, d2] = to.split("-").map(Number);
  if (m1 === m2) return `${d1}–${d2} ${MONTHS[m2 - 1]}`;
  return `${dayMonth(from)} — ${dayMonth(to)}`;
}

/** Сегодня в браузере, YYYY-MM-DD. */
export function localISO(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + days));
}

/** Отсутствие человека, которое идёт в этот день (или первое пересекающее период). */
export function absenceOn(
  list: Absence[],
  userId: string,
  from: string,
  to: string = from,
): Absence | null {
  return (
    list
      .filter((a) => a.user_id === userId && a.ends_on >= from && a.starts_on <= to)
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0] ?? null
  );
}

/** «в отпуске до 15 ноября», «в отпуске с 20 по 25 ноября», «отгул 12 ноября». */
export function absenceText(a: Absence, today: string): string {
  const state = ABSENCE_STATE[a.kind];
  if (a.starts_on === a.ends_on) return `${state} ${dayMonth(a.starts_on)}`;
  if (a.starts_on <= today) return `${state} до ${dayMonth(a.ends_on)}`;
  return `${state} с ${dayMonth(a.starts_on)} по ${dayMonth(a.ends_on)}`;
}

/** «сегодня», «завтра», «в пятницу, 14 ноября». */
export function birthdayWhen(date: string, today: string): string {
  if (date === today) return "сегодня";
  if (date === addDaysISO(today, 1)) return "завтра";
  const [y, m, d] = date.split("-").map(Number);
  const wd = [
    "в воскресенье",
    "в понедельник",
    "во вторник",
    "в среду",
    "в четверг",
    "в пятницу",
    "в субботу",
  ][new Date(y, m - 1, d).getDay()];
  return `${wd}, ${dayMonth(date)}`;
}

/** «30 лет», «41 год», «22 года». */
export function ageText(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word =
    m10 === 1 && m100 !== 11
      ? "год"
      : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
        ? "года"
        : "лет";
  return `${n} ${word}`;
}
