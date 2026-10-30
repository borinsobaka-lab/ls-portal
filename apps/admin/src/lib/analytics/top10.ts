/**
 * «Топ-10 городов» — их partner-rankings (analyze.py + build.mjs; итоговая
 * книга после edit-labels.mjs): по месяцам — четыре рейтинга городских групп
 * (покупка в день пробного, покупка за 14 дней, продления, возвращённые) и
 * лист «Все города» со всеми строками. Строки месяц × город отдаёт база
 * (RPC an_onec_top10), рейтинги и книгу — этот модуль, как у них: ячейки
 * рейтингов — формулы на «Все города» с сохранёнными значениями, оформление
 * их книги (цвета, шрифты, ширины, высоты строк, закреплённая шапка).
 */
import { pyCompare } from "./onec/rules";
import { columnLetter, zip, type Deflate } from "./onec/xlsx-write";

/** Строка месяц × городская группа (их cities.json). */
export type Top10Row = {
  month: string;
  city: string;
  booked: number;
  attended: number;
  day_base: number;
  bought_day: number;
  window_base: number;
  bought_14: number;
  sales: number;
  new: number;
  repeat_old: number;
  returned: number;
  renewals: number;
};

export type Top10Data = {
  generated_at: string | null;
  sales_min: string | null;
  sales_max: string | null;
  funnel_min: string | null;
  funnel_max: string | null;
  /** В снимке есть «возвращённые» (снимок до 2026-10-30 их не считал). */
  returned_ready: boolean;
  rows: Omit<Top10Row, "renewals">[];
};

type Metric = keyof Omit<Top10Row, "month" | "city">;

/** Колонки листа «Все города» (их fields + две конверсии). */
const DETAIL_FIELDS: (keyof Top10Row)[] = [
  "month",
  "city",
  "booked",
  "attended",
  "day_base",
  "bought_day",
  "window_base",
  "bought_14",
  "sales",
  "new",
  "repeat_old",
  "returned",
  "renewals",
];
export const TOP10_DETAIL_HEADS = [
  "Месяц",
  "Городская группа",
  "Записались",
  "Пришли",
  "База в день",
  "Купили в день",
  "База 14 дней",
  "Купили за 14 дней",
  "Все покупки",
  "Новые покупки",
  "Прежние продления",
  "Возвращённые",
  "Обычные продления",
  "Конверсия в день",
  "Конверсия 14 дней",
];

export type Top10Ranking = {
  key: string;
  title: string;
  /** Строка заголовка блока на листе месяца и столбец (0 — A, 7 — H). */
  r: number;
  col: number;
  metric: Metric;
  den?: Metric;
  /** Столбцы «Все города» по порядку ячеек строки (город, затем значения). */
  source: string[];
  headers: string[];
};

/** Их definitions (итоговые подписи после edit-labels.mjs). */
export const TOP10_RANKINGS: Top10Ranking[] = [
  {
    key: "day",
    title: "Покупка в день пробного",
    r: 5,
    col: 0,
    metric: "bought_day",
    den: "day_base",
    source: ["B", "E", "F", "N"],
    headers: ["Место", "Город", "Пришли", "Купили", "Конверсия"],
  },
  {
    key: "window",
    title: "Покупка за 14 дней",
    r: 5,
    col: 7,
    metric: "bought_14",
    den: "window_base",
    source: ["B", "G", "H", "O"],
    headers: ["Место", "Город", "Пришли", "Купили", "Конверсия"],
  },
  {
    key: "renewals",
    title: "Топ по продлениям",
    r: 21,
    col: 0,
    metric: "renewals",
    source: ["B", "M", "I", "L"],
    headers: ["Место", "Город", "Продления", "Всего продаж", "Возвращённые"],
  },
  {
    key: "returned",
    title: "Топ по возвращённым",
    r: 21,
    col: 7,
    metric: "returned",
    source: ["B", "L", "M", "I"],
    headers: ["Место", "Город", "Возвращённые", "Продления", "Всего продаж"],
  },
];

/** Столбец «Все города» → значение строки. */
const DETAIL_COLUMN: Record<string, (r: Top10Row) => string | number> = {
  B: (r) => r.city,
  E: (r) => r.day_base,
  F: (r) => r.bought_day,
  G: (r) => r.window_base,
  H: (r) => r.bought_14,
  I: (r) => r.sales,
  L: (r) => r.returned,
  M: (r) => r.renewals,
  N: (r) => rate(r.bought_day, r.day_base),
  O: (r) => rate(r.bought_14, r.window_base),
};

function rate(n: number, d: number): number | string {
  return d === 0 ? "—" : n / d;
}

export const TOP10_NOTES_STATIC = [
  "Конверсия: купившие / пришедшие на пробное с закрытым окном. За 14 дней включает покупки в день пробного.",
  "Месяц конверсии определяется датой пробного; месяц продления — датой покупки абонемента.",
  "Возвращённые выделены из прежних повторных продаж в отдельную категорию.",
  "Обычные продления = прежние повторные продажи минус возвращённые; считаются покупки, а не уникальные клиенты.",
  "Учитываются абонементы с положительной оплатой по действующим правилам отчёта; история клиента проверяется по всей сети.",
  "Городские группы сохранены как в портале. Статус студии не ограничен. Порог размера базы не задан.",
  "Рейтинги — фиксированный исторический срез. При равенстве конверсии выше город с большим числом покупок, затем по алфавиту.",
  "При равенстве количества продлений/возвращённых города расположены по алфавиту.",
  "Сверка: расхождений с прежним сводом продаж по городам и студиям нет; возвращённые + обычные = прежние продления.",
];

const MONTHS = [
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
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «Август 2026» — имя листа месяца (их ['Август 2026', …]). */
export function top10SheetName(month: string): string {
  return `${capital(monthName(month))} ${month.slice(0, 4)}`;
}

/** «август и сентябрь 2026», «декабрь 2025 и январь 2026». */
export function top10MonthsLabel(months: string[]): string {
  const groups: { year: string; names: string[] }[] = [];
  for (const m of months) {
    const year = m.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last?.year === year) last.names.push(monthName(m));
    else groups.push({ year, names: [monthName(m)] });
  }
  const parts = groups.flatMap((g) =>
    g.names.map((n, i) => (i === g.names.length - 1 ? `${n} ${g.year}` : n)),
  );
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
}

/** Их имя файла: «Топ-10_август_сентябрь_2026.xlsx». */
export function top10FileName(months: string[]): string {
  const years = new Set(months.map((m) => m.slice(0, 4)));
  const parts =
    years.size === 1
      ? [...months.map(monthName), months[0].slice(0, 4)]
      : months.map((m) => `${monthName(m)}_${m.slice(0, 4)}`);
  return `Топ-10_${parts.join("_")}.xlsx`;
}

/** Строки базы → их cities: обычные продления = прежние продления − возвращённые. */
export function top10Rows(data: Top10Data): Top10Row[] {
  return data.rows
    .map((r) => ({ ...r, renewals: r.repeat_old - r.returned }))
    .sort((a, b) => pyCompare(a.month, b.month) || pyCompare(a.city, b.city));
}

/**
 * Их ranked: с базой > 0 (у конверсий) или с результатом > 0, по убыванию;
 * при равенстве конверсии — больше покупок, затем город по алфавиту.
 */
export function top10Rank(rows: Top10Row[], d: Top10Ranking): Top10Row[] {
  const den = d.den;
  const value = (r: Top10Row) => (den ? r[d.metric] / r[den] : r[d.metric]);
  return rows
    .filter((r) => (den ? r[den] > 0 : r[d.metric] > 0))
    .sort(
      (a, b) =>
        value(b) - value(a) ||
        (den ? b[d.metric] - a[d.metric] : 0) ||
        a.city.localeCompare(b.city, "ru"),
    )
    .slice(0, 10);
}

/** «31.10.2018» из «2018-10-31…». */
function ruDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** Первая строка примечаний: дата сводов и охват истории покупок. */
export function top10SourceNote(data: Top10Data): string {
  const generated = data.generated_at
    ? new Date(data.generated_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })
    : "—";
  const history =
    data.sales_min && data.sales_max ? `${ruDate(data.sales_min)}–${ruDate(data.sales_max)}` : "—";
  return `Источник: своды 1С от ${generated}; история покупок ${history}.`;
}

// --- Книга Excel ---------------------------------------------------------------------

/** Стили их книги: индексы cellXfs ниже. */
const S = {
  base: 1,
  title: 2,
  header: 3,
  int: 4,
  pct: 5,
  block: 6,
  zebra: 7,
  zebraInt: 8,
  zebraPct: 9,
  note: 10,
} as const;

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>' +
  '<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><sz val="10"/><color rgb="FF242038"/><name val="Arial"/></font>' +
  '<font><b/><sz val="14"/><color rgb="FF242038"/><name val="Arial"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>' +
  '<font><b/><sz val="12"/><color rgb="FF593A85"/><name val="Arial"/></font>' +
  '<font><sz val="10"/><color rgb="FF655B70"/><name val="Arial"/></font></fonts>' +
  '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF593A85"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3EEF8"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  xf(0, 1, 0) +
  xf(0, 2, 0) +
  '<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  xf(3, 1, 0) +
  xf(164, 1, 0) +
  xf(0, 4, 0) +
  xf(0, 1, 3) +
  xf(3, 1, 3) +
  xf(164, 1, 3) +
  xf(0, 5, 0) +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function xf(numFmt: number, font: number, fill: number) {
  return (
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" ` +
    'applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  );
}

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type XCell = { v?: string | number; f?: string; s: number };

/** Лист: ячейки по строкам, высоты строк, ширины, вид. */
class SheetBuilder {
  private rows = new Map<number, Map<number, XCell>>();
  private heights = new Map<number, number>();
  constructor(
    private readonly widths: [number, number, number][],
    private readonly view: { tab?: string; freezeRows?: number },
  ) {}

  /** Их base: стиль и высота 23 у всех ячеек диапазона. */
  base(lastCol: number, lastRow: number) {
    for (let r = 1; r <= lastRow; r++) {
      this.heights.set(r, 23);
      for (let c = 0; c <= lastCol; c++) this.set(r, c, { s: S.base });
    }
  }
  set(r: number, c: number, cell: XCell) {
    let row = this.rows.get(r);
    if (!row) this.rows.set(r, (row = new Map()));
    row.set(c, cell);
  }
  style(r: number, c: number, s: number) {
    const cell = this.rows.get(r)?.get(c);
    this.set(r, c, { ...cell, s });
  }
  height(r: number, h: number) {
    this.heights.set(r, h);
  }

  xml(): string {
    const view = this.view.freezeRows
      ? `<sheetView showGridLines="0" workbookViewId="0"><pane ySplit="${this.view.freezeRows}" topLeftCell="A${this.view.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      : '<sheetView showGridLines="0" workbookViewId="0"/>';
    let out =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (this.view.tab ? `<sheetPr><tabColor rgb="${this.view.tab}"/></sheetPr>` : "") +
      `<sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>` +
      this.widths
        .flatMap(([min, max, w]) =>
          Array.from(
            { length: max - min + 1 },
            (_, i) => `<col min="${min + i}" max="${min + i}" width="${w}" customWidth="1"/>`,
          ),
        )
        .join("") +
      "</cols><sheetData>";
    const rowNos = [...new Set([...this.rows.keys(), ...this.heights.keys()])].sort(
      (a, b) => a - b,
    );
    for (const r of rowNos) {
      const h = this.heights.get(r);
      out += `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ""}>`;
      const cells = this.rows.get(r);
      for (const c of [...(cells?.keys() ?? [])].sort((a, b) => a - b)) {
        const cell = cells!.get(c)!;
        const ref = `${columnLetter(c)}${r}`;
        const f = cell.f ? `<f>${esc(cell.f)}</f>` : "";
        if (cell.v === undefined) out += `<c r="${ref}" s="${cell.s}"/>`;
        else if (typeof cell.v === "number") {
          out += `<c r="${ref}" s="${cell.s}">${f}<v>${cell.v}</v></c>`;
        } else if (cell.f) {
          out += `<c r="${ref}" s="${cell.s}" t="str">${f}<v>${esc(cell.v)}</v></c>`;
        } else {
          out += `<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
        }
      }
      out += "</row>";
    }
    return (
      out +
      '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
    );
  }
}

const DETAIL = "Все города";

/** Их build.mjs: листы месяцев и «Все города» → .xlsx. */
export async function buildTop10Workbook(
  data: Top10Data,
  months: string[],
  deflate?: Deflate,
): Promise<Uint8Array> {
  const cities = top10Rows(data).filter((r) => months.includes(r.month));
  const rowOf = new Map<Top10Row, number>();

  // «Все города».
  const detail = new SheetBuilder(
    [
      [1, 1, 13],
      [2, 2, 32],
      [3, 15, 18],
    ],
    { freezeRows: 4 },
  );
  detail.base(14, cities.length + 8);
  detail.set(2, 0, { v: `Города · ${top10MonthsLabel(months)}`, s: S.title });
  TOP10_DETAIL_HEADS.forEach((h, c) => detail.set(4, c, { v: h, s: S.header }));
  detail.height(4, 38);
  cities.forEach((r, i) => {
    const n = i + 5;
    rowOf.set(r, n);
    DETAIL_FIELDS.forEach((k, c) => {
      detail.set(n, c, { v: r[k], s: c < 2 ? S.base : S.int });
    });
    detail.set(n, 13, {
      v: rate(r.bought_day, r.day_base),
      f: `IF(E${n}=0,"—",F${n}/E${n})`,
      s: S.pct,
    });
    detail.set(n, 14, {
      v: rate(r.bought_14, r.window_base),
      f: `IF(G${n}=0,"—",H${n}/G${n})`,
      s: S.pct,
    });
  });

  // Листы месяцев.
  const notes = [top10SourceNote(data), ...TOP10_NOTES_STATIC];
  const monthSheets = months.map((month) => {
    const rows = cities.filter((r) => r.month === month);
    const s = new SheetBuilder(
      [
        [1, 1, 7],
        [2, 2, 31],
        [3, 5, 16],
        [6, 7, 3],
        [8, 8, 7],
        [9, 9, 31],
        [10, 12, 16],
      ],
      { tab: "FF593A85" },
    );
    s.base(11, 49);
    s.set(2, 0, { v: `${top10SheetName(month)} · топ-10 городов`, s: S.title });
    s.set(3, 0, {
      v: "Конверсия — по проценту; продления и возвращённые — по количеству покупок.",
      s: S.base,
    });
    for (const d of TOP10_RANKINGS) {
      s.set(d.r, d.col, { v: d.title, s: S.block });
      d.headers.forEach((h, k) => s.set(d.r + 1, d.col + k, { v: h, s: S.header }));
      s.height(d.r + 1, 38);
      top10Rank(rows, d).forEach((r, i) => {
        const target = d.r + 2 + i;
        const zebra = i % 2 === 0;
        s.set(target, d.col, { v: i + 1, s: zebra ? S.zebra : S.base });
        d.source.forEach((col, k) => {
          const c = d.col + 1 + k;
          const last = k === d.source.length - 1;
          const style =
            k === 0
              ? zebra
                ? S.zebra
                : S.base
              : d.den && last
                ? zebra
                  ? S.zebraPct
                  : S.pct
                : zebra
                  ? S.zebraInt
                  : S.int;
          s.set(target, c, {
            v: DETAIL_COLUMN[col](r),
            f: `'${DETAIL}'!${col}${rowOf.get(r)}`,
            s: style,
          });
        });
      });
    }
    notes.forEach((text, i) => {
      for (let c = 0; c <= 11; c++) s.style(37 + i, c, S.note);
      s.set(37 + i, 0, { v: text, s: S.note });
    });
    return { name: top10SheetName(month), xml: s.xml() };
  });

  const sheets = [...monthSheets, { name: DETAIL, xml: detail.xml() }];
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const enc = new TextEncoder();
  const files = [
    {
      name: "[Content_Types].xml",
      text:
        head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      text:
        head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      text:
        head +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets
          .map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text:
        head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    },
    { name: "xl/styles.xml", text: STYLES },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sh.xml })),
  ];
  return zip(
    files.map((f) => ({ name: f.name, data: enc.encode(f.text) })),
    deflate,
  );
}

// --- Месяцы ----------------------------------------------------------------------------

/** Месяцы «YYYY-MM» от `from` до `to` включительно. */
export function top10MonthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > last) break;
    out.push(key);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Месяцы в данных отчётов: от начала продаж или воронки до последних данных. */
export function top10MonthOptions(info: Omit<Top10Data, "rows">): string[] {
  const starts = [info.sales_min, info.funnel_min].filter((d): d is string => !!d).sort();
  const ends = [info.sales_max, info.funnel_max].filter((d): d is string => !!d).sort();
  if (!starts.length || !ends.length) return [];
  return top10MonthsBetween(starts[0], ends[ends.length - 1]);
}

/** Как их срез: два полных месяца перед месяцем последних продаж. */
export function top10DefaultMonths(info: Omit<Top10Data, "rows">): string[] {
  const options = top10MonthOptions(info);
  const lastMonth = (info.sales_max ?? "").slice(0, 7);
  const before = options.filter((m) => m < lastMonth);
  return before.length ? before.slice(-2) : options.slice(-2);
}
