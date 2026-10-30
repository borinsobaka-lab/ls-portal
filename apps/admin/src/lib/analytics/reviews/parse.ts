/**
 * Выгрузка оценок 1С → строки «Отзывов» — их reviews.py (`_records`,
 * `_rating`, `_date_text`, `_trainer_text`, отпечаток строки) как есть:
 * первая строка — заголовки, обязательные колонки по имени, пустые строки
 * пропускаются, оценка — число от 0 до 5, тренер — без пометок в скобках,
 * даты — ГГГГ-ММ-ДД, если 1С дала их в известном виде (иначе как есть).
 * Повтор строки узнаётся по SHA-256 её полей (`source_hash`) — база его не
 * добавит второй раз. Разбор — в браузере: файл в хранилище не уходит.
 */
import { openWorkbook, pyStrip, type Cell, type Inflate } from "../onec/xlsx-read";
import { readXls, type XlsValue } from "./xls-read";

export const MAX_REVIEWS_FILE_BYTES = 12 * 1024 * 1024;

/** Их REQUIRED_COLUMNS (необязательные — «Группа клиентов», «Возраст», «Пол»). */
const REQUIRED_COLUMNS = [
  "Клиент",
  "Занятие.Структурная единица",
  "Услуга",
  "Дата",
  "Время",
  "Тренер",
  "Дата оценки",
  "Оценка",
  "Комментарий",
];

export type ReviewRecord = {
  client_name: string;
  studio: string;
  service: string;
  class_date: string;
  class_time: string;
  trainer: string;
  rating_date: string;
  rating: number;
  comment: string;
  client_group: string;
  age: string;
  gender: string;
  source_hash: string;
};

/**
 * str(float) Python: «5.0», «4.5», «1e-07», «1e+16» — с порядком, если число
 * меньше 1e-4 или от 1e16 (у JS границы другие).
 */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Object.is(x, -0)) return "-0.0";
  const abs = Math.abs(x);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** Их _text: None → "", иначе str(value).strip(). */
function text(v: XlsValue | Cell | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return pyFloatStr(v);
  return pyStrip(String(v));
}

/** Их _trainer_text: без пометок «(…)» и лишних пробелов. */
export function trainerText(v: string): string {
  return pyStrip(
    pyStrip(v)
      .replace(/\s*\([^()]*\)/g, "")
      .replace(/\s+/g, " "),
  );
}

const DATE_PATTERNS: [RegExp, (m: RegExpMatchArray) => [string, string, string]][] = [
  [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (m) => [m[3], m[2], m[1]]],
  [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [m[1], m[2], m[3]]],
  [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [m[3], m[2], m[1]]],
];

/** Их _date_text: «%d.%m.%Y», «%Y-%m-%d», «%d/%m/%Y» → ГГГГ-ММ-ДД, иначе как есть. */
export function dateText(value: string): string {
  const v = pyStrip(value);
  for (const [re, parts] of DATE_PATTERNS) {
    const m = v.match(re);
    if (!m) continue;
    const [y, mo, d] = parts(m).map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (
      y >= 1 &&
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === mo - 1 &&
      date.getUTCDate() === d
    ) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return v;
}

/** Их _rating: число с точкой или запятой, от 0 до 5. */
export function ratingValue(value: string): number {
  const s = pyStrip(value.replace(/,/g, "."));
  if (/^[+-]?(inf|infinity)$/i.test(s)) throw new Error("Оценка должна быть числом от 0 до 5.");
  const n = /^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(s)
    ? Number(s.replace(/_/g, ""))
    : Number.NaN;
  if (Number.isNaN(n)) throw new Error("В колонке «Оценка» найдено нечисловое значение.");
  if (n < 0 || n > 5) throw new Error("Оценка должна быть числом от 0 до 5.");
  return n;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const utf8 = new TextEncoder();
const W = new Uint32Array(64);

/**
 * SHA-256 строки (UTF-8) шестнадцатеричной строкой — их hashlib.sha256 у
 * отпечатка. Синхронно: WebCrypto на 150 тысяч строк — секунды ожидания.
 */
export function sha256Hex(text: string): string {
  const msg = utf8.encode(text);
  const bitLen = msg.length * 8;
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** Их _xlsx_rows: первый лист книги, строки, где есть ячейки, текст как в XML. */
async function xlsxRows(bytes: Uint8Array, inflate: Inflate): Promise<string[][]> {
  try {
    const wb = await openWorkbook(bytes, inflate);
    if (!wb.sheets.length) throw new Error("В Excel-файле нет листов.");
    const sheet = await wb.open(0, { raw: true });
    const rows: string[][] = [];
    for await (const row of sheet.rows()) {
      if (!row.cells.length) continue;
      rows.push(row.cells.map((c) => (c === null ? "" : String(c))));
    }
    return rows;
  } catch (e) {
    if ((e as Error).message === "В Excel-файле нет листов.") throw e;
    throw new Error("Не удалось прочитать .xlsx-файл.");
  }
}

/** Их _records: строки выгрузки с проверками; ошибки — их тексты. */
export async function reviewRecords(
  fileName: string,
  bytes: Uint8Array,
  inflate: Inflate,
): Promise<ReviewRecord[]> {
  if (!bytes.length || bytes.length > MAX_REVIEWS_FILE_BYTES) {
    throw new Error("Загрузите Excel-файл размером не больше 12 МБ.");
  }
  const suffix = /\.[^./\\]*$/.exec(fileName)?.[0].toLowerCase() ?? "";
  let rows: (string | XlsValue)[][];
  if (suffix === ".xlsx") rows = await xlsxRows(bytes, inflate);
  else if (suffix === ".xls") {
    try {
      rows = readXls(bytes);
    } catch (e) {
      const m = (e as Error).message;
      throw new Error(
        m.startsWith("Файл .xls") || m.startsWith("В Excel")
          ? m
          : "Не удалось прочитать .xls-файл.",
      );
    }
  } else throw new Error("Загрузите выгрузку в формате .xls или .xlsx.");
  if (!rows.length) throw new Error("Выгрузка пуста.");

  // Их dict: при одинаковых заголовках — последний столбец.
  const headers = new Map<string, number>();
  rows[0].forEach((v, i) => headers.set(text(v), i));
  const missing = REQUIRED_COLUMNS.filter((label) => !headers.has(label));
  if (missing.length) throw new Error(`Не найдены обязательные колонки: ${missing.join(", ")}.`);

  const result: ReviewRecord[] = [];
  const labels = [...headers.keys()];
  for (let n = 1; n < rows.length; n++) {
    const row = rows[n];
    const item = (name: string) => {
      const i = headers.get(name);
      return i !== undefined && i < row.length ? text(row[i]) : "";
    };
    if (!labels.some((label) => item(label))) continue;
    const record = {
      client_name: item("Клиент"),
      studio: item("Занятие.Структурная единица"),
      service: item("Услуга"),
      class_date: dateText(item("Дата")),
      class_time: item("Время"),
      trainer: trainerText(item("Тренер")),
      rating_date: dateText(item("Дата оценки")),
      comment: item("Комментарий"),
      client_group: item("Группа клиентов"),
      age: item("Возраст"),
      gender: item("Пол"),
      rating: ratingValue(item("Оценка")),
    };
    if (!record.client_name || !record.studio || !record.class_date || !record.rating_date) {
      throw new Error(`Строка ${n + 1}: заполните клиента, студию, дату занятия и дату оценки.`);
    }
    const fingerprint = [
      record.client_name,
      record.studio,
      record.service,
      record.class_date,
      record.class_time,
      record.trainer,
      record.rating_date,
      pyFloatStr(record.rating),
      record.comment,
    ].join("\x1f");
    result.push({ ...record, source_hash: sha256Hex(fingerprint) });
  }
  if (!result.length) throw new Error("В выгрузке нет строк с оценками.");
  return result;
}

/** Их periods: первая и последняя дата оценки (строками). */
export function reviewPeriod(records: ReviewRecord[]): { from: string; to: string } {
  const dates = records.map((r) => r.rating_date).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };
}
