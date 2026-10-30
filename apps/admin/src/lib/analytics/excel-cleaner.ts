/**
 * «Очистка Excel» — их ExcelCleaner 1.1-fast (`clean_excel_gui.py`,
 * `clean_workbook`): каждый лист книги переписывается в новый плоский .xlsx
 * только из данных — без объединений и группировок, без полностью пустых
 * строк и столбцов, ширина столбцов 20, высота строк по умолчанию 20, в
 * первой (шапке) строке — перенос текста и выравнивание по верху. Отчёт по
 * листам — как у них: объединения и группировки считаются по XML листа,
 * пустые строки и столбцы — по размерам листа (`<dimension>`).
 *
 * Значения — как у openpyxl: книга читается с `data_only=False` (у ячейки с
 * формулой — «=формула»), строки за пределами `<dimension>` не читаются,
 * числа пишутся с 16 значащими цифрами, даты — числом с форматом
 * «yyyy-mm-dd h:mm:ss», строка с «=» в начале становится формулой, а
 * «#N/A» и другие коды ошибок — ошибкой.
 *
 * Работает в браузере (lib/analytics/excel-cleaner.worker.ts): файл никуда не
 * отправляется. Распаковку и сжатие даёт вызывающий.
 */
import { XlsxDate, openWorkbook, type Cell, type Inflate } from "./onec/xlsx-read";
import { columnLetter, crc32, dateToSerial, zipParts, type ZipPart } from "./onec/xlsx-write";

export const CLEANER_VERSION = "1.1-fast";
const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_COLUMN_WIDTH = 20;

export type SheetReport = {
  name: string;
  mergedRangesRemoved: number;
  emptyColumnsRemoved: number;
  emptyRowsRemoved: number;
  outlineItemsCleared: number;
};

export type CleanProgress = (done: number, total: number, message: string) => void;

/** Сжать поток (deflate-raw) — куски сжатых данных по порядку. */
export type DeflateStream = (source: AsyncIterable<Uint8Array>) => Promise<Uint8Array[]>;

/** Их has_value: не None и не строка из пробелов. */
function hasValue(v: Cell) {
  if (v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

/** Их default_output_path: «<имя>_очищено.xlsx». */
export function defaultOutputName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, "");
  return `${stem}_очищено.xlsx`;
}

/** Их format_report. */
export function formatReport(report: SheetReport[]): string {
  const lines = ["Готово. Отчет по листам:"];
  for (const s of report) {
    lines.push(
      `- ${s.name}:`,
      `объединений убрано - ${s.mergedRangesRemoved}`,
      `группировок строк/столбцов сброшено - ${s.outlineItemsCleared}`,
      `пустых столбцов удалено - ${s.emptyColumnsRemoved}`,
      `пустых строк удалено - ${s.emptyRowsRemoved}`,
    );
  }
  return lines.join("\n");
}

/** Их ProgressTracker: шаги, проценты, сообщение. */
class Tracker {
  private done = 0;
  constructor(
    private readonly total: number,
    private readonly cb?: CleanProgress,
  ) {}
  step(amount: number, message: string) {
    this.done = Math.min(this.done + amount, this.total);
    this.cb?.(this.done, this.total, message);
  }
  finish(message: string) {
    this.done = this.total;
    this.cb?.(this.done, this.total, message);
  }
}

const ERROR_CODES = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);
/** openpyxl ILLEGAL_CHARACTERS_RE (\x00-\x08, \x0b, \x0c, \x0e-\x1f): такая ячейка — ошибка записи. */
function hasIllegalChar(s: string) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Число так, как его пишет openpyxl («%.16g»). */
function num(v: number) {
  return Number.isFinite(v) ? String(Number(v.toPrecision(16))) : "";
}

/** Ячейка очищенного листа (их WriteOnlyCell / значение в append). */
function cellXml(ref: string, v: Cell, header: boolean, sheet: string): string {
  const style = header ? ' s="1"' : "";
  if (v === null) return header ? `<c r="${ref}"${style}/>` : "";
  if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number") return `<c r="${ref}"${style} t="n"><v>${num(v)}</v></c>`;
  if (v instanceof XlsxDate) {
    // Серийный номер меньше 1 openpyxl читает как время (datetime.time) — формат «h:mm:ss» (21).
    const time = v.value.startsWith("1899-12-31");
    const s = time ? (header ? 5 : 4) : header ? 3 : 2;
    return `<c r="${ref}" s="${s}" t="n"><v>${num(dateToSerial(v.value))}</v></c>`;
  }
  const s = v.length > 32767 ? v.slice(0, 32767) : v;
  if (s === "") return `<c r="${ref}"${style} t="inlineStr"/>`;
  if (hasIllegalChar(s)) {
    throw new Error(
      `Лист «${sheet}», ячейка ${ref}: недопустимый символ — такую ячейку Excel не сохранит.`,
    );
  }
  if (s.length > 1 && s.startsWith("="))
    return `<c r="${ref}"${style}><f>${esc(s.slice(1))}</f><v></v></c>`;
  if (ERROR_CODES.has(s)) return `<c r="${ref}"${style} t="e"><v>${esc(s)}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss"/></numFmts>' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const enc = new TextEncoder();

function xmlAttr(s: string) {
  return esc(s).replace(/"/g, "&quot;");
}

function workbookFiles(names: string[]): { name: string; text: string }[] {
  const sheets = names
    .map((n, i) => `<sheet name="${xmlAttr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const rels = names
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  const overrides = names
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return [
    {
      name: "[Content_Types].xml",
      text:
        head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        overrides +
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
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheets}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text:
        head +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rels +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    },
    { name: "xl/styles.xml", text: STYLES },
  ];
}

type SheetPlan = {
  name: string;
  keptColumns: number[];
  nonEmptyRows: Set<number>;
  maxRow: number | null;
  maxColumn: number | null;
};

/**
 * Их clean_workbook: проход 1 — пустые строки и столбцы каждого листа и
 * отчёт; проход 2 — новый плоский лист потоком (сжатие кусками, в памяти —
 * только сжатый результат).
 */
export async function cleanWorkbook(
  fileName: string,
  bytes: Uint8Array,
  io: { inflate: Inflate; deflate: DeflateStream },
  onProgress?: CleanProgress,
): Promise<{ report: SheetReport[]; output: Uint8Array }> {
  if (!/\.xlsx$/i.test(fileName)) throw new Error("Сейчас поддерживаются только файлы .xlsx");
  onProgress?.(0, 1, "Быстрый режим: анализирую структуру файла");

  const book = await openWorkbook(bytes, io.inflate);
  const features = await Promise.all(
    book.sheets.map((_, i) => book.features(i).catch(() => ({ merged: 0, outline: 0 }))),
  );
  const opened = await Promise.all(book.sheets.map((_, i) => book.open(i, { formulas: true })));
  const totalRows = opened.reduce((n, s) => n + Math.max(s.maxRow ?? 0, 1), 0);
  const progress = new Tracker(totalRows * 2 + 2, onProgress);
  progress.step(1, "Файл открыт в потоковом режиме");

  const plans: SheetPlan[] = [];
  const report: SheetReport[] = [];
  for (let i = 0; i < book.sheets.length; i++) {
    const { name } = book.sheets[i];
    const sheet = opened[i];
    const maxRow = sheet.maxRow ?? null;
    const maxColumn = sheet.maxColumn;
    const nonEmptyColumns = new Set<number>();
    const nonEmptyRows = new Set<number>();
    let scanned = 0;
    let reported = 0;
    for await (const row of sheet.rows()) {
      if (maxRow !== null && row.r > maxRow) break;
      scanned = row.r;
      const width = maxColumn ?? row.cells.length;
      let has = false;
      for (let c = 0; c < Math.min(width, row.cells.length); c++) {
        if (hasValue(row.cells[c])) {
          has = true;
          nonEmptyColumns.add(c);
        }
      }
      if (has) nonEmptyRows.add(row.r);
      while (scanned - reported >= 1000) {
        reported += 1000;
        progress.step(1000, `${name}: ищу пустые строки и столбцы`);
      }
    }
    if (scanned % 1000) progress.step(scanned % 1000, `${name}: ищу пустые строки и столбцы`);
    const keptColumns = [...nonEmptyColumns].sort((a, b) => a - b);
    const rowsTotal = maxRow ?? scanned;
    const colsTotal =
      maxColumn ?? (keptColumns.length ? keptColumns[keptColumns.length - 1] + 1 : 0);
    plans.push({ name, keptColumns, nonEmptyRows, maxRow, maxColumn });
    report.push({
      name,
      mergedRangesRemoved: features[i].merged,
      emptyColumnsRemoved: Math.max(colsTotal - keptColumns.length, 0),
      emptyRowsRemoved: Math.max(rowsTotal - nonEmptyRows.size, 0),
      outlineItemsCleared: features[i].outline,
    });
  }

  const parts: ZipPart[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const sheet = await book.open(i, { formulas: true });
    let crc = 0;
    let size = 0;
    async function* xml(): AsyncIterable<Uint8Array> {
      const emit = (text: string) => {
        const data = enc.encode(text);
        crc = crc32(data, crc);
        size += data.length;
        return data;
      };
      let head =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetFormatPr baseColWidth="8" defaultRowHeight="${DEFAULT_ROW_HEIGHT}"/>`;
      if (plan.keptColumns.length) {
        head += "<cols>";
        for (let c = 1; c <= plan.keptColumns.length; c++) {
          head += `<col min="${c}" max="${c}" width="${DEFAULT_COLUMN_WIDTH}" customWidth="1"/>`;
        }
        head += "</cols>";
      }
      yield emit(head + "<sheetData>");
      let written = 0;
      let buf = "";
      let lastRow = 0;
      for await (const row of sheet.rows()) {
        if (plan.maxRow !== null && row.r > plan.maxRow) break;
        for (let r = lastRow + 1; r <= row.r; r++) {
          if (r % 1000 === 0) progress.step(1000, `${plan.name}: записываю очищенный лист`);
        }
        lastRow = row.r;
        if (!plan.nonEmptyRows.has(row.r)) continue;
        const header = written === 0;
        written++;
        let cells = "";
        plan.keptColumns.forEach((src, k) => {
          const v = src < row.cells.length ? row.cells[src] : null;
          cells += cellXml(`${columnLetter(k)}${written}`, v ?? null, header, plan.name);
        });
        buf += `<row r="${written}">${cells}</row>`;
        if (buf.length > 256 * 1024) {
          yield emit(buf);
          buf = "";
        }
      }
      const remaining = (plan.maxRow ?? 0) % 1000;
      if (remaining) progress.step(remaining, `${plan.name}: записываю очищенный лист`);
      yield emit(buf + "</sheetData></worksheet>");
    }
    const packed = await io.deflate(xml());
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, packed, crc, size, deflated: true });
  }

  progress.step(1, "Сохраняю новый быстрый .xlsx");
  const meta: ZipPart[] = [];
  for (const f of workbookFiles(plans.map((p) => p.name))) {
    const data = enc.encode(f.text);
    const packed = await io.deflate(
      (async function* () {
        yield data;
      })(),
    );
    meta.push({ name: f.name, packed, crc: crc32(data), size: data.length, deflated: true });
  }
  const output = zipParts([...meta, ...parts]);
  progress.finish("Готово");
  return { report, output };
}
