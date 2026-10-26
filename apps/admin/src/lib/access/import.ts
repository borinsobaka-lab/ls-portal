/**
 * Импорт пользователей из таблицы (замечание тестирования 2026-10-27:
 * партнёров заводили по одному). Файл CSV или текст, скопированный из Excel /
 * Google Таблиц / выгрузки Битрикс24: первая строка — заголовки, колонки
 * узнаются по названию (синонимы ниже), лишние пропускаются. Логика без
 * React — тест import.test.ts.
 */
import { USER_TYPE_LABEL, USER_TYPES, findDuplicates, normalizeName } from "./logic";
import type { UserType } from "./types";

export type ImportColumn =
  | "last_name"
  | "first_name"
  | "full_name"
  | "email"
  | "phone"
  | "user_type"
  | "position"
  | "unit"
  | "role"
  | "clubs";

/** Синонимы заголовков (без регистра, ё = е, без знаков). */
const HEADERS: Record<ImportColumn, string[]> = {
  last_name: ["фамилия", "last name", "lastname", "surname"],
  first_name: ["имя", "first name", "firstname", "name"],
  full_name: [
    "фио",
    "фамилия имя",
    "сотрудник",
    "пользователь",
    "full name",
    "фамилия имя отчество",
  ],
  email: [
    "email",
    "e-mail",
    "почта",
    "эл почта",
    "электронная почта",
    "e mail",
    "рабочий e-mail",
    "рабочая почта",
    "логин",
  ],
  phone: ["телефон", "phone", "мобильный", "мобильный телефон", "рабочий телефон"],
  user_type: ["тип", "тип пользователя", "type"],
  position: ["должность", "position", "job title"],
  unit: ["подразделение", "отдел", "department", "unit"],
  role: ["роль", "роли", "role"],
  clubs: ["клубы", "клуб", "клубы собственника", "собственник клубов", "студия", "студии"],
};

export const IMPORT_COLUMN_LABEL: Record<ImportColumn, string> = {
  last_name: "Фамилия",
  first_name: "Имя",
  full_name: "ФИО",
  email: "Email",
  phone: "Телефон",
  user_type: "Тип",
  position: "Должность",
  unit: "Подразделение",
  role: "Роль",
  clubs: "Клубы собственника",
};

const headerKey = (v: string) =>
  v
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9-]+/g, " ")
    .trim();

/** Разбор CSV/TSV: разделитель — табуляция, «;» или «,» (что чаще в первой строке). */
export function parseTable(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const first = clean.split("\n", 1)[0] ?? "";
  const [best] = ["\t", ";", ","]
    .map((d) => ({ d, n: first.split(d).length - 1 }))
    .sort((a, b) => b.n - a.n);
  const delim = best.n > 0 ? best.d : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/** Какая колонка таблицы — какое поле (по заголовку). */
export function detectColumns(header: string[]): Partial<Record<ImportColumn, number>> {
  const out: Partial<Record<ImportColumn, number>> = {};
  header.forEach((h, i) => {
    const key = headerKey(h);
    for (const col of Object.keys(HEADERS) as ImportColumn[]) {
      if (out[col] === undefined && HEADERS[col].includes(key)) {
        out[col] = i;
        return;
      }
    }
  });
  return out;
}

export function parseUserType(v: string): UserType | null | "bad" {
  const key = normalizeName(v);
  if (!key) return null;
  for (const t of USER_TYPES) {
    const label = normalizeName(USER_TYPE_LABEL[t]);
    if (key === t || label === key || label.startsWith(key)) return t;
  }
  if (/франчайз|партн/.test(key)) return "partner";
  if (/^ук$|управля/.test(key)) return "hq";
  if (/клуб|студи/.test(key)) return "studio";
  return "bad";
}

/** Список через запятую или «;» (клубы, роли в одной ячейке). */
const listCell = (v: string) =>
  v
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export type Named = { id: string; name: string };

export type ImportRow = {
  line: number;
  last_name: string;
  first_name: string;
  email: string;
  phone: string;
  user_type: UserType | null;
  position_id: string | null;
  unit_id: string | null;
  role_ids: string[];
  club_ids: string[];
  /** Не мешают импорту: поле пропущено. */
  warnings: string[];
  /** Строка не импортируется. */
  error: string | null;
  /** Похожий человек уже в портале или выше в файле. */
  duplicate: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function byName(list: Named[]) {
  const map = new Map<string, Named>();
  for (const x of list) map.set(normalizeName(x.name), x);
  return map;
}

/**
 * Строки таблицы → люди с найденными должностью, подразделением, ролями и
 * клубами. Неизвестная должность или клуб — предупреждение (поле
 * пропускается), без фамилии и имени или с неверной почтой — ошибка.
 */
export function buildImportRows(
  table: string[][],
  dict: {
    positions: Named[];
    units: Named[];
    roles: (Named & { network: boolean })[];
    clubs: (Named & { city?: string | null })[];
    users: {
      user_id: string;
      full_name: string | null;
      email: string | null;
      phone: string | null;
    }[];
  },
): { columns: Partial<Record<ImportColumn, number>>; rows: ImportRow[] } {
  const [header = [], ...body] = table;
  const columns = detectColumns(header);
  const positions = byName(dict.positions);
  const units = byName(dict.units);
  const roles = new Map(dict.roles.map((r) => [normalizeName(r.name), r]));
  const clubs = byName(dict.clubs);
  const seen: {
    user_id: string;
    full_name: string | null;
    email: string | null;
    phone: string | null;
  }[] = [];
  const get = (r: string[], c: ImportColumn) => {
    const i = columns[c];
    return i === undefined ? "" : (r[i] ?? "").trim();
  };
  const rows = body.map((r, idx): ImportRow => {
    const warnings: string[] = [];
    let last = get(r, "last_name");
    let first = get(r, "first_name");
    if ((!last || !first) && get(r, "full_name")) {
      // «Фамилия Имя Отчество» — отчество в имя не пишем.
      const [l = "", f = ""] = get(r, "full_name").split(/\s+/);
      last ||= l;
      first ||= f;
    }
    const email = get(r, "email").toLowerCase();
    const phone = get(r, "phone");
    let error: string | null = null;
    if (!last || !first) error = "Нет фамилии или имени";
    else if (email && !EMAIL_RE.test(email)) error = `Неверная почта «${email}»`;

    const typeCell = get(r, "user_type");
    const type = parseUserType(typeCell);
    if (type === "bad") warnings.push(`Тип «${typeCell}» не узнан`);

    const posCell = get(r, "position");
    const pos = posCell ? positions.get(normalizeName(posCell)) : undefined;
    if (posCell && !pos) warnings.push(`Нет должности «${posCell}»`);

    const unitCell = get(r, "unit");
    // «Отдел развития › Кураторы» — по последнему звену.
    const unitName =
      unitCell
        .split(/›|>|\//)
        .pop()
        ?.trim() ?? "";
    const unit = unitName ? units.get(normalizeName(unitName)) : undefined;
    if (unitCell && !unit) warnings.push(`Нет подразделения «${unitCell}»`);

    const roleIds: string[] = [];
    for (const name of listCell(get(r, "role"))) {
      const role = roles.get(normalizeName(name));
      if (!role) warnings.push(`Нет роли «${name}»`);
      else if (!role.network)
        warnings.push(`Роль «${name}» с правами в клубе — выдайте её в карточке`);
      else roleIds.push(role.id);
    }

    const clubIds: string[] = [];
    for (const name of listCell(get(r, "clubs"))) {
      const club = clubs.get(normalizeName(name));
      if (!club) warnings.push(`Нет клуба «${name}»`);
      else clubIds.push(club.id);
    }

    const draft = { full_name: `${last} ${first}`, email, phone };
    const inPortal = findDuplicates(dict.users, draft)[0];
    const inFile = findDuplicates(seen, draft)[0];
    const duplicate = inPortal
      ? `Уже в портале: ${inPortal.user.full_name ?? inPortal.user.email ?? ""}`
      : inFile
        ? `Повтор строки ${inFile.user.user_id}`
        : null;
    if (!error) seen.push({ user_id: String(idx + 2), full_name: draft.full_name, email, phone });

    return {
      line: idx + 2,
      last_name: last,
      first_name: first,
      email,
      phone,
      user_type: type === "bad" ? null : type,
      position_id: pos?.id ?? null,
      unit_id: unit?.id ?? null,
      role_ids: [...new Set(roleIds)],
      club_ids: [...new Set(clubIds)],
      warnings,
      error,
      duplicate,
    };
  });
  return { columns, rows };
}
