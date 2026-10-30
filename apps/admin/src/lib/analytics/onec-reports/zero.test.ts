import { describe, expect, test } from "bun:test";

import {
  ZERO_ALL,
  zeroExcludedText,
  zeroFilterState,
  zeroFormat,
  zeroKeepOption,
  zeroMetrics,
  zeroOptionValues,
  zeroRows,
  zeroSortTree,
  zeroStudioKey,
  zeroTree,
  zeroVisibleCities,
  type ZeroRecord,
} from "./zero";

const rec = (
  city: string,
  studio: string,
  product: string,
  sales: number,
  code = product,
  period = "2026-10",
): ZeroRecord => ({ period, city, studio, code, product, sales });

const RECORDS: ZeroRecord[] = [
  rec("Москва", "Арбат", "Пробное бесплатно", 5, "001"),
  rec("Москва", "Арбат", "Подарочный", 3, "002"),
  rec("Москва", "Тверская", "Пробное бесплатно", 8, "001"),
  rec("Бердск", "Центр", "Подарочный", 13, "002"),
  rec("Анапа", "Морская", "Компенсация", 4, "003"),
  rec("Анапа", "Морская", "Компенсация", 2, "004"),
];

const ALL = { period: "2026-10", city: ZERO_ALL, studio: ZERO_ALL };

describe("фильтры", () => {
  test("списки — без повторов, по алфавиту", () => {
    expect(zeroOptionValues(["Москва", "Анапа", "Москва", "Бердск"])).toEqual([
      "Анапа",
      "Бердск",
      "Москва",
    ]);
  });

  test("прежнее значение остаётся, если оно есть в списке, иначе — «Все»", () => {
    expect(zeroKeepOption("Москва", ["Анапа", "Москва"])).toBe("Москва");
    expect(zeroKeepOption("Казань", ["Анапа", "Москва"])).toBe(ZERO_ALL);
    expect(zeroKeepOption(ZERO_ALL, [])).toBe(ZERO_ALL);
  });

  test("студии — только выбранного города; чужая студия сбрасывается", () => {
    const s = zeroFilterState(RECORDS, { ...ALL, city: "Москва", studio: "Центр" });
    expect(s.cities).toEqual(["Анапа", "Бердск", "Москва"]);
    expect(s.city).toBe("Москва");
    expect(s.studios).toEqual(["Арбат", "Тверская"]);
    expect(s.studio).toBe(ZERO_ALL);
  });

  test("город не из периода сбрасывается, студии — всех городов", () => {
    const s = zeroFilterState(RECORDS, { ...ALL, city: "Казань", studio: "Центр" });
    expect(s.city).toBe(ZERO_ALL);
    expect(s.studios).toEqual(["Арбат", "Морская", "Тверская", "Центр"]);
    expect(s.studio).toBe("Центр");
  });

  test("период: строки другого месяца в списки не попадают", () => {
    const rows = [...RECORDS, rec("Казань", "Кремль", "Подарочный", 1, "002", "2026-09")];
    expect(zeroFilterState(rows, ALL).cities).not.toContain("Казань");
    expect(zeroFilterState(rows, { ...ALL, period: ZERO_ALL }).cities).toContain("Казань");
  });

  test("«Поиск города» — без регистра и пробелов по краям", () => {
    const cities = ["Анапа", "Бердск", "Москва"];
    expect(zeroVisibleCities(cities, "")).toEqual(cities);
    expect(zeroVisibleCities(cities, "  ")).toEqual(cities);
    expect(zeroVisibleCities(cities, " МОС ")).toEqual(["Москва"]);
    expect(zeroVisibleCities(cities, "а")).toEqual(["Анапа", "Москва"]);
    expect(zeroVisibleCities(cities, "казань")).toEqual([]);
  });

  test("отбор строк по периоду, городу и студии", () => {
    expect(zeroRows(RECORDS, ALL)).toHaveLength(6);
    expect(zeroRows(RECORDS, { ...ALL, city: "Москва" })).toHaveLength(3);
    expect(zeroRows(RECORDS, { ...ALL, city: "Москва", studio: "Арбат" })).toHaveLength(2);
    expect(zeroRows(RECORDS, { ...ALL, studio: "Морская" })).toHaveLength(2);
    expect(zeroRows(RECORDS, { ...ALL, period: "2026-09" })).toHaveLength(0);
  });
});

describe("плитки", () => {
  test("продажи — сумма, номенклатуры — разные «код + название»", () => {
    expect(zeroMetrics(RECORDS)).toEqual([
      { label: "Нулевых продаж", value: 35 },
      // 001 Пробное, 002 Подарочный, 003 и 004 Компенсация — разные коды.
      { label: "Номенклатур", value: 4 },
      { label: "Студий", value: 4 },
      { label: "Городов", value: 3 },
    ]);
  });

  test("без строк — нули", () => {
    expect(zeroMetrics([]).map((m) => m.value)).toEqual([0, 0, 0, 0]);
  });

  test("числа — как их Intl.NumberFormat('ru-RU')", () => {
    expect(zeroFormat(2244)).toBe("2 244");
    expect(zeroFormat(68)).toBe("68");
    expect(zeroExcludedText({ excludedTrialRows: 58763 })).toBe(
      "Исключено пробных занятий: 58 763.",
    );
    expect(zeroExcludedText({ excludedTrialRows: 0 })).toBe("Исключено пробных занятий: 0.");
  });
});

describe("дерево город → студия → номенклатура", () => {
  const tree = zeroTree(RECORDS);

  test("суммы по городам и студиям, порядок — по убыванию, при равенстве — по названию", () => {
    // Москва 16, Бердск 13, Анапа 6.
    expect(tree.map((c) => [c.name, c.sales])).toEqual([
      ["Москва", 16],
      ["Бердск", 13],
      ["Анапа", 6],
    ]);
    expect(tree[0].studios.map((s) => [s.name, s.sales])).toEqual([
      ["Арбат", 8],
      ["Тверская", 8],
    ]);
    expect(tree[0].studios[0].products.map((p) => p.product)).toEqual([
      "Пробное бесплатно",
      "Подарочный",
    ]);
  });

  test("номенклатура — строка данных: одно название с разными кодами — две строки", () => {
    const products = tree[2].studios[0].products;
    expect(products.map((p) => [p.code, p.sales])).toEqual([
      ["003", 4],
      ["004", 2],
    ]);
  });

  test("ключ раскрытой студии — город и студия через \\0, как у них", () => {
    expect(tree[0].studios[1].key).toBe("Москва\0Тверская");
    expect(zeroStudioKey("Москва", "Тверская")).toBe("Москва\0Тверская");
  });

  test("равные продажи у городов — по алфавиту", () => {
    const t = zeroTree([rec("Москва", "А", "x", 2), rec("Анапа", "Б", "x", 2)]);
    expect(t.map((c) => c.name)).toEqual(["Анапа", "Москва"]);
  });

  test("без строк — пусто", () => {
    expect(zeroTree([])).toEqual([]);
  });
});

describe("сортировка по заголовку", () => {
  const tree = zeroTree(RECORDS);

  test("без сортировки — их порядок", () => {
    expect(zeroSortTree(tree, null)).toEqual(tree);
  });

  test("по названию — на каждом уровне", () => {
    const asc = zeroSortTree(tree, { key: "name", dir: "asc" });
    expect(asc.map((c) => c.name)).toEqual(["Анапа", "Бердск", "Москва"]);
    expect(asc[2].studios[0].products.map((p) => p.product)).toEqual([
      "Подарочный",
      "Пробное бесплатно",
    ]);
    const desc = zeroSortTree(tree, { key: "name", dir: "desc" });
    expect(desc[0].studios.map((s) => s.name)).toEqual(["Тверская", "Арбат"]);
  });

  test("по количеству — по возрастанию, равные — в их порядке", () => {
    const asc = zeroSortTree(tree, { key: "sales", dir: "asc" });
    expect(asc.map((c) => c.sales)).toEqual([6, 13, 16]);
    expect(asc[2].studios.map((s) => s.name)).toEqual(["Арбат", "Тверская"]);
    expect(asc[0].studios[0].products.map((p) => p.sales)).toEqual([2, 4]);
  });
});
