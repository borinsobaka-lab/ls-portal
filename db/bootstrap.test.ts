import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readLegacyFiles, splitSql } from "./bootstrap";

describe("splitSql — команды как у psql", () => {
  test("точка с запятой в строках, идентификаторах, комментариях и $$ — не граница", () => {
    const sql = `
      -- комментарий; с точкой с запятой
      create table "a;b" (x text default 'it''s; fine');
      /* блок; /* вложенный; */ ещё; */
      create function f() returns int language plpgsql as $$ begin return 1; end $$;
      do $body$ begin perform 1; end $body$;
      select E'\\'; still string';
      select $1;
    `;
    expect(splitSql(sql)).toEqual([
      `-- комментарий; с точкой с запятой
      create table "a;b" (x text default 'it''s; fine')`,
      `/* блок; /* вложенный; */ ещё; */
      create function f() returns int language plpgsql as $$ begin return 1; end $$`,
      "do $body$ begin perform 1; end $body$",
      "select E'\\'; still string'",
      "select $1",
    ]);
  });

  test("пустые куски и одни комментарии отбрасываются", () => {
    expect(splitSql(";;  -- только комментарий\n;")).toEqual([]);
  });

  test("старые db/*.sql разбираются, команд без кода нет", () => {
    const files = readLegacyFiles(import.meta.dir);
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(f.statements.length).toBeGreaterThan(0);
      for (const st of f.statements) expect(st.endsWith(";")).toBe(false);
    }
    expect(files.map((f) => f.name)).toContain("schema.sql");
    expect(join(import.meta.dir, "bootstrap", "fixups.sql")).toBeTruthy();
  });
});
