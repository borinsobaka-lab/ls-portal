/**
 * «Аналитика сети» → «Загрузка данных»: разбор выгрузок учётных систем (1С,
 * FitBase, АДИС, Мобифитнес…) без React (тест — import.test.ts). Таблица
 * (строки ячеек из Excel или CSV) → строки единого вида по правилам портала
 * Lady Stretch (ANALYTICS.md):
 *
 *   * revenue — движение денег: дата, студия, приход, расход, статья.
 *     Отчёт 1С иерархический — дата и студия стоят строкой выше операций,
 *     поэтому у даты и студии есть «протянуть вниз». Строки «Итого» и без
 *     сумм пропускаются, «(удален)» в названии студии срезается. Суммы
 *     сводятся до студия × день × статья.
 *   * sales — строки продаж: дата, студия, номенклатура (с кодом или без),
 *     код клиента, стоимость, оплата. Берутся все строки — что считать
 *     абонементом, решает справочник номенклатуры.
 *   * classes — занятия: дата, студия, направление, занятий проведено,
 *     клиентов записано, клиентов посетило. Только строки, где все три > 0
 *     (иначе занятие не проведено); сводятся до студия × день × направление.
 *   * visits — посещения с членством: дата, студия, членство (пакет услуг),
 *     код клиента, статус. Пришёл — «прибыл» / «пришёл» / «посетил», кроме
 *     «не …».
 *
 * Колонки находятся по заголовкам (синонимы ниже); не нашлись — человек
 * выбирает их сам. Код клиента в базу уходит только хэшем (clientKey).
 */
import type { AnKind } from "./types";

export type FieldKey =
  | "date"
  | "studio"
  | "income"
  | "expense"
  | "article"
  | "nomenclature"
  | "nomenclatureCode"
  | "client"
  | "cost"
  | "paid"
  | "direction"
  | "classes"
  | "booked"
  | "attended"
  | "membership"
  | "status"
  | "time";

export type FieldDef = {
  key: FieldKey;
  label: string;
  required: boolean;
  /** Заголовки колонок, которые узнаются сами (без регистра и знаков). */
  synonyms: string[];
  /** Пустая ячейка — значение строки выше (иерархический отчёт). */
  fillDown?: boolean;
};

const DATE: FieldDef = {
  key: "date",
  label: "Дата",
  required: true,
  synonyms: [
    "дата",
    "период день",
    "период",
    "день",
    "дата продажи",
    "дата занятия",
    "дата посещения",
    "date",
  ],
};
const STUDIO: FieldDef = {
  key: "studio",
  label: "Студия",
  required: true,
  synonyms: [
    "структурная единица",
    "студия",
    "клуб",
    "филиал",
    "подразделение",
    "студия 1с",
    "club",
    "studio",
  ],
};
const CLIENT: FieldDef = {
  key: "client",
  label: "Код клиента",
  required: false,
  synonyms: [
    "клиент код",
    "код клиента",
    "клиент id",
    "id клиента",
    "клиент",
    "client id",
    "client",
  ],
};

export const KIND_FIELDS: Record<AnKind, FieldDef[]> = {
  revenue: [
    { ...DATE, fillDown: true },
    { ...STUDIO, fillDown: true },
    {
      key: "income",
      label: "Приход",
      required: true,
      synonyms: ["приход", "поступление", "доход"],
    },
    {
      key: "expense",
      label: "Расход",
      required: false,
      synonyms: ["расход", "списание", "возврат"],
    },
    {
      key: "article",
      label: "Статья",
      required: false,
      synonyms: ["статья", "статья движения денежных средств", "статья ддс"],
    },
  ],
  sales: [
    DATE,
    STUDIO,
    {
      key: "nomenclature",
      label: "Номенклатура",
      required: true,
      synonyms: ["номенклатура", "товар", "услуга", "абонемент", "наименование", "позиция"],
    },
    {
      key: "nomenclatureCode",
      label: "Код номенклатуры",
      required: false,
      synonyms: ["код номенклатуры", "номенклатура код", "артикул"],
    },
    { ...CLIENT, required: true },
    {
      key: "cost",
      label: "Стоимость",
      required: false,
      synonyms: ["стоимость", "цена", "сумма продажи"],
    },
    {
      key: "paid",
      label: "Оплата",
      required: true,
      synonyms: ["оплата", "оплачено", "сумма оплаты"],
    },
    { key: "time", label: "Время", required: false, synonyms: ["время", "время продажи"] },
  ],
  classes: [
    DATE,
    STUDIO,
    {
      key: "direction",
      label: "Направление",
      required: true,
      synonyms: ["направление", "услуга", "тренировка", "вид занятия"],
    },
    {
      key: "classes",
      label: "Занятий проведено",
      required: true,
      synonyms: ["занятий проведено", "проведено занятий", "занятий", "занятия"],
    },
    {
      key: "booked",
      label: "Клиентов записано",
      required: true,
      synonyms: ["клиентов записано", "записано", "записей"],
    },
    {
      key: "attended",
      label: "Клиентов посетило",
      required: true,
      synonyms: ["клиентов посетило", "посетило", "посещений", "пришло"],
    },
  ],
  visits: [
    DATE,
    STUDIO,
    {
      key: "membership",
      label: "Членство / пакет услуг",
      required: true,
      synonyms: ["членство пакет услуг", "членство", "пакет услуг", "абонемент", "услуга"],
    },
    { ...CLIENT, required: true },
    {
      key: "status",
      label: "Статус",
      required: true,
      synonyms: ["статус", "статус посещения", "статус записи", "посещение"],
    },
  ],
};

export const KIND_LABEL: Record<AnKind, string> = {
  revenue: "Выручка (движение денег)",
  sales: "Продажи",
  classes: "Занятия и направления",
  visits: "Посещения с членством (пробные)",
};

export type Cell = string | number | boolean | Date | null | undefined;
export type Mapping = Partial<Record<FieldKey, number>>;

/** Текст для сравнения: без регистра, «ё», знаков и лишних пробелов. */
export function norm(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

/** Колонки по заголовкам: точное совпадение синонима, затем «начинается с». */
export function autoMap(headers: Cell[], kind: AnKind): Mapping {
  const cols = headers.map(norm);
  const map: Mapping = {};
  const taken = new Set<number>();
  for (const pass of ["exact", "prefix"] as const) {
    for (const f of KIND_FIELDS[kind]) {
      if (map[f.key] !== undefined) continue;
      for (const syn of f.synonyms) {
        const i = cols.findIndex(
          (c, idx) =>
            !taken.has(idx) && c !== "" && (pass === "exact" ? c === syn : c.startsWith(syn)),
        );
        if (i >= 0) {
          map[f.key] = i;
          taken.add(i);
          break;
        }
      }
    }
  }
  return map;
}

/**
 * Строка заголовков: первая из первых 30, где узнаются хотя бы два
 * обязательных поля (над таблицей в отчётах 1С — название и параметры).
 */
export function findHeaderRow(rows: Cell[][], kind: AnKind): number {
  const required = KIND_FIELDS[kind].filter((f) => f.required).map((f) => f.key);
  let best = { row: 0, score: -1 };
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const m = autoMap(rows[r], kind);
    const score = required.filter((k) => m[k] !== undefined).length;
    if (score > best.score) best = { row: r, score };
    if (score === required.length) break;
  }
  return best.row;
}

export function missingRequired(kind: AnKind, map: Mapping): FieldDef[] {
  return KIND_FIELDS[kind].filter((f) => f.required && map[f.key] === undefined);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Дата ячейки → yyyy-MM-dd (и время, если есть). Понимает Date из Excel,
 * число Excel (дни с 1899-12-30), «31.08.2026», «31.08.2026 14:05:00»,
 * «2026-08-31», «2026-08-31T14:05».
 */
export function parseDateCell(v: Cell): { day: string; time: string | null } | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // read-excel-file отдаёт даты в UTC.
    const day = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const hasTime = v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() > 0;
    return {
      day,
      time: hasTime
        ? `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`
        : null,
    };
  }
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return parseDateCell(new Date(ms));
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const day = `${year}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    return validDay(day)
      ? { day, time: m[4] ? `${pad(Number(m[4]))}:${m[5]}:${m[6] ?? "00"}` : null }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    return validDay(day) ? { day, time: m[4] ? `${m[4]}:${m[5]}:${m[6] ?? "00"}` : null } : null;
  }
  return null;
}

function validDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Число ячейки: «1 234,56», «1234.56», «-500»; пусто или текст — null. */
export function parseNumberCell(v: Cell): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v instanceof Date) return null;
  const s = String(v)
    .replace(/[\s\u00a0\u202f₽$€]/g, "")
    .replace(/,(?=\d{1,2}$)/, ".")
    .replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const text = (v: Cell) => (v instanceof Date ? "" : String(v ?? "").trim());

/** Название студии без пометки «(удален)» (как очистка Lady Stretch). */
export function cleanStudio(v: Cell): string {
  return text(v)
    .replace(/\(\s*удал[её]н[а-я]*\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TOTAL = /^(итог|всего|total)/i;

/**
 * Номенклатура: код и название. Отдельная колонка кода — она; иначе первое
 * слово с цифрой («00-00001234 Абонемент 8») — код; иначе код —
 * «name:<название без регистра>».
 */
export function splitNomenclature(name: Cell, code: Cell): { code: string; name: string } {
  const n = text(name);
  const c = text(code);
  if (c) return { code: c, name: n || c };
  const m = /^(\S*\d\S*)\s+(.+)$/.exec(n);
  if (m && m[1].length <= 20 && /[a-zа-я]/i.test(m[2])) return { code: m[1], name: m[2].trim() };
  return { code: `name:${n.toLowerCase()}`, name: n };
}

/** Пришёл ли клиент по статусу записи. */
export function isAttended(status: Cell): boolean {
  const s = norm(status);
  if (/(^| )не( |$)|not|no show|отмен/.test(s)) return false;
  return /прибыл|пришел|посетил|был|visited|attended/.test(s);
}

export type ParsedRevenue = {
  studio: string;
  day: string;
  article: string;
  income: number;
  expense: number;
};
export type ParsedSale = {
  studio: string;
  day: string;
  time: string | null;
  client: string | null;
  code: string;
  name: string;
  cost: number | null;
  paid: number | null;
};
export type ParsedClass = {
  studio: string;
  day: string;
  direction: string;
  classes: number;
  booked: number;
  attended: number;
};
export type ParsedVisit = {
  studio: string;
  day: string;
  client: string | null;
  membership: string;
  attended: boolean;
};

export type ParseResult =
  | { kind: "revenue"; rows: ParsedRevenue[] }
  | { kind: "sales"; rows: ParsedSale[] }
  | { kind: "classes"; rows: ParsedClass[] }
  | { kind: "visits"; rows: ParsedVisit[] };

export type ParseSummary = {
  result: ParseResult;
  /** Строки данных в файле (после заголовка). */
  total: number;
  /** Пропущено: без даты или студии, итоги, без сумм, не проведённые занятия. */
  skipped: number;
  dateFrom: string | null;
  dateTo: string | null;
  studios: string[];
};

/** Разбор таблицы по сопоставлению колонок. */
export function parseTable(
  kind: AnKind,
  rows: Cell[][],
  headerRow: number,
  map: Mapping,
): ParseSummary {
  const fields = KIND_FIELDS[kind];
  const carry: Partial<Record<FieldKey, Cell>> = {};
  const get = (row: Cell[], key: FieldKey): Cell => {
    const i = map[key];
    if (i === undefined) return null;
    const v = row[i];
    const f = fields.find((x) => x.key === key);
    if (f?.fillDown) {
      if (v !== null && v !== undefined && v !== "") carry[key] = v;
      return carry[key] ?? null;
    }
    return v;
  };

  const data = rows.slice(headerRow + 1);
  const blank = (c: Cell) => c === null || c === undefined || c === "";
  const filled = data.map((r) => !!r && r.some((c) => !blank(c)));
  // Иерархический отчёт (дата и студия — строками-группировками над
  // операциями): внутренний уровень — поле, заполненное в строках чаще
  // всего. Строка без своего значения внутреннего уровня, но со значением
  // внешнего — группировка; в ней подытог группы, его не считаем, иначе
  // суммы удвоятся. В плоской выгрузке все поля заполнены — группировок нет.
  const levels = fields
    .filter((f) => f.fillDown && map[f.key] !== undefined)
    .map((f) => ({
      col: map[f.key]!,
      count: data.filter((r, i) => filled[i] && !blank(r[map[f.key]!])).length,
    }))
    .sort((a, b) => a.count - b.count);
  const inner = levels[levels.length - 1];
  const filledCount = filled.filter(Boolean).length;
  const groupHeader = data.map(
    (row, i) =>
      levels.length > 1 &&
      inner.count < filledCount &&
      filled[i] &&
      blank(row[inner.col]) &&
      levels.slice(0, -1).some((l) => !blank(row[l.col])),
  );
  let skipped = 0;
  const revenue = new Map<string, ParsedRevenue>();
  const classes = new Map<string, ParsedClass>();
  const sales: ParsedSale[] = [];
  const visits: ParsedVisit[] = [];

  for (const [i, row] of data.entries()) {
    if (!filled[i]) continue;
    const date = parseDateCell(get(row, "date"));
    const studioCell = get(row, "studio");
    if (groupHeader[i]) {
      skipped++;
      continue;
    }
    const studio = cleanStudio(studioCell);
    const totalRow = row.some((c) => typeof c === "string" && TOTAL.test(c.trim()));
    if (!date || !studio || totalRow) {
      skipped++;
      continue;
    }
    if (kind === "revenue") {
      const income = parseNumberCell(get(row, "income"));
      const expense = parseNumberCell(get(row, "expense"));
      if (income === null && expense === null) {
        skipped++;
        continue;
      }
      const article = map.article === undefined ? "" : text(get(row, "article"));
      const k = `${studio}\u0000${date.day}\u0000${article}`;
      const acc = revenue.get(k) ?? { studio, day: date.day, article, income: 0, expense: 0 };
      acc.income += income ?? 0;
      acc.expense += expense ?? 0;
      revenue.set(k, acc);
    } else if (kind === "sales") {
      const nameCell = get(row, "nomenclature");
      if (!text(nameCell)) {
        skipped++;
        continue;
      }
      const nom = splitNomenclature(nameCell, get(row, "nomenclatureCode"));
      const time =
        map.time !== undefined ? parseDateCell(`2000-01-01 ${text(get(row, "time"))}`)?.time : null;
      sales.push({
        studio,
        day: date.day,
        time: date.time ?? time ?? null,
        client: text(get(row, "client")) || null,
        code: nom.code,
        name: nom.name,
        cost: parseNumberCell(get(row, "cost")),
        paid: parseNumberCell(get(row, "paid")),
      });
    } else if (kind === "classes") {
      const n = parseNumberCell(get(row, "classes"));
      const b = parseNumberCell(get(row, "booked"));
      const a = parseNumberCell(get(row, "attended"));
      // Занятие без записанных или пришедших — не проведено (правило Lady Stretch).
      if (!n || !b || !a || n <= 0 || b <= 0 || a <= 0) {
        skipped++;
        continue;
      }
      const direction = text(get(row, "direction"));
      const k = `${studio}\u0000${date.day}\u0000${direction}`;
      const acc = classes.get(k) ?? {
        studio,
        day: date.day,
        direction,
        classes: 0,
        booked: 0,
        attended: 0,
      };
      acc.classes += Math.round(n);
      acc.booked += Math.round(b);
      acc.attended += Math.round(a);
      classes.set(k, acc);
    } else {
      const membership = text(get(row, "membership"));
      if (!membership) {
        skipped++;
        continue;
      }
      visits.push({
        studio,
        day: date.day,
        client: text(get(row, "client")) || null,
        membership,
        attended: isAttended(get(row, "status")),
      });
    }
  }

  const result: ParseResult =
    kind === "revenue"
      ? { kind, rows: [...revenue.values()] }
      : kind === "sales"
        ? { kind, rows: sales }
        : kind === "classes"
          ? { kind, rows: [...classes.values()] }
          : { kind, rows: visits };
  const days = result.rows.map((r) => r.day).sort();
  return {
    result,
    total: filled.filter(Boolean).length,
    skipped,
    dateFrom: days[0] ?? null,
    dateTo: days[days.length - 1] ?? null,
    studios: [...new Set(result.rows.map((r) => r.studio))].sort((a, b) =>
      a.localeCompare(b, "ru"),
    ),
  };
}

/** Позиции номенклатуры продаж (уникальные коды). */
export function salesNomenclature(rows: ParsedSale[]): { code: string; name: string }[] {
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.code)) map.set(r.code, r.name);
  return [...map.entries()].map(([code, name]) => ({ code, name }));
}

/**
 * Членства посещений с «пробн», которых нет в справочнике по названию: их
 * заводим в справочник «Требует классификации», чтобы человек решил, пробное
 * ли это (воронка видит только размеченные «Пробное занятие»).
 */
export function newTrialNames(
  rows: ParsedVisit[],
  knownNames: Set<string>,
): { code: string; name: string }[] {
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = r.membership.trim().toLowerCase();
    if (!/пробн/.test(key) || knownNames.has(key) || out.has(key)) continue;
    out.set(key, r.membership.trim());
  }
  return [...out.entries()].map(([key, name]) => ({ code: `name:${key}`, name }));
}

/**
 * CSV → таблица: разделитель «;», «,» или табуляция (по первой строке),
 * кавычки по RFC 4180.
 */
export function parseCsv(input: string): string[][] {
  const textIn = input.replace(/^\uFEFF/, "");
  const firstLine = textIn.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", "\t", ","].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i];
    if (quoted) {
      if (ch === '"' && textIn[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && textIn[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Хэш кода клиента: в базу уходит только он (SHA-256, 32 знака). */
export async function clientKey(source: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${source}\u0000${code.trim().toLowerCase()}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Пачки по `size` для отправки в базу. */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
