/**
 * VK Ads — «Планы таргета» (их app.py: `_plans_from_xlsx_sheet`,
 * `read_monthly_plan_xlsx`, `read_multi_month_plan_xlsx`, формы
 * target-plans/update): разбор Excel в браузере, числа форм — как их int() и
 * float(). Сохраняет RPC an_vk_plans_save (их save_monthly_plans).
 */
import { pyFloat } from "../onec/rules";
import { openWorkbook, pyStrip as strip, type Inflate } from "../onec/xlsx-read";
import { vkNumber } from "./view";

export const PLAN_FILE_MAX = 2 * 1024 * 1024;

export const MONTH_NAMES = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

export type PlanInput = { city: string; applications_plan: number; target_cpl: number };

/** Их _plans_from_xlsx_sheet по строкам листа (текст ячеек как в XML). */
export function plansFromRows(sheetRows: (string | null)[][]): PlanInput[] {
  const rows = sheetRows.filter((r) => r.some((v) => strip(v ?? "") !== ""));
  if (rows.length === 0) throw new Error("Файл плана пуст.");
  const headers = new Map<string, number>();
  rows[0].forEach((v, col) => {
    if (v !== null) headers.set(strip(v).toLowerCase(), col);
  });
  const city = headers.get("город");
  const apps = headers.get("заявки");
  const cpl = headers.get("стоимость заявки");
  if (city === undefined || apps === undefined || cpl === undefined) {
    throw new Error("В первой строке нужны колонки: Город, Заявки, Стоимость заявки.");
  }
  const out: PlanInput[] = [];
  rows.slice(1).forEach((values, i) => {
    const number = i + 2;
    const c = strip(values[city] ?? "");
    const a = strip((values[apps] ?? "").replace(/ /g, ""));
    const p = strip((values[cpl] ?? "").replace(/ /g, "").replace(/,/g, "."));
    if (!c && !a && !p) return;
    if (c && !a && !p) return;
    if (!c || !a || !p) {
      throw new Error(`Строка ${number}: заполните город, заявки и стоимость заявки.`);
    }
    const an = pyFloat(a);
    const pn = pyFloat(p);
    const pIsNan = Number.isNaN(pn) && !/^[+-]?nan$/i.test(p);
    if (!Number.isInteger(an) || pIsNan) {
      throw new Error(`Строка ${number}: заявки должны быть целым числом, стоимость — числом.`);
    }
    out.push({ city: c, applications_plan: an, target_cpl: pn });
  });
  return out;
}

async function openPlanBook(bytes: Uint8Array, inflate: Inflate) {
  if (bytes.length === 0 || bytes.length > PLAN_FILE_MAX) {
    throw new Error("Загрузите Excel-файл размером не больше 2 МБ.");
  }
  let book;
  try {
    book = await openWorkbook(bytes, inflate);
  } catch {
    throw new Error("Не удалось прочитать .xlsx-файл плана.");
  }
  if (book.sheets.length === 0) throw new Error("Не удалось прочитать лист Excel.");
  return book;
}

async function sheetRows(book: Awaited<ReturnType<typeof openWorkbook>>, index: number) {
  const sheet = await book.open(index, { raw: true });
  const rows: (string | null)[][] = [];
  for await (const row of sheet.rows()) {
    rows.push(row.cells.map((v) => (v === null ? null : String(v))));
  }
  return rows;
}

/** Их read_monthly_plan_xlsx: один лист, иначе — лист с названием месяца. */
export async function planFromXlsx(
  bytes: Uint8Array,
  month: string,
  inflate: Inflate,
): Promise<PlanInput[]> {
  const book = await openPlanBook(bytes, inflate);
  let index = 0;
  if (book.sheets.length !== 1) {
    const expected = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
    const names = new Set([expected, `${expected} ${month.slice(0, 4)}`]);
    const matches = book.sheets
      .map((s, i) => [strip(s.name).toLowerCase(), i] as const)
      .filter(([n]) => names.has(n));
    if (matches.length !== 1) {
      throw new Error(
        "Для обычной загрузки используйте файл с одним листом. В этом файле не удалось однозначно найти выбранный месяц.",
      );
    }
    index = matches[0][1];
  }
  return plansFromRows(await sheetRows(book, index));
}

/** Их read_multi_month_plan_xlsx: каждый лист — месяц года по названию. */
export async function plansFromMultiMonthXlsx(
  bytes: Uint8Array,
  year: number,
  inflate: Inflate,
): Promise<{ month: string; plans: PlanInput[] }[]> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error("Укажите корректный год планов.");
  }
  const book = await openPlanBook(bytes, inflate);
  const out: { month: string; plans: PlanInput[] }[] = [];
  for (const [i, sheet] of book.sheets.entries()) {
    const name = strip(sheet.name).toLowerCase();
    const matches = MONTH_NAMES.map((m, j) => [m, j + 1] as const).filter(
      ([m]) => name === m || name === `${m} ${year}`,
    );
    if (matches.length !== 1) throw new Error(`Лист «${sheet.name}» не является названием месяца.`);
    const month = `${year}-${String(matches[0][1]).padStart(2, "0")}`;
    if (out.some((x) => x.month === month)) throw new Error(`Месяц ${month} повторяется в файле.`);
    out.push({ month, plans: plansFromRows(await sheetRows(book, i)) });
  }
  if (out.length === 0) throw new Error("В файле не найдено листов с планами.");
  return out;
}

/**
 * Числа строки «Заявки и целевой CPL» и ручного плана: их int(value.strip())
 * и float(value.replace(",", ".").strip()). null — не число.
 */
export function formInt(v: string): number | null {
  const s = strip(v);
  if (!/^[+-]?\d(_?\d)*$/.test(s)) return null;
  return Number(s.replace(/_/g, ""));
}
export function formFloat(v: string): number | null {
  const n = pyFloat(v.replace(/,/g, "."));
  return Number.isNaN(n) ? null : n;
}

/** f"{x:g}" Python: 6 значащих цифр, без лишних нулей, порядок вне [-4, 6). */
export function pyG(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const exp = Number(x.toExponential(5).split("e")[1]);
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Number(e);
    return `${mant}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const fixed = x.toFixed(Math.max(0, 5 - exp));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** Плановый бюджет месяца: int(заявки) × float(CPL), f"{:,.0f} ₽". */
export const planBudget = (apps: number, cpl: number) => `${vkNumber(apps * cpl, 0)} ₽`;

/** История: «Был/Стал CPL» — f"{cpl:,.0f} ₽" (у «Стал» запятая — тоже пробел). */
export const planMoney = (v: number | null) => (v === null ? "—" : `${vkNumber(v, 0)} ₽`);
