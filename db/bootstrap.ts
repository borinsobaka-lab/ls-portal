/**
 * Первый старт на пустой базе (копия портала, 2026-10-26): схема собирается
 * одной командой, как db/test/build-schema.sh, — старые db/*.sql (их раньше
 * выполняли вручную в SQL Editor, порядок не записан) → поправки
 * db/bootstrap/fixups.sql → все db/migrations/*.sql (обычный мигратор).
 *
 * Старые файлы — как `psql -v ON_ERROR_STOP=0`, три прохода по алфавиту:
 * каждая команда отдельно, упавшая пропускается (на следующем проходе её
 * зависимость уже есть). Поправки — одной транзакцией, с ошибкой — стоп.
 * Сборка отмечается строкой `legacy:bootstrap` в app_migrations.applied и
 * больше не повторяется. База не пустая (есть public.studios) — ничего не
 * делается: старые файлы там уже выполнены вручную.
 */
import type { SQL } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BOOTSTRAP_MARK = "legacy:bootstrap";

/**
 * Делит SQL-файл на команды по «;» вне строк, идентификаторов, комментариев
 * и $тег$-блоков — как psql. Пустые команды (только комментарии) отбрасываются.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'" || c === '"') {
      // E'...' — с экранированием обратной косой чертой.
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[\w$]/.test(sql[i - 1] ?? "")) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
      } else i++;
    } else if (c === ";") {
      out.push(sql.slice(start, i));
      i++;
      start = i;
    } else i++;
  }
  out.push(sql.slice(start));
  return out.map((s) => s.trim()).filter((s) => hasCode(s));
}

/** Есть ли в куске что-то, кроме пробелов и комментариев. */
function hasCode(s: string): boolean {
  const stripped = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  return stripped.trim().length > 0;
}

/** Старые файлы db/*.sql по алфавиту. */
export function readLegacyFiles(dbDir: string): { name: string; statements: string[] }[] {
  return readdirSync(dbDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, statements: splitSql(readFileSync(join(dbDir, name), "utf8")) }));
}

type Conn = Pick<SQL, "unsafe">;

/**
 * Собирает старую схему на пустой базе. Возвращает true, если собирала.
 * Вызывать под замком мигратора, после создания app_migrations.applied.
 */
export async function bootstrapLegacy(
  conn: Conn,
  dbDir: string,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  const [state] = (await conn.unsafe(`
    select to_regclass('public.studios') is not null as has_schema,
           to_regclass('auth.users') is not null as has_auth,
           to_regclass('storage.objects') is not null as has_storage,
           exists (select 1 from app_migrations.applied) as has_applied
  `)) as { has_schema: boolean; has_auth: boolean; has_storage: boolean; has_applied: boolean }[];
  if (state.has_schema || state.has_applied) return false;
  if (!state.has_auth || !state.has_storage) {
    throw new Error(
      "в базе нет схем auth/storage Supabase — сначала должны стартовать auth и storage",
    );
  }

  const files = readLegacyFiles(dbDir);
  log(`[migrate] пустая база — собираю старую схему (${files.length} файлов db/*.sql)`);
  for (let pass = 1; pass <= 3; pass++) {
    let ok = 0;
    let failed = 0;
    for (const f of files) {
      for (const st of f.statements) {
        try {
          await conn.unsafe(st);
          ok++;
        } catch {
          failed++;
          // Упавшая команда внутри begin … commit файла оставила бы
          // транзакцию прерванной — сбрасываем, как psql на commit.
          await conn.unsafe("rollback").catch(() => {});
        }
      }
    }
    log(`[migrate] проход ${pass}: выполнено ${ok}, пропущено ${failed}`);
  }

  const fixups = join(dbDir, "bootstrap", "fixups.sql");
  await conn.unsafe("begin");
  try {
    if (existsSync(fixups)) await conn.unsafe(readFileSync(fixups, "utf8"));
    await conn.unsafe(
      `insert into app_migrations.applied (name, checksum) values ('${BOOTSTRAP_MARK}', '-')`,
    );
    await conn.unsafe("commit");
  } catch (e) {
    await conn.unsafe("rollback").catch(() => {});
    throw new Error(`db/bootstrap/fixups.sql: ${(e as Error).message}`);
  }
  log("[migrate] старая схема собрана");
  return true;
}
