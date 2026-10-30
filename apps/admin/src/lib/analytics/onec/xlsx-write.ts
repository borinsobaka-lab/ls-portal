/**
 * Запись простого .xlsx — как openpyxl `Workbook(write_only=True)`: значения
 * без оформления, строки — встроенные (inlineStr), пустые ячейки не пишутся.
 * Нужна для выгрузки справочников «Обработки 1С» в их Excel-формате,
 * «Очистки Excel» и тестов. Сжатие (deflate-raw) даёт вызывающий; без него
 * части книги кладутся в zip без сжатия.
 */
import { XlsxDate, type Cell } from "./xlsx-read";

export type XlsxSheet = {
  name: string;
  rows: Cell[][];
  /** Ширина столбцов (как column_dimensions[…].width у openpyxl). */
  widths?: number[];
  /** Перенос текста в первой строке (ExcelCleaner делает так для шапки). */
  wrapHeader?: boolean;
  /** Высота строк по умолчанию. */
  defaultRowHeight?: number;
};

export type Deflate = (data: Uint8Array) => Promise<Uint8Array>;

const enc = new TextEncoder();

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Буквы столбца по номеру с нуля (0 → A). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Дата-время → серийный номер Excel (система 1900). */
export function dateToSerial(value: string): number {
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const hh = Number(value.slice(11, 13) || 0);
  const mi = Number(value.slice(14, 16) || 0);
  const ss = Number(value.slice(17, 19) || 0);
  const ms = Date.UTC(y, m - 1, d, hh, mi, ss) - Date.UTC(1899, 11, 30);
  const serial = ms / 86_400_000;
  return serial < 61 ? serial - 1 : serial;
}

function sheetXml(sheet: XlsxSheet): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  ];
  parts.push(`<sheetFormatPr defaultRowHeight="${sheet.defaultRowHeight ?? 15}"/>`);
  if (sheet.widths?.length) {
    parts.push("<cols>");
    sheet.widths.forEach((w, i) =>
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`),
    );
    parts.push("</cols>");
  }
  parts.push("<sheetData>");
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((v, c) => {
      const ref = `${columnLetter(c)}${r + 1}`;
      const style = sheet.wrapHeader && r === 0 ? ' s="1"' : "";
      if (v === null || v === undefined) {
        if (style) cells.push(`<c r="${ref}"${style}/>`);
        return;
      }
      if (typeof v === "string") {
        cells.push(
          `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
        );
      } else if (typeof v === "number") {
        cells.push(`<c r="${ref}"${style} t="n"><v>${Number.isFinite(v) ? v : 0}</v></c>`);
      } else if (typeof v === "boolean") {
        cells.push(`<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`);
      } else if (v instanceof XlsxDate) {
        cells.push(`<c r="${ref}" s="2" t="n"><v>${dateToSerial(v.value)}</v></c>`);
      }
    });
    parts.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss"/></numFmts>' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function workbookXml(sheets: XlsxSheet[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (s, i) =>
          `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("") +
    "</sheets></workbook>"
  );
}

function workbookRels(sheets: XlsxSheet[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>"
  );
}

function contentTypes(sheets: XlsxSheet[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
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
    "</Types>"
  );
}

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

// --- zip --------------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function zip(
  files: { name: string; data: Uint8Array }[],
  deflate?: Deflate,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const packed = deflate ? await deflate(f.data) : f.data;
    const method = deflate ? 8 : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // имена в UTF-8
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, packed);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, packed.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + packed.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export async function writeXlsx(sheets: XlsxSheet[], deflate?: Deflate): Promise<Uint8Array> {
  const files = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes(sheets)) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels(sheets)) },
    { name: "xl/styles.xml", data: enc.encode(STYLES) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(s)),
    })),
  ];
  return zip(files, deflate);
}
