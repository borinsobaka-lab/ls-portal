/**
 * Зарплаты сотрудников пакетных студий (раздел рейки «Сотрудники»):
 * периоды выплат и сводка по строкам расчёта. Без React — модуль читают
 * страницы «Зарплаты» и «График администраторов» и тест payroll.test.ts.
 *
 * Строки считает база — RPC payroll_lines
 * (db/migrations/2026-10-11_zzz_staff_payroll.sql): смены администратора,
 * проведённые занятия по «Зарплатным ставкам» и продажи, по всем пакетным
 * студиям сотрудника. Здесь — только суммы за выбранный период: бонус 5 %
 * с продаж, корректировки, итог.
 *
 * Выплаты дважды в месяц: 20-го — аванс за 1–19, 1-го числа следующего
 * месяца — основная часть за 20–конец месяца.
 */

export type PayrollLineKind = "shift" | "group" | "personal" | "other" | "sale";

/** Строка RPC payroll_lines: сотрудник × день × студия × вид (× название). */
export type PayrollLine = {
  trainer_id: string;
  work_date: string;
  studio_id: string;
  studio_name: string;
  kind: PayrollLineKind;
  /** Название прочей активности (kind = other). */
  title: string | null;
  units: number;
  /** Деньги за строку; у продаж — поступившие за день платежи (бонус считается отдельно). */
  amount: number;
};

export type AdjustmentKind = "bonus" | "deduction";

export const ADJUSTMENT_KINDS: Record<AdjustmentKind, { label: string; sign: 1 | -1 }> = {
  deduction: { label: "Вычет", sign: -1 },
  bonus: { label: "Надбавка", sign: 1 },
};

export type PayrollAdjustment = {
  id: string;
  trainer_id: string;
  kind: AdjustmentKind;
  amount: number;
  adjusted_on: string;
  reason: string;
  created_by_name: string | null;
  created_at: string;
};

export type PayrollPayout = {
  trainer_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  paid_at: string;
  paid_by_name: string | null;
};

export const BONUS_RATE = 0.05;

const PAY_FORMAT = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "GEL",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Зарплатные суммы: копейки только когда они есть (235,9 — бонус с продаж), без «,00». */
export function formatPay(n: number) {
  return PAY_FORMAT.format(n);
}

/** Деньги с копейками без плавающих хвостов (0.1 + 0.2). */
export const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Месяцы и периоды ---------------------------------------------------------

/** Месяц — строка YYYY-MM; даты — YYYY-MM-DD (сравниваются как строки). */
export type MonthKey = string;

const pad = (n: number) => String(n).padStart(2, "0");

export function monthOf(dateISO: string): MonthKey {
  return dateISO.slice(0, 7);
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function daysInMonth(month: MonthKey): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthBounds(month: MonthKey): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
}

/** Дни месяца с днём недели (0 — воскресенье) — для графика смен. */
export function monthDays(month: MonthKey): { date: string; day: number; weekday: number }[] {
  const [y, m] = month.split("-").map(Number);
  return Array.from({ length: daysInMonth(month) }, (_, i) => ({
    date: `${month}-${pad(i + 1)}`,
    day: i + 1,
    weekday: new Date(y, m - 1, i + 1).getDay(),
  }));
}

const MONTH_NAME = new Intl.DateTimeFormat("ru-RU", { month: "long" });
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «Октябрь» — именительный падеж (standalone в ru-RU). */
export function monthName(month: MonthKey): string {
  const [y, m] = month.split("-").map(Number);
  return capitalize(MONTH_NAME.format(new Date(y, m - 1, 1)));
}

/** «Октябрь 2026». */
export function monthLabel(month: MonthKey): string {
  return `${monthName(month)} ${month.slice(0, 4)}`;
}

/** advance — аванс 1–19, main — основная 20–конец, month — весь месяц. */
export type PeriodKey = "advance" | "main" | "month";

export const ADVANCE_LAST_DAY = 19;

export function periodRange(month: MonthKey, period: PeriodKey): { from: string; to: string } {
  const { from, to } = monthBounds(month);
  if (period === "advance") return { from, to: `${month}-${pad(ADVANCE_LAST_DAY)}` };
  if (period === "main") return { from: `${month}-${pad(ADVANCE_LAST_DAY + 1)}`, to };
  return { from, to };
}

export function periodLabel(month: MonthKey, period: PeriodKey): string {
  if (period === "advance") return `Аванс 1–${ADVANCE_LAST_DAY}`;
  if (period === "main") return `Основная ${ADVANCE_LAST_DAY + 1}–${daysInMonth(month)}`;
  return "Весь месяц";
}

/** «Октябрь 1–19, 2026» — как в шапке карточки сотрудника. */
export function periodTitle(month: MonthKey, period: PeriodKey): string {
  const { from, to } = periodRange(month, period);
  return `${monthName(month)} ${Number(from.slice(8))}–${Number(to.slice(8))}, ${month.slice(0, 4)}`;
}

/** День выплаты: аванс — 20-го этого месяца, основная — 1-го следующего. */
export function payDate(month: MonthKey, period: PeriodKey): string | null {
  if (period === "advance") return `${month}-${pad(ADVANCE_LAST_DAY + 1)}`;
  if (period === "main") return `${addMonths(month, 1)}-01`;
  return null;
}

/**
 * Период, который открывать по умолчанию, — ближайшая выплата: 1-го числа —
 * основная за прошлый месяц, со 2-го по 20-е — аванс, дальше — основная.
 */
export function defaultPeriod(todayISO: string): { month: MonthKey; period: PeriodKey } {
  const month = monthOf(todayISO);
  const day = Number(todayISO.slice(8, 10));
  if (day === 1) return { month: addMonths(month, -1), period: "main" };
  return { month, period: day <= ADVANCE_LAST_DAY + 1 ? "advance" : "main" };
}

/** Половины месяца, из которых складывается период (выплаты отмечаются по ним). */
export function payoutPeriods(month: MonthKey, period: PeriodKey): { from: string; to: string }[] {
  return period === "month"
    ? [periodRange(month, "advance"), periodRange(month, "main")]
    : [periodRange(month, period)];
}

// --- Сводка ---------------------------------------------------------------------

export type PayrollSummary = {
  /** Оклад: смены + занятия. */
  base: number;
  shifts: number;
  groups: number;
  personals: number;
  others: number;
  sales: number;
  salesCount: number;
  bonus: number;
  /** Корректировки со знаком. */
  adjustments: number;
  total: number;
};

export const EMPTY_SUMMARY: PayrollSummary = {
  base: 0,
  shifts: 0,
  groups: 0,
  personals: 0,
  others: 0,
  sales: 0,
  salesCount: 0,
  bonus: 0,
  adjustments: 0,
  total: 0,
};

const inRange = (date: string, r: { from: string; to: string }) => date >= r.from && date <= r.to;

/** Сводка по сотрудникам за период [from, to]. */
export function summarize(
  lines: PayrollLine[],
  adjustments: PayrollAdjustment[],
  range: { from: string; to: string },
): Map<string, PayrollSummary> {
  const out = new Map<string, PayrollSummary>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = { ...EMPTY_SUMMARY };
      out.set(id, s);
    }
    return s;
  };

  for (const l of lines) {
    if (!inRange(l.work_date, range)) continue;
    const s = get(l.trainer_id);
    const amount = Number(l.amount) || 0;
    switch (l.kind) {
      case "sale":
        s.sales += amount;
        s.salesCount += l.units;
        continue;
      case "shift":
        s.shifts += l.units;
        break;
      case "group":
        s.groups += l.units;
        break;
      case "personal":
        s.personals += l.units;
        break;
      case "other":
        s.others += l.units;
        break;
    }
    s.base += amount;
  }

  for (const a of adjustments) {
    if (!inRange(a.adjusted_on, range)) continue;
    get(a.trainer_id).adjustments += ADJUSTMENT_KINDS[a.kind].sign * (Number(a.amount) || 0);
  }

  for (const s of out.values()) {
    s.base = round2(s.base);
    s.sales = round2(s.sales);
    s.bonus = round2(s.sales * BONUS_RATE);
    s.adjustments = round2(s.adjustments);
    s.total = round2(s.base + s.bonus + s.adjustments);
  }
  return out;
}

/** Короткая подпись оклада: «10 смен», «12 гр. · 3 перс.». */
export function workSummary(s: PayrollSummary): string {
  const parts: string[] = [];
  if (s.shifts) parts.push(`${s.shifts} ${plural(s.shifts, ["смена", "смены", "смен"])}`);
  if (s.groups) parts.push(`${s.groups} гр.`);
  if (s.personals) parts.push(`${s.personals} перс.`);
  if (s.others) parts.push(`${s.others} проч.`);
  return parts.join(" · ");
}

export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** Короткое обозначение студии для строк тренировок: «Ваке» → «В», «Old Town» → «OT». */
export function studioAbbr(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

/**
 * Обозначения студий без совпадений: при одинаковых первых буквах — больше
 * букв названия («Ваке» / «Варкетили» → «Вак» / «Вар»).
 */
export function studioAbbrs(names: string[]): Map<string, string> {
  const unique = [...new Set(names)];
  const out = new Map<string, string>();
  for (const name of unique) {
    const base = studioAbbr(name);
    const clash = unique.some((other) => other !== name && studioAbbr(other) === base);
    if (!clash) {
      out.set(name, base);
      continue;
    }
    let len = 2;
    const short = (n: string) => n.replace(/\s+/g, "").slice(0, len);
    while (
      len < name.length &&
      unique.some(
        (other) => other !== name && short(other).toLowerCase() === short(name).toLowerCase(),
      )
    )
      len++;
    out.set(name, short(name));
  }
  return out;
}
