/**
 * Тесты мигратора на настоящем Postgres. Нужна пустая база, которую не жалко:
 * TEST_DATABASE_URL=postgres://postgres@localhost:54329/migtest bun test db
 * Без переменной тесты пропускаются (обычный `bun test` базы не требует).
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrations, runMigrations } from "./migrate";

const url = process.env.TEST_DATABASE_URL;

function dirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe.skipIf(!url)("мигратор", () => {
  let db: SQL;
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  beforeAll(async () => {
    db = new SQL(url!);
    await db.unsafe(
      "drop schema if exists app_migrations cascade; drop table if exists public.mig_t;",
    );
  });
  afterAll(async () => {
    await db.unsafe(
      "drop schema if exists app_migrations cascade; drop table if exists public.mig_t;",
    );
    await db.close();
  });

  test("имя не по шаблону — ошибка до выполнения", () => {
    expect(() => readMigrations(dirWith({ "studio.sql": "select 1;" }))).toThrow("ГГГГ-ММ-ДД");
  });

  test("выполняет по порядку имён и один раз", async () => {
    const dir = dirWith({
      "2026-01-02_b.sql": "insert into public.mig_t values (2);",
      "2026-01-01_a.sql":
        "create table public.mig_t (v int);\ndo $$ begin raise notice 'x'; end $$;\ninsert into public.mig_t values (1);",
    });
    expect(await runMigrations(db, readMigrations(dir), log)).toEqual([
      "2026-01-01_a.sql",
      "2026-01-02_b.sql",
    ]);
    expect(await runMigrations(db, readMigrations(dir), log)).toEqual([]);
    const rows = await db`select v from public.mig_t order by v`;
    expect(rows.map((r: { v: number }) => r.v)).toEqual([1, 2]);
  });

  test("ошибка — откат файла целиком, отметки нет, следующие не выполняются", async () => {
    const dir = dirWith({
      "2026-01-03_bad.sql": "insert into public.mig_t values (3);\nselect nope;",
      "2026-01-04_after.sql": "insert into public.mig_t values (4);",
    });
    await expect(runMigrations(db, readMigrations(dir), log)).rejects.toThrow(
      /2026-01-03_bad\.sql: .*nope/,
    );
    const rows = await db`select v from public.mig_t order by v`;
    expect(rows.map((r: { v: number }) => r.v)).toEqual([1, 2]);
    const applied = await db`select name from app_migrations.applied order by name`;
    expect(applied.map((r: { name: string }) => r.name)).toEqual([
      "2026-01-01_a.sql",
      "2026-01-02_b.sql",
    ]);
  });

  test("изменённый выполненный файл — предупреждение без повтора", async () => {
    const dir = dirWith({ "2026-01-01_a.sql": "drop table public.mig_t;" });
    expect(await runMigrations(db, readMigrations(dir), log)).toEqual([]);
    expect(logs.some((l) => l.includes("2026-01-01_a.sql изменён"))).toBe(true);
  });

  test("два запуска одновременно — файл выполняется один раз", async () => {
    const dir = dirWith({
      "2026-01-05_slow.sql": "select pg_sleep(0.3); insert into public.mig_t values (5);",
    });
    const other = new SQL(url!);
    const [a, b] = await Promise.all([
      runMigrations(db, readMigrations(dir), log),
      runMigrations(other, readMigrations(dir), log),
    ]);
    await other.close();
    expect([...a, ...b]).toEqual(["2026-01-05_slow.sql"]);
    const rows = await db`select count(*)::int as n from public.mig_t where v = 5`;
    expect(rows[0].n).toBe(1);
  });
});
