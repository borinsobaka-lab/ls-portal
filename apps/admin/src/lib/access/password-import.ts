/**
 * «Импорт паролей» в «Пользователях» (решение владельца 2026-11-02): логины и
 * пароли Platrum из Excel — файлом .xlsx или вставкой из буфера. Колонки по
 * порядку: точное имя пользователя, как на портале; логин; пароль. Строка
 * заголовков в начале пропускается сама. Человек ищется по имени без учёта
 * регистра, «ё» и лишних пробелов. Логика без React — тест
 * password-import.test.ts.
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
  /** Строка не импортируется. */
  error: string | null;
};

const HEADER_NAME = /имя|фио|пользоват|сотрудник|name|user/i;
const HEADER_PASS = /парол|password/i;

/** Похожа ли первая строка на заголовки («Пользователь; Логин; Пароль»). */
export function isHeaderRow(row: string[]): boolean {
  return HEADER_NAME.test(row[0] ?? "") && HEADER_PASS.test(row[2] ?? "");
}

export function buildPasswordRows(
  table: string[][],
  users: { user_id: string; full_name: string | null }[],
): PasswordImportRow[] {
  const byName = new Map<string, { user_id: string; full_name: string }[]>();
  for (const u of users) {
    const key = normalizeName(u.full_name);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), { user_id: u.user_id, full_name: u.full_name! }]);
  }
  const start = table.length && isHeaderRow(table[0]) ? 1 : 0;
  const seenUsers = new Map<string, number>();
  const seenLogins = new Map<string, number>();
  const out: PasswordImportRow[] = [];
  table.slice(start).forEach((r, i) => {
    const line = start + i + 1;
    const name = (r[0] ?? "").trim().replace(/\s+/g, " ");
    const login = (r[1] ?? "").trim();
    const password = (r[2] ?? "").trim();
    if (!name && !login && !password) return;
    const found = byName.get(normalizeName(name)) ?? [];
    const user = found.length === 1 ? found[0] : null;
    let error: string | null = null;
    if (!name) error = "Нет имени";
    else if (found.length === 0) error = "Нет такого пользователя на портале";
    else if (found.length > 1)
      error = `На портале ${found.length} человека с таким именем — задайте в карточке`;
    else if (!login) error = "Нет логина";
    else if (/\s/.test(login)) error = "В логине есть пробелы";
    else if (login.length > 100) error = "Логин длиннее 100 знаков";
    else if (!password) error = "Нет пароля";
    else if (password.length < 4) error = "Пароль короче 4 знаков";
    else if (password.length > 200) error = "Пароль длиннее 200 знаков";
    else if (seenUsers.has(user!.user_id))
      error = `Этот человек уже в строке ${seenUsers.get(user!.user_id)}`;
    else if (seenLogins.has(login.toLowerCase()))
      error = `Логин уже в строке ${seenLogins.get(login.toLowerCase())}`;
    if (!error && user) {
      seenUsers.set(user.user_id, line);
      seenLogins.set(login.toLowerCase(), line);
    }
    out.push({
      line,
      name,
      login,
      password,
      user_id: user?.user_id ?? null,
      portal_name: user?.full_name ?? null,
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
    rows.push(row.cells.slice(0, 3).map((v) => (v === null ? "" : String(v).trim())));
  }
  return rows;
}
