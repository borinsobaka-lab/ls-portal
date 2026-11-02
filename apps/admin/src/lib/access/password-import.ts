/**
 * «Импорт паролей» в «Пользователях» (решения владельца 2026-11-02): логины
 * и пароли Platrum из Excel — файлом .xlsx или вставкой из буфера. Человек
 * ищется по фамилии и имени вместе (оба поля обязательны на портале):
 *   - колонки «Фамилия», «Имя», «Логин», «Пароль» (по заголовкам — в любом
 *     порядке; без заголовков — четыре колонки по порядку: фамилия, имя,
 *     логин, пароль);
 *   - или одна колонка с полным именем («ФИО», «Пользователь»; без
 *     заголовков — три колонки: имя, логин, пароль).
 * Порядок фамилии и имени не важен («Анна Иванова» = «Иванова Анна»), как и
 * регистр, «ё» и лишние пробелы; отчество в полном имени не мешает.
 * Ненайденных (`createMissing`) добавляют на портал с логином и паролем из
 * файла: фамилия и имя — из своих колонок, в полном имени — первое слово
 * фамилия, второе — имя (как на портале «Фамилия Имя»). Логика
 * без React — тест password-import.test.ts.
 */
import { normalizeName } from "./logic";

export type PasswordImportRow = {
  line: number;
  name: string;
  login: string;
  password: string;
  user_id: string | null;
  /** Имя на портале у найденного человека. */
  portal_name: string | null;
  /** Не найден на портале — будет добавлен с этими фамилией и именем. */
  create: { last_name: string; first_name: string } | null;
  /** Строка не импортируется. */
  error: string | null;
};

type Columns = { last?: number; first?: number; full?: number; login: number; password: number };

const headerKey = (v: string) =>
  normalizeName(v)
    .replace(/[^a-zа-я0-9 ]+/g, " ")
    .trim();
const HEADERS: Record<keyof Columns, RegExp> = {
  last: /^(фамилия|last ?name|surname)$/,
  first: /^(имя|first ?name)$/,
  full: /^(фио|фамилия имя( отчество)?|имя фамилия|пользователь|имя пользователя|сотрудник|full ?name|name|user)$/,
  login: /^(логин|login|логин platrum|username)$/,
  password: /^(пароль|password|пароль platrum)$/,
};

/** Колонки по строке заголовков (null — это не заголовки). */
export function detectPasswordColumns(row: string[]): Columns | null {
  const found: Partial<Columns> = {};
  row.forEach((cell, i) => {
    const key = headerKey(cell);
    for (const col of Object.keys(HEADERS) as (keyof Columns)[]) {
      if (found[col] === undefined && HEADERS[col].test(key)) {
        found[col] = i;
        return;
      }
    }
  });
  const hasName =
    (found.last !== undefined && found.first !== undefined) || found.full !== undefined;
  if (!hasName || found.login === undefined || found.password === undefined) return null;
  return found as Columns;
}

/** Ключ человека: слова фамилии и имени без порядка. */
function nameKey(words: string[]): string {
  return words
    .map((w) => normalizeName(w))
    .filter(Boolean)
    .sort()
    .join(" ");
}

const splitWords = (v: string | null | undefined) => normalizeName(v).split(" ").filter(Boolean);

export function buildPasswordRows(
  table: string[][],
  users: { user_id: string; full_name: string | null }[],
  opts: { createMissing?: boolean } = {},
): PasswordImportRow[] {
  const byName = new Map<string, { user_id: string; full_name: string }[]>();
  for (const u of users) {
    const key = nameKey(splitWords(u.full_name));
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), { user_id: u.user_id, full_name: u.full_name! }]);
  }
  const header = table.length ? detectPasswordColumns(table[0]) : null;
  const width = Math.max(0, ...table.slice(0, 5).map((r) => r.filter((c) => c !== "").length));
  const cols: Columns =
    header ??
    (width >= 4
      ? { last: 0, first: 1, login: 2, password: 3 }
      : { full: 0, login: 1, password: 2 });
  const start = header ? 1 : 0;
  const cell = (r: string[], i: number | undefined) =>
    i === undefined ? "" : (r[i] ?? "").trim().replace(/\s+/g, " ");

  const seenUsers = new Map<string, number>();
  const seenNew = new Map<string, number>();
  const seenLogins = new Map<string, number>();
  const out: PasswordImportRow[] = [];
  table.slice(start).forEach((r, i) => {
    const line = start + i + 1;
    const separate = cols.last !== undefined && cols.first !== undefined;
    const last = separate ? cell(r, cols.last) : "";
    const first = separate ? cell(r, cols.first) : "";
    const name = separate ? [last, first].filter(Boolean).join(" ") : cell(r, cols.full);
    const login = (r[cols.login] ?? "").trim();
    const password = (r[cols.password] ?? "").trim();
    if (!name && !login && !password) return;

    // Все слова; в полном имени с отчеством — ещё и первые два слова.
    const words = separate ? [...splitWords(last), ...splitWords(first)] : splitWords(name);
    const keys = [nameKey(words)];
    if (!separate && words.length > 2) keys.push(nameKey(words.slice(0, 2)));
    let found: { user_id: string; full_name: string }[] = [];
    for (const k of keys) {
      found = byName.get(k) ?? [];
      if (found.length) break;
    }
    const user = found.length === 1 ? found[0] : null;
    // Фамилия и имя нового человека — как в файле (без отчества).
    const raw = name.split(" ").filter(Boolean);
    const create =
      opts.createMissing && found.length === 0
        ? separate
          ? { last_name: last, first_name: first }
          : { last_name: raw[0] ?? "", first_name: raw[1] ?? "" }
        : null;
    const newKey = create ? nameKey([create.last_name, create.first_name]) : "";

    let error: string | null = null;
    if (separate && !last) error = "Нет фамилии";
    else if (separate && !first) error = "Нет имени";
    else if (!name) error = "Нет фамилии и имени";
    else if (!separate && words.length < 2) error = "Нужны и фамилия, и имя";
    else if (found.length === 0 && !create) error = "Нет такого пользователя на портале";
    else if (found.length > 1)
      error = `На портале ${found.length} человека с такими фамилией и именем — задайте в карточке`;
    else if (!login) error = "Нет логина";
    else if (/\s/.test(login)) error = "В логине есть пробелы";
    else if (login.length > 100) error = "Логин длиннее 100 знаков";
    else if (!password) error = "Нет пароля";
    else if (password.length < 4) error = "Пароль короче 4 знаков";
    else if (password.length > 200) error = "Пароль длиннее 200 знаков";
    else if (create && (create.last_name.length > 100 || create.first_name.length > 100))
      error = "Фамилия или имя длиннее 100 знаков";
    else if (user && seenUsers.has(user.user_id))
      error = `Этот человек уже в строке ${seenUsers.get(user.user_id)}`;
    else if (create && seenNew.has(newKey))
      error = `Этот человек уже в строке ${seenNew.get(newKey)}`;
    else if (seenLogins.has(login.toLowerCase()))
      error = `Логин уже в строке ${seenLogins.get(login.toLowerCase())}`;
    if (!error && (user || create)) {
      if (user) seenUsers.set(user.user_id, line);
      else seenNew.set(newKey, line);
      seenLogins.set(login.toLowerCase(), line);
    }
    out.push({
      line,
      name,
      login,
      password,
      user_id: user?.user_id ?? null,
      portal_name: user?.full_name ?? null,
      create: error ? null : create,
      error,
    });
  });
  return out;
}

/** Таблица из первого листа .xlsx (ячейки — текстом, как в файле). */
export async function readPasswordXlsx(file: File): Promise<string[][]> {
  // Читатель .xlsx «Аналитики» (свой код, без библиотек) — отдельным чанком.
  const { openWorkbook } = await import("@/lib/analytics/onec/xlsx-read");
  const browserInflate = async function* (data: Uint8Array) {
    const reader = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  };
  let book;
  try {
    book = await openWorkbook(new Uint8Array(await file.arrayBuffer()), browserInflate);
  } catch {
    throw new Error("Не удалось прочитать файл — нужен Excel .xlsx");
  }
  if (book.sheets.length === 0) throw new Error("В файле нет листов");
  const sheet = await book.open(0, { raw: true });
  const rows: string[][] = [];
  for await (const row of sheet.rows()) {
    rows.push(row.cells.slice(0, 10).map((v) => (v === null ? "" : String(v).trim())));
  }
  return rows;
}
