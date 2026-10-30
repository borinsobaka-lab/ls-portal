/**
 * Чтение старого формата Excel (.xls, BIFF8 внутри контейнера OLE2) — для
 * выгрузки оценок 1С. Их reviews.py читал .xls через xlrd:
 * `open_workbook(file_contents=…).sheet_by_index(0)` и `cell_value` по всем
 * строкам и столбцам. Здесь то же: первый рабочий лист, числа — числами
 * (даты в .xls — тоже числа, как у xlrd), логические — 1/0, ошибки — код
 * ошибки, пустая ячейка — "". Без зависимостей.
 */

export type XlsValue = string | number;

const END_OF_CHAIN = 0xfffffffe;

function fail(): never {
  throw new Error("Не удалось прочитать .xls-файл.");
}

// --- Контейнер OLE2 (Compound File Binary) ------------------------------------------

function cfbStream(bytes: Uint8Array, names: string[]): Uint8Array {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < 512 || sig.some((b, i) => bytes[i] !== b)) fail();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  let difatSector = dv.getUint32(0x44, true);
  const sectors = Math.floor((bytes.length - sectorSize) / sectorSize);
  const sectorAt = (n: number) => {
    if (n >= sectors) fail();
    const start = (n + 1) * sectorSize;
    return bytes.subarray(start, start + sectorSize);
  };

  // DIFAT: 109 номеров в заголовке и цепочка секторов DIFAT.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) fatSectors.push(dv.getUint32(0x4c + i * 4, true));
  for (let guard = 0; difatSector < END_OF_CHAIN - 1 && guard < sectors; guard++) {
    const s = sectorAt(difatSector);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) fatSectors.push(sv.getUint32(i * 4, true));
    difatSector = sv.getUint32(per * 4, true);
  }
  const fat: number[] = [];
  for (const n of fatSectors) {
    if (n >= END_OF_CHAIN - 1) continue;
    const s = sectorAt(n);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sv.getUint32(i * 4, true));
  }
  const chain = (start: number, table: number[], limit: number) => {
    const out: number[] = [];
    for (let n = start; n < END_OF_CHAIN - 1; n = table[n] ?? END_OF_CHAIN) {
      if (out.length > limit) fail();
      out.push(n);
    }
    return out;
  };
  const readChain = (start: number) => {
    const ids = chain(start, fat, sectors);
    const out = new Uint8Array(ids.length * sectorSize);
    ids.forEach((n, i) => out.set(sectorAt(n), i * sectorSize));
    return out;
  };

  const dir = readChain(dirStart);
  const dd = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = Math.min(dd.getUint16(off + 0x40, true), 64);
    let name = "";
    for (let i = 0; i + 1 < nameLen - 1; i += 2)
      name += String.fromCharCode(dd.getUint16(off + i, true));
    entries.push({
      name,
      type: dir[off + 0x42],
      start: dd.getUint32(off + 0x74, true),
      size: dd.getUint32(off + 0x78, true),
    });
  }
  const root = entries[0];
  const entry = entries.find(
    (e) => e.type === 2 && names.some((n) => n.toLowerCase() === e.name.toLowerCase()),
  );
  if (!root || !entry) fail();
  if (entry.size >= miniCutoff) return readChain(entry.start).subarray(0, entry.size);

  // Маленький поток — в мини-секторах корня.
  const miniStream = readChain(root.start);
  const mf = readChain(miniFatStart);
  const mv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mv.getUint32(i, true));
  const ids = chain(entry.start, miniFat, miniStream.length / miniSize);
  const out = new Uint8Array(ids.length * miniSize);
  ids.forEach((n, i) => {
    const start = n * miniSize;
    if (start + miniSize > miniStream.length) fail();
    out.set(miniStream.subarray(start, start + miniSize), i * miniSize);
  });
  return out.subarray(0, entry.size);
}

// --- Записи BIFF8 -------------------------------------------------------------------

type Record_ = { type: number; data: Uint8Array; pos: number };

function* records(stream: Uint8Array, from = 0): Generator<Record_> {
  let pos = from;
  while (pos + 4 <= stream.length) {
    const type = stream[pos] | (stream[pos + 1] << 8);
    const len = stream[pos + 2] | (stream[pos + 3] << 8);
    if (pos + 4 + len > stream.length) fail();
    yield { type, data: stream.subarray(pos + 4, pos + 4 + len), pos };
    pos += 4 + len;
  }
}

/**
 * Символы BIFF8 по кодам UTF-16: однобайтные — младшие байты (не
 * windows-1252), двухбайтные — LE. Строку собираем из кодов, а не
 * TextDecoder по кускам: граница CONTINUE может разрезать суррогатную пару.
 */
function codeUnits(bytes: Uint8Array, wide: boolean): string {
  const units: number[] = [];
  if (wide)
    for (let i = 0; i + 1 < bytes.length; i += 2) units.push(bytes[i] | (bytes[i + 1] << 8));
  else for (let i = 0; i < bytes.length; i++) units.push(bytes[i]);
  let out = "";
  for (let i = 0; i < units.length; i += 8192)
    out += String.fromCharCode(...units.slice(i, i + 8192));
  return out;
}

/** Чтение по кускам записи и её CONTINUE: строки SST переходят через границы. */
class Segments {
  private si = 0;
  private pos = 0;
  constructor(private readonly segs: Uint8Array[]) {}
  private seg() {
    while (this.si < this.segs.length && this.pos >= this.segs[this.si].length) {
      this.si++;
      this.pos = 0;
    }
    if (this.si >= this.segs.length) fail();
    return this.segs[this.si];
  }
  atSegmentEnd() {
    return this.si < this.segs.length && this.pos >= this.segs[this.si].length;
  }
  nextSegment() {
    this.si++;
    this.pos = 0;
  }
  u8() {
    const s = this.seg();
    return s[this.pos++];
  }
  u16() {
    return this.u8() | (this.u8() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let left = n; left > 0; ) {
      const s = this.seg();
      const take = Math.min(left, s.length - this.pos);
      this.pos += take;
      left -= take;
    }
  }
  /** Символы строки: на границе CONTINUE — новый байт признака «двухбайтные». */
  chars(count: number, high: boolean): string {
    let out = "";
    let wide = high;
    for (let left = count; left > 0; ) {
      if (this.atSegmentEnd()) {
        this.nextSegment();
        wide = (this.u8() & 1) === 1;
      }
      const s = this.seg();
      const avail = s.length - this.pos;
      const n = Math.min(left, wide ? Math.floor(avail / 2) : avail);
      if (n <= 0) fail();
      const bytes = s.subarray(this.pos, this.pos + n * (wide ? 2 : 1));
      out += codeUnits(bytes, wide);
      this.pos += bytes.length;
      left -= n;
    }
    return out;
  }
  /** XLUnicodeRichExtendedString (SST) или XLUnicodeString (длина u16). */
  string(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4 + ext);
    return text;
  }
}

function sharedStrings(segs: Uint8Array[]): string[] {
  const r = new Segments(segs);
  r.u32();
  const unique = r.u32();
  const out: string[] = [];
  for (let i = 0; i < unique; i++) out.push(r.string());
  return out;
}

function f64(data: Uint8Array, at: number) {
  return new DataView(data.buffer, data.byteOffset + at, 8).getFloat64(0, true);
}

function rk(value: number): number {
  let v: number;
  if (value & 2) v = value >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, value & 0xfffffffc, true);
    v = buf.getFloat64(0, true);
  }
  return value & 1 ? v / 100 : v;
}

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u32 = (d: Uint8Array, at: number) =>
  (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

/** Первый рабочий лист .xls: строки × столбцы, как xlrd `cell_value`. */
export function readXls(bytes: Uint8Array): XlsValue[][] {
  const stream = cfbStream(bytes, ["Workbook", "Book"]);
  let sst: string[] = [];
  let sheetPos: number | null = null;
  let sstSegs: Uint8Array[] | null = null;
  let first = true;
  for (const rec of records(stream)) {
    if (first) {
      if (rec.type !== 0x0809 || u16(rec.data, 0) !== 0x0600) fail();
      first = false;
      continue;
    }
    if (sstSegs) {
      if (rec.type === 0x003c) {
        sstSegs.push(rec.data);
        continue;
      }
      sst = sharedStrings(sstSegs);
      sstSegs = null;
    }
    if (rec.type === 0x002f)
      throw new Error("Файл .xls защищён паролем — снимите защиту и загрузите снова.");
    if (rec.type === 0x00fc) sstSegs = [rec.data];
    else if (rec.type === 0x0085 && sheetPos === null && rec.data[5] === 0)
      sheetPos = u32(rec.data, 0);
    else if (rec.type === 0x000a) break;
  }
  if (sstSegs) sst = sharedStrings(sstSegs);
  if (sheetPos === null) throw new Error("В Excel-файле нет листов.");

  const cells = new Map<number, Map<number, XlsValue>>();
  let nrows = 0;
  let ncols = 0;
  const put = (row: number, col: number, v: XlsValue) => {
    let r = cells.get(row);
    if (!r) cells.set(row, (r = new Map()));
    r.set(col, v);
    nrows = Math.max(nrows, row + 1);
    ncols = Math.max(ncols, col + 1);
  };
  let pendingString: { row: number; col: number } | null = null;
  let started = false;
  for (const rec of records(stream, sheetPos)) {
    const d = rec.data;
    if (!started) {
      if (rec.type !== 0x0809) fail();
      started = true;
      continue;
    }
    if (rec.type === 0x000a) break;
    if (pendingString && rec.type === 0x0207) {
      put(pendingString.row, pendingString.col, new Segments([d]).string());
      pendingString = null;
      continue;
    }
    const row = u16(d, 0);
    const col = u16(d, 2);
    switch (rec.type) {
      case 0x00fd: // LABELSST
        put(row, col, sst[u32(d, 6)] ?? "");
        break;
      case 0x0204: // LABEL
      case 0x00d6: // RSTRING
        put(row, col, new Segments([d.subarray(6)]).string());
        break;
      case 0x0203: // NUMBER
        put(row, col, f64(d, 6));
        break;
      case 0x027e: // RK
        put(row, col, rk(u32(d, 6)));
        break;
      case 0x00bd: {
        // MULRK: столбцы col…last, по 6 байт (XF + RK).
        const last = u16(d, d.length - 2);
        for (let c = col, at = 4; c <= last && at + 6 <= d.length - 2; c++, at += 6) {
          put(row, c, rk(u32(d, at + 2)));
        }
        break;
      }
      case 0x0205: // BOOLERR: логическое — 1/0, ошибка — её код (как xlrd)
        put(row, col, d[6]);
        break;
      case 0x0006: {
        // FORMULA: сохранённый результат.
        if (d[12] === 0xff && d[13] === 0xff) {
          const kind = d[6];
          if (kind === 0) pendingString = { row, col };
          else if (kind === 1 || kind === 2) put(row, col, d[8]);
          else if (kind === 3) put(row, col, "");
        } else put(row, col, f64(d, 6));
        break;
      }
    }
  }
  const out: XlsValue[][] = [];
  for (let r = 0; r < nrows; r++) {
    const src = cells.get(r);
    const line: XlsValue[] = [];
    for (let c = 0; c < ncols; c++) line.push(src?.get(c) ?? "");
    out.push(line);
  }
  return out;
}
