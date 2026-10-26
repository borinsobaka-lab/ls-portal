import { describe, expect, test } from "bun:test";

import {
  autoMap,
  cleanStudio,
  clientKey,
  findHeaderRow,
  isAttended,
  missingRequired,
  newTrialNames,
  parseCsv,
  parseDateCell,
  parseNumberCell,
  parseTable,
  splitNomenclature,
  type Cell,
  type ParsedRevenue,
  type ParsedSale,
} from "./import";

describe("ячейки", () => {
  test("даты: Excel, текст 1С, ISO, число Excel", () => {
    expect(parseDateCell(new Date(Date.UTC(2026, 7, 31)))).toEqual({
      day: "2026-08-31",
      time: null,
    });
    expect(parseDateCell("31.08.2026 14:05:00")).toEqual({ day: "2026-08-31", time: "14:05:00" });
    expect(parseDateCell("2026-08-31")).toEqual({ day: "2026-08-31", time: null });
    expect(parseDateCell(46265)).toEqual({ day: "2026-08-31", time: null });
    expect(parseDateCell("31.02.2026")).toBeNull();
    expect(parseDateCell("Итого")).toBeNull();
  });

  test("числа: пробелы, запятая, пусто", () => {
    expect(parseNumberCell("1 234,56")).toBe(1234.56);
    expect(parseNumberCell("12 500")).toBe(12500);
    expect(parseNumberCell("1,234,567")).toBe(1234567);
    expect(parseNumberCell(-500)).toBe(-500);
    expect(parseNumberCell("")).toBeNull();
    expect(parseNumberCell("нет")).toBeNull();
  });

  test("студия без «(удален)», номенклатура с кодом, статус посещения", () => {
    expect(cleanStudio(" Белгород, Есенина 7 (удален) ")).toBe("Белгород, Есенина 7");
    expect(splitNomenclature("00-00001234 Абонемент 8 занятий", null)).toEqual({
      code: "00-00001234",
      name: "Абонемент 8 занятий",
    });
    expect(splitNomenclature("Абонемент 8", "А-8")).toEqual({ code: "А-8", name: "Абонемент 8" });
    expect(splitNomenclature("Пробное занятие", null)).toEqual({
      code: "name:пробное занятие",
      name: "Пробное занятие",
    });
    expect(isAttended("Прибыл")).toBe(true);
    expect(isAttended("Не прибыл")).toBe(false);
    expect(isAttended("Пришёл")).toBe(true);
    expect(isAttended("Записан")).toBe(false);
  });
});

describe("колонки", () => {
  test("заголовки 1С узнаются, строка заголовка — под шапкой отчёта", () => {
    const rows: Cell[][] = [
      ["Продажи и оплаты", null, null],
      ["Период: 01.09.2026 - 30.09.2026", null, null],
      ["Дата", "Студия", "Номенклатура", "Клиент.Код", "Стоимость", "Оплата"],
    ];
    expect(findHeaderRow(rows, "sales")).toBe(2);
    const map = autoMap(rows[2], "sales");
    expect(map).toMatchObject({ date: 0, studio: 1, nomenclature: 2, client: 3, cost: 4, paid: 5 });
    expect(missingRequired("sales", map)).toEqual([]);
    expect(missingRequired("sales", { date: 0 }).map((f) => f.key)).toEqual([
      "studio",
      "nomenclature",
      "client",
      "paid",
    ]);
  });
});

describe("разбор таблиц", () => {
  test("выручка: иерархический отчёт — дата строкой выше, подытоги групп не считаются", () => {
    const rows: Cell[][] = [
      ["Структурная единица", "Период день", "Приход", "Расход"],
      [null, "01.09.2026", 1500, 0], // строка-группировка: подытог дня
      ["Барнаул, Ленина 1 (удален)", null, 1000, 100],
      ["Смоленск, Мира 5", null, 500, 0],
      [null, "02.09.2026", 300, 0],
      ["Барнаул, Ленина 1", null, 300, 0],
      ["Итого", null, 1800, 100],
    ];
    const header = findHeaderRow(rows, "revenue");
    const s = parseTable("revenue", rows, header, autoMap(rows[header], "revenue"));
    const out = s.result.rows as ParsedRevenue[];
    expect(out).toEqual([
      { studio: "Барнаул, Ленина 1", day: "2026-09-01", article: "", income: 1000, expense: 100 },
      { studio: "Смоленск, Мира 5", day: "2026-09-01", article: "", income: 500, expense: 0 },
      { studio: "Барнаул, Ленина 1", day: "2026-09-02", article: "", income: 300, expense: 0 },
    ]);
    expect([s.dateFrom, s.dateTo, s.skipped]).toEqual(["2026-09-01", "2026-09-02", 3]);
    expect(s.studios).toEqual(["Барнаул, Ленина 1", "Смоленск, Мира 5"]);
  });

  test("выручка: иерархия «студия → даты» — подытог студии не считается", () => {
    const rows: Cell[][] = [
      ["Структурная единица", "Период день", "Приход", "Расход"],
      ["Барнаул", null, 1500, 0],
      [null, "01.09.2026", 1000, 0],
      [null, "02.09.2026", 500, 0],
      ["Смоленск", null, 200, 0],
      [null, "01.09.2026", 200, 0],
    ];
    const s = parseTable("revenue", rows, 0, autoMap(rows[0], "revenue"));
    expect((s.result.rows as ParsedRevenue[]).map((r) => [r.studio, r.day, r.income])).toEqual([
      ["Барнаул", "2026-09-01", 1000],
      ["Барнаул", "2026-09-02", 500],
      ["Смоленск", "2026-09-01", 200],
    ]);
  });

  test("выручка: плоская выгрузка суммируется до студия × день × статья", () => {
    const rows: Cell[][] = [
      ["Дата", "Студия", "Статья", "Приход", "Расход"],
      ["01.09.2026", "Барнаул", "Продажи", "1 000", ""],
      ["01.09.2026", "Барнаул", "Продажи", "500", "50"],
      ["01.09.2026", "Барнаул", "Возврат", "", "200"],
    ];
    const s = parseTable("revenue", rows, 0, autoMap(rows[0], "revenue"));
    expect((s.result.rows as ParsedRevenue[]).map((r) => [r.article, r.income, r.expense])).toEqual(
      [
        ["Продажи", 1500, 50],
        ["Возврат", 0, 200],
      ],
    );
  });

  test("продажи: все строки, время из даты, клиент и номенклатура", () => {
    const rows: Cell[][] = [
      ["Дата", "Студия", "Номенклатура", "Клиент.Код", "Стоимость", "Оплата"],
      ["05.09.2026 12:30:00", "Барнаул", "00-001 Абонемент 8", "К-15", "5 000", "5000"],
      ["05.09.2026", "Барнаул", "Пробное занятие", "К-16", "", ""],
      ["05.09.2026", "", "Абонемент", "К-17", "1", "1"],
    ];
    const s = parseTable("sales", rows, 0, autoMap(rows[0], "sales"));
    const out = s.result.rows as ParsedSale[];
    expect(out.map((r) => [r.time, r.client, r.code, r.cost, r.paid])).toEqual([
      ["12:30:00", "К-15", "00-001", 5000, 5000],
      [null, "К-16", "name:пробное занятие", null, null],
    ]);
    expect(s.skipped).toBe(1);
  });

  test("занятия: только проведённые (все три числа > 0), суммы по направлению", () => {
    const rows: Cell[][] = [
      [
        "Дата",
        "Студия",
        "Направление",
        "Занятий проведено",
        "Клиентов записано",
        "Клиентов посетило",
      ],
      ["01.09.2026", "Барнаул", "Стретчинг", 2, 20, 15],
      ["01.09.2026", "Барнаул", "Стретчинг", 1, 8, 6],
      ["01.09.2026", "Барнаул", "Пилатес", 1, 5, 0],
    ];
    const s = parseTable("classes", rows, 0, autoMap(rows[0], "classes"));
    expect(s.result.rows).toEqual([
      {
        studio: "Барнаул",
        day: "2026-09-01",
        direction: "Стретчинг",
        classes: 3,
        booked: 28,
        attended: 21,
      },
    ]);
    expect(s.skipped).toBe(1);
  });

  test("посещения: пришёл по статусу, новые пробные членства — в справочник", () => {
    const rows: Cell[][] = [
      ["Дата", "Студия", "Членство, Пакет услуг", "Клиент.Код", "Статус"],
      ["01.09.2026", "Барнаул", "Пробное занятие", "К-1", "Прибыл"],
      ["01.09.2026", "Барнаул", "Пробное онлайн", "К-2", "Не прибыл"],
      ["01.09.2026", "Барнаул", "Абонемент 8", "К-3", "Прибыл"],
    ];
    const s = parseTable("visits", rows, 0, autoMap(rows[0], "visits"));
    if (s.result.kind !== "visits") throw new Error("kind");
    expect(s.result.rows.map((r) => r.attended)).toEqual([true, false, true]);
    expect(newTrialNames(s.result.rows, new Set(["пробное занятие"]))).toEqual([
      { code: "name:пробное онлайн", name: "Пробное онлайн" },
    ]);
  });
});

test("CSV: «;», кавычки, переносы", () => {
  expect(parseCsv('﻿Дата;Студия;Сумма\r\n01.09.2026;"Барнаул; Ленина";"1 000"\n')).toEqual([
    ["Дата", "Студия", "Сумма"],
    ["01.09.2026", "Барнаул; Ленина", "1 000"],
  ]);
});

test("хэш клиента: стабильный, без регистра, свой у системы", async () => {
  const a = await clientKey("1c", "К-15");
  expect(a).toHaveLength(32);
  expect(await clientKey("1c", " к-15 ")).toBe(a);
  expect(await clientKey("fitbase", "К-15")).not.toBe(a);
});
