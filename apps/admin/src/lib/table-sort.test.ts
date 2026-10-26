import { describe, expect, test } from "bun:test";

import { nextSort, orderBy, sortKeyString, sortRows, type TableSort } from "./table-sort";

describe("nextSort", () => {
  test("по возрастанию → по убыванию → выключено", () => {
    const a = nextSort(null, "name");
    expect(a).toEqual({ key: "name", dir: "asc" });
    const b = nextSort(a, "name");
    expect(b).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(b, "name")).toBeNull();
  });

  test("другая колонка начинает с возрастания", () => {
    expect(nextSort({ key: "name", dir: "desc" }, "date")).toEqual({ key: "date", dir: "asc" });
  });

  test("строка для queryKey", () => {
    expect(sortKeyString(null)).toBe("");
    expect(sortKeyString({ key: "date", dir: "desc" })).toBe("date:desc");
  });
});

describe("sortRows", () => {
  type Row = { id: number; name: string | null; n: number | null; d: string | null };
  const rows: Row[] = [
    { id: 1, name: "Борис", n: 10, d: "2026-03-01" },
    { id: 2, name: null, n: 2, d: null },
    { id: 3, name: "анна", n: null, d: "2026-01-15" },
    { id: 4, name: "Яна", n: 2, d: "2026-02-10" },
  ];
  const getters = { name: (r: Row) => r.name, n: (r: Row) => r.n, d: (r: Row) => r.d };
  const ids = (sort: TableSort) => sortRows(rows, sort, getters).map((r) => r.id);

  test("без сортировки — как пришли", () => {
    expect(ids(null)).toEqual([1, 2, 3, 4]);
    expect(ids({ key: "unknown", dir: "asc" })).toEqual([1, 2, 3, 4]);
  });

  test("строки — по алфавиту без регистра, пустые в конце в обе стороны", () => {
    expect(ids({ key: "name", dir: "asc" })).toEqual([3, 1, 4, 2]);
    expect(ids({ key: "name", dir: "desc" })).toEqual([4, 1, 3, 2]);
  });

  test("числа — по значению, равные сохраняют порядок", () => {
    expect(ids({ key: "n", dir: "asc" })).toEqual([2, 4, 1, 3]);
    expect(ids({ key: "n", dir: "desc" })).toEqual([1, 2, 4, 3]);
  });

  test("даты ISO — по времени", () => {
    expect(ids({ key: "d", dir: "asc" })).toEqual([3, 4, 1, 2]);
    expect(ids({ key: "d", dir: "desc" })).toEqual([1, 4, 3, 2]);
  });

  test("числа в строках — естественный порядок", () => {
    const r = [{ v: "Зал 10" }, { v: "Зал 2" }];
    expect(sortRows(r, { key: "v", dir: "asc" }, { v: (x) => x.v }).map((x) => x.v)).toEqual([
      "Зал 2",
      "Зал 10",
    ]);
  });

  test("не меняет исходный массив", () => {
    sortRows(rows, { key: "n", dir: "asc" }, getters);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("orderBy", () => {
  class Q {
    calls: string[] = [];
    order(column: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
      this.calls.push(
        `${column}:${o?.ascending ? "asc" : "desc"}${o?.nullsFirst === false ? ":nl" : ""}`,
      );
      return this;
    }
  }
  const cols = { reg: "registration_date", name: ["last_name", "first_name"] };
  const fallback = (q: Q) => q.order("created_at", { ascending: false });

  test("без сортировки — порядок по умолчанию", () => {
    expect(orderBy(new Q(), null, cols, fallback).calls).toEqual(["created_at:desc"]);
    expect(orderBy(new Q(), { key: "x", dir: "asc" }, cols, fallback).calls).toEqual([
      "created_at:desc",
    ]);
  });

  test("колонка, пустые в конце, и id для устойчивых страниц", () => {
    expect(orderBy(new Q(), { key: "reg", dir: "desc" }, cols, fallback).calls).toEqual([
      "registration_date:desc:nl",
      "id:desc",
    ]);
    expect(orderBy(new Q(), { key: "name", dir: "asc" }, cols, fallback, "").calls).toEqual([
      "last_name:asc:nl",
      "first_name:asc:nl",
    ]);
  });
});
