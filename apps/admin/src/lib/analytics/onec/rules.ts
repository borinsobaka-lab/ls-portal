/**
 * Правила обработки выгрузок 1С — перенос функций обработчика Lady Stretch
 * (`analytics-1c-test/scripts/*.py`, `process.py`) как есть, включая их
 * особенности: разные функции нормализации имени студии в разных сводах,
 * разбор дат по `strptime`, чисел — по `float()` Python.
 *
 * Дата-время — строкой «YYYY-MM-DD HH:MM:SS» (сравнение строк = сравнение
 * дат), день — «YYYY-MM-DD».
 */
import { XlsxDate, type Cell } from "./xlsx-read";

/** str(value) Python для значения ячейки. */
export function pyStr(v: Cell): string {
  if (v === null) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return v.value;
}

/** str(value or "") Python: «ложные» значения (None, "", 0, False) → "". */
export function orEmpty(v: Cell): string {
  if (v === null || v === "" || v === 0 || v === false) return "";
  return pyStr(v);
}

/** Пробельные символы Python (str.isspace, \s в re): без U+FEFF, в отличие от \s в JS. */
const WS =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const STRIP_RE = new RegExp(`^${WS}+|${WS}+$`, "g");
const MULTI_WS_RE = new RegExp(`${WS}{2,}`, "g");
const SPLIT_WS_RE = new RegExp(`${WS}+`);

/** str.strip() Python. */
export function strip(s: string): string {
  return s.replace(STRIP_RE, "");
}

/** str.casefold() — для кириллицы и латиницы совпадает с lower(). */
export function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
}

const DELETED_RE = new RegExp(`${WS}*\\(${WS}*удален${WS}*\\)`, "gi");

/** normalize_studio (продажи, занятия, воронка, справочник городов): без «(удален)», сжатые пробелы. */
export function normalizeStudio(v: Cell): string {
  const name = strip(orEmpty(v)).replace(DELETED_RE, "");
  return strip(name.replace(MULTI_WS_RE, " "));
}

/** normalize_studio_name (выручка): то же + статус «Закрыта», если была пометка. */
export function normalizeStudioName(v: Cell): { name: string; status: string } {
  const raw = strip(pyStr(v));
  const closed = raw.toLowerCase().includes("удален");
  const clean = strip(raw.replace(DELETED_RE, "").replace(MULTI_WS_RE, " "));
  return { name: clean, status: closed ? CLOSED : OPEN };
}

/** normalize из process.py (сборка снимка): без «(удален)», без сжатия пробелов. */
export function normalizeProcess(v: Cell): string {
  return strip(orEmpty(v)).replace(DELETED_RE, "");
}

/** canonical_city: пусто → «Город не заполнен», «Казань Стоблова» → «Казань Столбова». */
export function canonicalCity(v: Cell | undefined): string {
  const text = strip(
    v === undefined || v === null || v === "" || v === 0 || v === false
      ? "Город не заполнен"
      : pyStr(v),
  );
  return text === "Казань Стоблова" ? "Казань Столбова" : text;
}

/** normalize_text (воронка): сжатые 2+ пробела, strip. */
export function normalizeText(v: Cell): string {
  return strip(orEmpty(v)).replace(MULTI_WS_RE, " ");
}

/** normalize_name (справочник номенклатуры): casefold, пробелы — одним. */
export function normalizeName(v: Cell): string {
  const s = casefold(strip(orEmpty(v)));
  return s.split(SPLIT_WS_RE).filter(Boolean).join(" ");
}

/** normalize_membership_name (воронка). */
export function normalizeMembershipName(v: Cell): string {
  return casefold(normalizeText(v));
}

/** split_nomenclature: «код, название» — по первой запятой, нули кода сохраняются. */
export function splitNomenclature(v: Cell): [string, string] {
  const raw = strip(orEmpty(v));
  if (!raw) return ["", ""];
  const i = raw.indexOf(",");
  if (i < 0) return [raw, ""];
  return [strip(raw.slice(0, i)), strip(raw.slice(i + 1))];
}

export const OPEN = "Открыта";
export const CLOSED = "Закрыта";
export const SUBSCRIPTION = "Абонемент";
export const TRIAL = "Пробное занятие";
export const REVIEW = "Требует классификации";
export const UNDEFINED = "Не определено";
export const NO_DETAIL_ARTICLE = "Без детализации";

// --- Числа ------------------------------------------------------------------

/** float(str) Python: пробелы по краям, «_» между цифрами, inf/nan. NaN — не число. */
export function pyFloat(text: string): number {
  const s = strip(text);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(s)) {
    return Number.NaN;
  }
  return Number(s.replace(/_/g, ""));
}

/** as_positive_number (продажи, занятия): > 0 или null. */
export function asPositiveNumber(v: Cell): number | null {
  if (typeof v === "boolean" || v === null) return null;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    n = pyFloat(v.replace(/ /g, "").replace(/,/g, "."));
    if (Number.isNaN(n)) return null;
  } else return null;
  return n > 0 ? n : null;
}

/** as_number (продажи): число или 0. */
export function asNumber(v: Cell): number {
  if (typeof v === "boolean" || v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = pyFloat(v.replace(/ /g, "").replace(/,/g, "."));
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Число после промежуточного свода в Excel: openpyxl пишет числа как
 * «%.16g» (safe_string), и при чтении свода обратно последний разряд дроби
 * может измениться. Снимок у них собирается из этих сводов — повторяем.
 */
export function excelRoundTrip(v: number): number {
  return Number.isInteger(v) || !Number.isFinite(v) ? v : Number(v.toPrecision(16));
}

// --- Даты -------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Регулярные выражения _strptime для %d %m %Y %H %M %S (пробел в формате = \s+).
const D = "(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])";
const M = "(1[0-2]|0[1-9]|[1-9])";
const Y = "(\\d\\d\\d\\d)";
const H = "(2[0-3]|[0-1]\\d|\\d)";
const MI = "([0-5]\\d|\\d)";
const S = "(6[0-1]|[0-5]\\d|\\d)";
const DT_FULL = new RegExp(`^${D}\\.${M}\\.${Y}\\s+${H}:${MI}:${S}$`, "i");
const DT_MIN = new RegExp(`^${D}\\.${M}\\.${Y}\\s+${H}:${MI}$`, "i");
const DT_DAY = new RegExp(`^${D}\\.${M}\\.${Y}$`, "i");
const ISO_DAY = new RegExp(`^${Y}-${M}-${D}$`, "i");

function build(y: string, m: string, d: string, h = "0", mi = "0", s = "0"): string | null {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d.trim());
  const ss = Number(s);
  if (!validDate(yy, mm, dd) || ss > 59) return null;
  return `${y}-${pad(mm)}-${pad(dd)} ${pad(Number(h))}:${pad(Number(mi))}:${pad(ss)}`;
}

/** parse_sale_datetime / parse_datetime: «ДД.ММ.ГГГГ Ч:ММ:СС», без секунд, без времени. */
export function parseSaleDatetime(v: Cell): string | null {
  if (v instanceof XlsxDate) return v.value;
  if (typeof v !== "string") return null;
  const text = strip(v);
  let m = DT_FULL.exec(text);
  if (m) return build(m[3], m[2], m[1], m[4], m[5], m[6]);
  m = DT_MIN.exec(text);
  if (m) return build(m[3], m[2], m[1], m[4], m[5]);
  m = DT_DAY.exec(text);
  if (m) return build(m[3], m[2], m[1]);
  return null;
}

/** parse_date (занятия): «ДД.ММ.ГГГГ» или «ГГГГ-ММ-ДД». */
export function parseActivityDate(v: Cell): string | null {
  if (v instanceof XlsxDate) return v.day;
  if (typeof v !== "string") return null;
  const text = strip(v);
  let m = DT_DAY.exec(text);
  if (m) return build(m[3], m[2], m[1])?.slice(0, 10) ?? null;
  m = ISO_DAY.exec(text);
  if (m) return build(m[1], m[2], m[3])?.slice(0, 10) ?? null;
  return null;
}

const MONTHS_RU: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};
const RU_DATE_RE = /^(\d{2})\s+([а-яё]+)\s+(\d{4})$/i;

/** parse_ru_date (выручка): «31 октября 2018». */
export function parseRuDate(v: Cell): string | null {
  if (typeof v !== "string") return null;
  const m = RU_DATE_RE.exec(strip(v).toLowerCase());
  if (!m) return null;
  const month = MONTHS_RU[m[2]];
  if (!month) return null;
  const y = Number(m[3]);
  const d = Number(m[1]);
  if (!validDate(y, month, d)) throw new Error(`Неверная дата в выгрузке: ${v}`);
  return `${m[3]}-${pad(month)}-${pad(d)}`;
}

/** День + n календарных дней. */
export function addDays(day: string, n: number): string {
  const t = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  const d = new Date(t + n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Python-сортировка строк (по кодам символов), устойчивая. */
export function pyCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pyCompareTuple(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = pyCompare(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Классификация по ключевым словам — подсказка окна новых номенклатур. */
export function classifyNomenclature(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("пробн")) return TRIAL;
  if (n.includes("персональн") || n.includes("перс. трениров")) return "Персональные тренировки";
  if (n.includes("разов") && n.includes("занят")) return "Разовое занятие";
  if (
    ["изменение срока", "продлен", "замороз", "смена владельца", "переоформ", "восстановлен"].some(
      (m) => n.includes(m),
    )
  ) {
    return "Сервис / изменение условий";
  }
  if (
    ["абонемент", "комбо", "premium", "standart", "стандарт", "безлимит", "заняти"].some((m) =>
      n.includes(m),
    )
  ) {
    return SUBSCRIPTION;
  }
  return UNDEFINED;
}

export const BASE_DESIGNATIONS = [
  SUBSCRIPTION,
  TRIAL,
  "Разовое занятие",
  "Персональные тренировки",
  "Сервис / изменение условий",
  "Подарок",
  "Массаж",
  "Прочее",
  UNDEFINED,
];
