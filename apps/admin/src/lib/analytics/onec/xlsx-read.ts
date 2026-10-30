/**
 * Потоковое чтение .xlsx — выгрузки 1С бывают по 150 МБ XML в листе, целиком
 * их не держим. Значения ячеек — как у openpyxl (`load_workbook(read_only=True,
 * data_only=True)`, которым читает старый обработчик Lady Stretch): строки
 * общей таблицы и встроенные, числа (`int` / `float` — у нас number), логические,
 * даты по числовому формату ячейки, кэш формул. Лист — активный (как
 * `workbook.active`).
 *
 * Без зависимостей: zip разбирается здесь, распаковку (deflate-raw) даёт
 * вызывающий — на сервере node:zlib, в браузере DecompressionStream.
 */

export type Cell = string | number | boolean | XlsxDate | null;

/** Дата-время ячейки с форматом даты (openpyxl отдаёт datetime). */
export class XlsxDate {
  constructor(
    /** «YYYY-MM-DD HH:MM:SS» (секунды округлены, как у openpyxl до миллисекунд). */
    readonly value: string,
  ) {}
  get day() {
    return this.value.slice(0, 10);
  }
  toString() {
    return this.value;
  }
}

export type XlsxRow = { r: number; cells: Cell[] };

/** Распаковать deflate-raw потоком. */
export type Inflate = (data: Uint8Array) => AsyncIterable<Uint8Array>;

type ZipEntry = { name: string; method: number; offset: number; size: number; usize: number };

function u16(b: Uint8Array, i: number) {
  return b[i] | (b[i + 1] << 8);
}
function u32(b: Uint8Array, i: number) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Файл не похож на .xlsx (нет оглавления zip)");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (p === 0xffffffff) throw new Error("Слишком большой .xlsx (zip64 не поддерживается)");
  const names = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("Повреждённое оглавление .xlsx");
    const method = u16(b, p + 10);
    const size = u32(b, p + 20);
    const usize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = names.decode(b.subarray(p + 46, p + 46 + nameLen));
    if (size === 0xffffffff || local === 0xffffffff) {
      throw new Error("Слишком большой .xlsx (zip64 не поддерживается)");
    }
    const dataStart = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    out.set(name.replace(/^\/+/, ""), { name, method, offset: dataStart, size, usize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function* entryBytes(
  b: Uint8Array,
  e: ZipEntry,
  inflate: Inflate,
): AsyncIterable<Uint8Array> {
  const data = b.subarray(e.offset, e.offset + e.size);
  if (e.method === 0) {
    yield data;
    return;
  }
  if (e.method !== 8) throw new Error(`Неподдерживаемое сжатие в .xlsx (${e.method})`);
  yield* inflate(data);
}

async function* entryText(b: Uint8Array, e: ZipEntry, inflate: Inflate): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of entryBytes(b, e, inflate)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function entryString(b: Uint8Array, e: ZipEntry, inflate: Inflate): Promise<string> {
  let s = "";
  for await (const t of entryText(b, e, inflate)) s += t;
  return s;
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML-сущности (у файлов после ExcelCleaner — числовые: «&#1050;» на каждую букву). */
export function xmlUnescape(s: string): string {
  let amp = s.indexOf("&");
  if (amp < 0) return s;
  let out = "";
  let last = 0;
  const codes: number[] = [];
  const flushCodes = () => {
    if (codes.length) {
      for (let i = 0; i < codes.length; i += 8192) {
        out += String.fromCodePoint(...codes.slice(i, i + 8192));
      }
      codes.length = 0;
    }
  };
  while (amp >= 0) {
    const semi = s.indexOf(";", amp);
    if (semi < 0) break;
    let code = -1;
    if (s.charCodeAt(amp + 1) === 35) {
      // &#…;
      const hex = s.charCodeAt(amp + 2) === 120; // x
      let n = 0;
      let ok = semi > amp + (hex ? 3 : 2);
      for (let i = amp + (hex ? 3 : 2); i < semi && ok; i++) {
        const c = s.charCodeAt(i);
        if (c >= 48 && c <= 57) n = n * (hex ? 16 : 10) + (c - 48);
        else if (hex && c >= 97 && c <= 102) n = n * 16 + (c - 87);
        else if (hex && c >= 65 && c <= 70) n = n * 16 + (c - 55);
        else ok = false;
      }
      if (ok) code = n;
    } else {
      const name = s.slice(amp + 1, semi);
      const ch = ENTITY[name];
      if (ch !== undefined) code = ch.charCodeAt(0);
    }
    if (code < 0) {
      amp = s.indexOf("&", amp + 1);
      continue;
    }
    if (amp > last) {
      flushCodes();
      out += s.slice(last, amp);
    }
    codes.push(code);
    last = semi + 1;
    amp = s.indexOf("&", last);
  }
  flushCodes();
  return last < s.length ? out + s.slice(last) : out;
}

function attr(tag: string, name: string): string | null {
  const key = " " + name + '="';
  let i = tag.indexOf(key);
  if (i < 0) {
    const alt = "\t" + name + '="';
    i = tag.indexOf(alt);
    if (i < 0) {
      const nl = "\n" + name + '="';
      i = tag.indexOf(nl);
      if (i < 0) return null;
    }
  }
  const start = i + key.length;
  const end = tag.indexOf('"', start);
  return end < 0 ? null : tag.slice(start, end);
}

/** Буквы столбца → номер с нуля (A → 0). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

// --- Форматы дат (openpyxl.styles.numbers.is_date_format) ---------------------------

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/gi, "");
  return /[dmhysDMHYS]/.test(stripped);
}

function parseStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = attr(m[0], "numFmtId");
    const code = attr(m[0], "formatCode");
    if (id !== null && code !== null) custom.set(Number(id), xmlUnescape(code));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return [];
  const out: boolean[] = [];
  for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = custom.get(id);
    out.push(code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

/** Серийный номер Excel → «YYYY-MM-DD HH:MM:SS» (как openpyxl.utils.datetime.from_excel). */
export function excelSerialToDate(serial: number, date1904: boolean): XlsxDate {
  let days = Math.floor(serial);
  const frac = serial - days;
  if (date1904) days += 1462;
  // Ошибка Excel с 29.02.1900: до 60-го дня сдвига нет.
  const base = Date.UTC(1899, 11, days < 60 && !date1904 ? 31 : 30);
  const ms = Math.round(frac * 86_400_000);
  const d = new Date(base + days * 86_400_000 + ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return new XlsxDate(
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  );
}

// --- Разбор XML по байтам ------------------------------------------------------
// Текст ячеек декодируется из байтов в новые строки: срезы большой строки
// держали бы в памяти весь распакованный кусок XML (у листа — до 150 МБ).

const LT = 60; // <
const GT = 62; // >
const SLASH = 47; // /
const utf8 = new TextDecoder("utf-8");

/** Имя тега и признаки: «/» в начале (закрывающий) и в конце (пустой). */
function tagInfo(data: Uint8Array, a: number, b: number) {
  const closing = data[a] === SLASH;
  const i = closing ? a + 1 : a;
  // Частые имена — без сборки строки.
  const c0 = data[i];
  const c1 = i + 1 < b ? data[i + 1] : 32;
  const end1 = c1 === 32 || c1 === 9 || c1 === 10 || c1 === 13 || c1 === SLASH || i + 1 >= b;
  let name: string;
  if (end1 && c0 === 99) name = "c";
  else if (end1 && c0 === 118) name = "v";
  else if (end1 && c0 === 116) name = "t";
  else if (end1 && c0 === 102) name = "f";
  else {
    name = "";
    for (let k = i; k < b; k++) {
      const c = data[k];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === SLASH) break;
      name += String.fromCharCode(c);
    }
  }
  return { closing, name, empty: !closing && data[b - 1] === SLASH };
}

/** Тег целиком строкой (у ячеек и строк листа — только ASCII). */
function tagText(data: Uint8Array, a: number, b: number) {
  let s = "";
  for (let i = a; i < b; i++) s += String.fromCharCode(data[i]);
  return s;
}

async function* xmlChunks(
  b: Uint8Array,
  e: ZipEntry,
  inflate: Inflate,
): AsyncIterable<{ data: Uint8Array; tags: [number, number, number][] }> {
  // tags: [начало текста перед тегом, «<», «>»]
  let carry: Uint8Array | null = null;
  for await (const chunk of entryBytes(b, e, inflate)) {
    let data: Uint8Array;
    if (carry && carry.length) {
      data = new Uint8Array(carry.length + chunk.length);
      data.set(carry);
      data.set(chunk, carry.length);
    } else data = chunk;
    const tags: [number, number, number][] = [];
    let pos = 0;
    for (;;) {
      const lt = data.indexOf(LT, pos);
      if (lt < 0) break;
      const gt = data.indexOf(GT, lt);
      if (gt < 0) break;
      tags.push([pos, lt, gt]);
      pos = gt + 1;
    }
    carry = data.slice(pos);
    yield { data, tags };
  }
}

async function sharedStrings(b: Uint8Array, e: ZipEntry | undefined, inflate: Inflate) {
  const out: string[] = [];
  if (!e) return out;
  let inSi = false;
  let inT = false;
  let skip = 0; // внутри <rPh> (фонетика) — openpyxl её не берёт
  let cur = "";
  for await (const { data, tags } of xmlChunks(b, e, inflate)) {
    for (const [pos, lt, gt] of tags) {
      if (inT && skip === 0 && lt > pos) cur += utf8.decode(data.subarray(pos, lt));
      const { closing, name, empty } = tagInfo(data, lt + 1, gt);
      if (closing) {
        if (name === "t") inT = false;
        else if (name === "rPh") skip--;
        else if (name === "si") {
          out.push(xmlUnescape(cur));
          inSi = false;
        }
        continue;
      }
      if (name === "si") {
        inSi = true;
        cur = "";
        if (empty) {
          out.push("");
          inSi = false;
        }
      } else if (name === "t" && inSi && !empty) inT = true;
      else if (name === "rPh" && !empty) skip++;
    }
  }
  return out;
}

export type XlsxBook = {
  /** Строки активного листа по порядку; пустые строки между ними не выдаются. */
  rows: () => AsyncIterable<XlsxRow>;
  /** Наибольший столбец по `<dimension>` (с единицы), если указан. */
  maxColumn: number | null;
};

function resolveTarget(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

export async function openXlsx(
  bytes: Uint8Array,
  inflate: Inflate,
  opts: { sheet?: "active" | "first" } = {},
): Promise<XlsxBook> {
  const entries = zipEntries(bytes);
  const get = (name: string) => entries.get(name);
  const workbook = get("xl/workbook.xml");
  if (!workbook) throw new Error("В .xlsx нет книги (xl/workbook.xml)");
  const wbXml = await entryString(bytes, workbook, inflate);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wbXml);
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    rid: attr(m[0], "r:id") ?? attr(m[0], "id"),
    state: attr(m[0], "state"),
  }));
  const activeTab =
    opts.sheet === "first"
      ? 0
      : Number(/<workbookView\b[^>]*\bactiveTab="(\d+)"/.exec(wbXml)?.[1] ?? 0);
  const sheet = sheets[activeTab] ?? sheets[0];
  let sheetPath = "xl/worksheets/sheet1.xml";
  const relsEntry = get("xl/_rels/workbook.xml.rels");
  if (sheet?.rid && relsEntry) {
    const rels = await entryString(bytes, relsEntry, inflate);
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], "Id") === sheet.rid) {
        const target = attr(m[0], "Target");
        if (target) sheetPath = resolveTarget("xl/workbook.xml", target);
      }
    }
  }
  const found = get(sheetPath);
  if (!found) throw new Error("В .xlsx нет листа");
  const sheetEntry: ZipEntry = found;
  const stylesEntry = get("xl/styles.xml");
  const dateStyles = stylesEntry ? parseStyles(await entryString(bytes, stylesEntry, inflate)) : [];
  const strings = await sharedStrings(bytes, get("xl/sharedStrings.xml"), inflate);

  // <dimension ref="A1:F220766"> (у 1С бывает просто «F220766»).
  let maxColumn: number | null = null;
  {
    let head = "";
    for await (const t of entryText(bytes, sheetEntry, inflate)) {
      head += t;
      if (head.length > 4096 || head.includes("<sheetData")) break;
    }
    const dim = /<dimension\b[^>]*\bref="([^"]+)"/.exec(head)?.[1];
    if (dim) maxColumn = columnIndex(dim.split(":").pop()!) + 1;
  }

  async function* rows(): AsyncIterable<XlsxRow> {
    let rowNo = 0;
    let cells: Cell[] = [];
    let inRow = false;
    let col = -1;
    let type = "n";
    let style = 0;
    let inV = false;
    let inT = false;
    let skip = 0;
    let raw: string | null = null;
    let text = "";
    let hasValue = false;

    const finishCell = () => {
      let value: Cell = null;
      if (type === "inlineStr") value = hasValue ? xmlUnescape(text) : null;
      else if (raw !== null) {
        const v = raw;
        if (type === "s") value = strings[Number(v)] ?? null;
        else if (type === "str") value = xmlUnescape(v);
        else if (type === "b") value = v === "1" || v === "true";
        else if (type === "e") value = xmlUnescape(v);
        else if (type === "d") {
          const s = v.replace("T", " ");
          value = new XlsxDate((s.length === 10 ? s + " 00:00:00" : s).slice(0, 19));
        } else if (v !== "") {
          const n = Number(v);
          value = dateStyles[style] ? excelSerialToDate(n, date1904) : n;
        }
      }
      if (col < 0) col = cells.length;
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    };

    for await (const { data, tags } of xmlChunks(bytes, sheetEntry, inflate)) {
      const ready: XlsxRow[] = [];
      for (const [pos, lt, gt] of tags) {
        if (lt > pos) {
          if (inV) raw = (raw ?? "") + utf8.decode(data.subarray(pos, lt));
          else if (inT && skip === 0) {
            text += utf8.decode(data.subarray(pos, lt));
            hasValue = true;
          }
        }
        const { closing, name, empty } = tagInfo(data, lt + 1, gt);
        if (closing) {
          if (name === "v") inV = false;
          else if (name === "t") inT = false;
          else if (name === "rPh") skip--;
          else if (name === "c") finishCell();
          else if (name === "row") {
            inRow = false;
            ready.push({ r: rowNo, cells });
          }
          continue;
        }
        if (name === "c") {
          const tag = tagText(data, lt + 1, gt);
          const ref = attr(tag, "r");
          col = ref ? columnIndex(ref) : cells.length;
          type = attr(tag, "t") ?? "n";
          style = Number(attr(tag, "s") ?? 0);
          raw = null;
          text = "";
          hasValue = false;
          if (empty) finishCell();
        } else if (name === "v") {
          raw = "";
          inV = !empty;
        } else if (name === "t") {
          if (!empty) inT = true;
          else hasValue = true;
        } else if (name === "rPh") {
          if (!empty) skip++;
        } else if (name === "row") {
          const r = attr(tagText(data, lt + 1, gt), "r");
          rowNo = r ? Number(r) : rowNo + 1;
          cells = [];
          inRow = !empty;
          if (empty) ready.push({ r: rowNo, cells });
        }
      }
      for (const row of ready) yield row;
    }
    if (inRow) yield { r: rowNo, cells };
  }

  return { rows, maxColumn };
}

/**
 * Строки как `ws.iter_rows(min_row, max_col, values_only=True)` у openpyxl:
 * с номера min_row, ровно max_col значений (или по ширине листа), пропущенные
 * строки — пустыми (все null).
 */
export async function* iterRows(
  book: XlsxBook,
  opts: { minRow?: number; maxCol?: number } = {},
): AsyncIterable<Cell[]> {
  const minRow = opts.minRow ?? 1;
  const width = opts.maxCol ?? null;
  let next = minRow;
  for await (const row of book.rows()) {
    if (row.r < minRow) continue;
    const w = width ?? Math.max(book.maxColumn ?? 0, row.cells.length);
    while (next < row.r) {
      yield new Array<Cell>(w).fill(null);
      next++;
    }
    const cells = row.cells.length >= w ? row.cells.slice(0, w) : row.cells;
    while (cells.length < w) cells.push(null);
    yield cells;
    next = row.r + 1;
  }
}

// --- «Очищенный» вид (ExcelCleaner 1.1-fast) ---------------------------------------

/** has_value ExcelCleaner: не None и не строка из пробелов. */
function hasValue(v: Cell) {
  if (v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

/** Что оставит ExcelCleaner: непустые столбцы и номера пустых строк. */
export type CleanPlan = { columns: number[]; emptyRows: number[] };

export async function cleanPlan(book: XlsxBook): Promise<CleanPlan> {
  const columns = new Set<number>();
  const emptyRows: number[] = [];
  let next = 1;
  for await (const row of book.rows()) {
    for (; next < row.r; next++) emptyRows.push(next);
    let has = false;
    for (let i = 0; i < row.cells.length; i++) {
      if (hasValue(row.cells[i])) {
        has = true;
        columns.add(i);
      }
    }
    if (!has) emptyRows.push(row.r);
    next = row.r + 1;
  }
  return { columns: [...columns].sort((a, b) => a - b), emptyRows };
}

/** Число после записи openpyxl («%.16g»). */
function roundTrip16(v: number) {
  return Number.isInteger(v) || !Number.isFinite(v) ? v : Number(v.toPrecision(16));
}

/**
 * Лист так, как его прочитает обработчик после ExcelCleaner: без пустых
 * строк и столбцов, строки по порядку с 1, числа — с 16 значащими цифрами,
 * строка с «=» в начале — формула без значения (None). Для уже очищенного
 * файла ничего не меняет. Книгу открывать с `sheet: "first"`: очищенная
 * книга начинается с первого листа.
 */
export function cleanedView(book: XlsxBook, plan: CleanPlan): XlsxBook {
  const empty = new Set(plan.emptyRows);
  async function* rows(): AsyncIterable<XlsxRow> {
    let n = 0;
    for await (const row of book.rows()) {
      if (empty.has(row.r)) continue;
      n++;
      const cells: Cell[] = plan.columns.map((c) => {
        const v = row.cells[c] ?? null;
        if (typeof v === "number") return roundTrip16(v);
        if (typeof v === "string" && v.length > 1 && v.startsWith("=")) return null;
        return v;
      });
      // write_only не пишет пустые ячейки — кроме первой (шапки) строки.
      if (n > 1) while (cells.length && cells[cells.length - 1] === null) cells.pop();
      yield { r: n, cells };
    }
  }
  return { rows, maxColumn: null };
}
