/**
 * Мигратор схемы БД. Запускается при старте контейнера админки
 * (apps/admin/Dockerfile), до сервера: выполняет новые файлы
 * db/migrations/*.sql по порядку имён и записывает их в
 * app_migrations.applied — каждый файл выполняется один раз.
 *
 * - DATABASE_URL (runtime-секрет портала в Coolify) — прямое подключение
 *   к Postgres self-hosted Supabase. Не задан — миграции пропускаются, сервер
 *   стартует как раньше (ручной режим через SQL Editor).
 * - Пустая база (первый старт копии) — сначала старые db/*.sql и поправки
 *   (db/bootstrap.ts, как db/test/build-schema.sh), потом миграции.
 * - Каждый файл — в своей транзакции вместе с отметкой о выполнении: упал —
 *   откат целиком, контейнер не стартует (exit 1), новый код не выходит
 *   раньше схемы. Внутри файла begin/commit и create index concurrently не
 *   писать.
 * - Advisory lock: два контейнера (перекрытие при деплое) не выполнят
 *   миграцию дважды.
 * - Изменённый после выполнения файл повторно не выполняется — только
 *   предупреждение в лог. Исправление = новый файл.
 *
 * Вручную (из корня репозитория): DATABASE_URL=postgres://… bun db/migrate.ts
 */
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bootstrapLegacy } from "./bootstrap";

/** Имя файла миграции: дата и короткое имя — 2026-10-09_studio_formats.sql. */
export const MIGRATION_NAME_RE = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;

// Произвольная константа для pg_advisory_lock — «замок» мигратора.
const LOCK_KEY = 4040_2026;

export type Migration = { name: string; sql: string; checksum: string };

export function readMigrations(dir: string): Migration[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const bad = files.filter((f) => !MIGRATION_NAME_RE.test(f));
  if (bad.length) {
    throw new Error(`Имя миграции не по шаблону ГГГГ-ММ-ДД_имя.sql: ${bad.join(", ")}`);
  }
  return files.map((name) => {
    const sql = readFileSync(join(dir, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

export async function runMigrations(
  db: SQL,
  migrations: Migration[],
  log: (line: string) => void = console.log,
  /** Папка старых db/*.sql: задана — пустая база сначала собирается из них. */
  legacyDir?: string,
): Promise<string[]> {
  const conn = await db.reserve();
  try {
    // Сначала блокировка, потом служебная таблица: два контейнера, стартующие
    // одновременно на новой базе, иначе падали бы на дубликате при create.
    await conn.unsafe(`select pg_advisory_lock(${LOCK_KEY})`);
    try {
      await conn.unsafe(`
        create schema if not exists app_migrations;
        revoke all on schema app_migrations from public;
        create table if not exists app_migrations.applied (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        );
      `);
      if (legacyDir) await bootstrapLegacy(conn, legacyDir, log);
      const rows = (await conn.unsafe(`select name, checksum from app_migrations.applied`)) as {
        name: string;
        checksum: string;
      }[];
      const applied = new Map(rows.map((r) => [r.name, r.checksum]));
      const done: string[] = [];

      for (const m of migrations) {
        const prev = applied.get(m.name);
        if (prev !== undefined) {
          if (prev !== m.checksum) {
            log(`[migrate] ВНИМАНИЕ: ${m.name} изменён после выполнения — повторно не выполняется`);
          }
          continue;
        }
        log(`[migrate] ${m.name}…`);
        await conn.unsafe("begin");
        try {
          // Ждать блокировку таблицы под живой нагрузкой не дольше 5 секунд:
          // пока миграция ждёт, за ней в очереди стоят все запросы приложения
          // к этой таблице (клиенты видят зависание). Не дождалась — миграция
          // откатывается, новый контейнер не стартует, работает прежний;
          // повторить деплой в тихое время (было 60 с — до 2026-10-16).
          await conn.unsafe("set local lock_timeout = '5s'");
          await conn.unsafe(m.sql);
          await conn`insert into app_migrations.applied (name, checksum) values (${m.name}, ${m.checksum})`;
          await conn.unsafe("commit");
        } catch (e) {
          await conn.unsafe("rollback").catch(() => {});
          const err = e as Error & { code?: string; errno?: string; position?: string };
          throw new Error(
            `${m.name}: ${err.message}` +
              (err.errno || err.code ? ` [${err.errno ?? err.code}]` : "") +
              (err.position ? ` (символ ${err.position})` : ""),
          );
        }
        done.push(m.name);
      }
      log(
        done.length
          ? `[migrate] выполнено: ${done.length}`
          : `[migrate] новых миграций нет (всего ${migrations.length})`,
      );
      return done;
    } finally {
      await conn.unsafe(`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[migrate] DATABASE_URL не задан — миграции пропущены");
    process.exit(0);
  }
  const db = new SQL(url, { max: 1 });
  try {
    await runMigrations(
      db,
      readMigrations(join(import.meta.dir, "migrations")),
      console.log,
      import.meta.dir,
    );
  } catch (e) {
    console.error(`[migrate] ОШИБКА, сервер не запущен: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    await db.close();
  }
}
