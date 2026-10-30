/**
 * Справочники «Обработки 1С» в их Excel-формате: studios_unique.xlsx,
 * nomenclature_reference.xlsx, city_break_even_reference.xlsx. Колонки
 * находятся по заголовкам первой строки (как их load_*_reference), строки —
 * в порядке файла: у них «позже в файле — главнее». Значения хранятся
 * текстом ячейки (str(value)), обрезку пробелов делают правила обработки.
 */
import { pyStr } from "./rules";
import type { Cell } from "./xlsx-read";
import type { XlsxSheet } from "./xlsx-write";

export type OnecRefKind = "studios" | "nomenclature" | "break_even";

export type StudioRow = {
  studio: string | null;
  status: string | null;
  city: string | null;
  partner: string | null;
  comment: string | null;
};
export type NomenclatureRefRow = {
  code: string;
  names: string;
  category: string;
  direction: string;
};
export type BreakEvenRefRow = {
  direction: string | null;
  source_city: string | null;
  source_partner: string | null;
  amount: string | null;
  studios_count: string | null;
  source_status: string | null;
  source_comment: string | null;
  board_city: string | null;
  board_partner: string | null;
  match_status: string | null;
  check_comment: string | null;
};
export type OnecRefRow = StudioRow | NomenclatureRefRow | BreakEvenRefRow;

type Column = { key: string; header: string; numeric?: boolean; width: number };

export const ONEC_REF_COLUMNS: Record<OnecRefKind, Column[]> = {
  studios: [
    { key: "studio", header: "Студия_1С", width: 42 },
    { key: "status", header: "Статус студии", width: 16 },
    { key: "city", header: "Город", width: 24 },
    { key: "partner", header: "Партнер", width: 28 },
    { key: "comment", header: "Комментарий", width: 36 },
  ],
  nomenclature: [
    { key: "code", header: "Код номенклатуры", width: 18 },
    { key: "names", header: "Название номенклатуры", width: 70 },
    { key: "category", header: "Обозначение номенклатуры", width: 28 },
    { key: "direction", header: "Направление номенклатуры", width: 26 },
  ],
  break_even: [
    { key: "direction", header: "Направление", width: 16 },
    { key: "source_city", header: "Город источника", width: 22 },
    { key: "source_partner", header: "Партнер источника", width: 28 },
    { key: "amount", header: "Точка 0 в месяц", numeric: true, width: 16 },
    { key: "studios_count", header: "Количество студий в источнике", numeric: true, width: 14 },
    { key: "source_status", header: "Статус сети в источнике", width: 20 },
    { key: "source_comment", header: "Комментарий источника", width: 40 },
    { key: "board_city", header: "Город для борда", width: 22 },
    { key: "board_partner", header: "Партнер для борда", width: 28 },
    { key: "match_status", header: "Статус сопоставления", width: 28 },
    { key: "check_comment", header: "Комментарий для проверки", width: 40 },
  ],
};

/** Файл справочника, как он называется у них. */
export const ONEC_REF_FILES: Record<OnecRefKind, string> = {
  studios: "studios_unique.xlsx",
  nomenclature: "nomenclature_reference.xlsx",
  break_even: "city_break_even_reference.xlsx",
};

/** Колонки, без которых их обработчик справочник не читает. */
const REQUIRED: Record<OnecRefKind, { keys: string[]; message: string }> = {
  studios: {
    keys: ["studio", "city"],
    message: "В справочнике студий не найдены колонки «Студия_1С» и «Город».",
  },
  nomenclature: {
    keys: ["code", "category"],
    message: "В справочнике номенклатуры не найдены нужные колонки.",
  },
  break_even: {
    keys: ["direction", "amount", "board_city"],
    message:
      "В справочнике точки 0 не найдены колонки «Направление», «Город для борда» и «Точка 0 в месяц».",
  },
};

const text = (v: Cell | undefined): string | null =>
  v === null || v === undefined ? null : pyStr(v);

/** Строки листа (первая — заголовки) → строки справочника. */
export function parseOnecRef(kind: OnecRefKind, sheet: Cell[][]): OnecRefRow[] {
  const headers = (sheet[0] ?? []).map((v) => (v === null ? "" : pyStr(v).trim()));
  const columns = ONEC_REF_COLUMNS[kind].map((c) => ({ ...c, index: headers.indexOf(c.header) }));
  const required = REQUIRED[kind];
  if (required.keys.some((k) => columns.find((c) => c.key === k)!.index < 0)) {
    throw new Error(required.message);
  }
  const out: OnecRefRow[] = [];
  for (const row of sheet.slice(1)) {
    if (row.every((v) => v === null || v === "")) continue;
    const obj: Record<string, string | null> = {};
    for (const c of columns) obj[c.key] = c.index < 0 ? null : text(row[c.index]);
    if (kind === "nomenclature") {
      // Строка без кода их обработчиком не читается.
      if (obj.code === null) continue;
      out.push({
        code: obj.code,
        names: obj.names ?? "",
        category: obj.category ?? "",
        direction: obj.direction ?? "",
      });
    } else {
      out.push(obj as StudioRow | BreakEvenRefRow);
    }
  }
  return out;
}

/** Число, записанное текстом (из ячейки-числа), — обратно числом. */
function cellValue(v: string | null, numeric: boolean | undefined): Cell {
  if (v === null || v === "") return null;
  if (numeric && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** Справочник → лист Excel в их формате (заголовки, ширина колонок). */
export function onecRefSheet(kind: OnecRefKind, rows: OnecRefRow[]): XlsxSheet {
  const columns = ONEC_REF_COLUMNS[kind];
  return {
    name: "Sheet",
    widths: columns.map((c) => c.width),
    rows: [
      columns.map((c) => c.header),
      ...rows.map((r) =>
        columns.map((c) =>
          cellValue((r as Record<string, string | null>)[c.key] ?? null, c.numeric),
        ),
      ),
    ],
  };
}
