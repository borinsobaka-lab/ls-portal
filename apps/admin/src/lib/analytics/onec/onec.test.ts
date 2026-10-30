import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import {
  processOnec,
  reviewKey,
  type FactRow,
  type ItemRow,
  type OnecFileInput,
  type OnecInputs,
} from "./process";
import {
  canonicalCity,
  excelRoundTrip,
  normalizeProcess,
  normalizeStudio,
  normalizeStudioName,
  parseActivityDate,
  parseRuDate,
  parseSaleDatetime,
  pyFloat,
  splitNomenclature,
} from "./rules";
import {
  cleanedView,
  cleanPlan,
  iterRows,
  openXlsx,
  xmlUnescape,
  type Cell,
  type Inflate,
} from "./xlsx-read";
import { writeXlsx } from "./xlsx-write";

const inflate: Inflate = async function* (data) {
  const s = Readable.from([Buffer.from(data)]).pipe(createInflateRaw());
  for await (const c of s) yield c as Uint8Array;
};

async function rowsOf(bytes: Uint8Array, opts: { minRow?: number; maxCol?: number } = {}) {
  const out: Cell[][] = [];
  for await (const r of iterRows(await openXlsx(bytes, inflate), opts)) out.push(r);
  return out;
}

describe("правила 1С (перенос их функций)", () => {
  test("даты как strptime: часы одной цифрой, без секунд, без времени; 31.02 — не дата", () => {
    expect(parseSaleDatetime("1.10.2026 9:05:00")).toBe("2026-10-01 09:05:00");
    expect(parseSaleDatetime("28.10.2026 10:03")).toBe("2026-10-28 10:03:00");
    expect(parseSaleDatetime(" 28.10.2026 ")).toBe("2026-10-28 00:00:00");
    expect(parseSaleDatetime("31.02.2026")).toBeNull();
    expect(parseActivityDate("2026-10-01")).toBe("2026-10-01");
    expect(parseRuDate("01 октября 2026")).toBe("2026-10-01");
    expect(parseRuDate("Период день")).toBeNull();
  });

  test("студии: «(удален)» убирается, статус по пометке; у сборки снимка пробелы не сжимаются", () => {
    expect(normalizeStudio("Химки  (удален) (удален)")).toBe("Химки");
    expect(normalizeStudioName(" Химки (Удален) ")).toEqual({ name: "Химки", status: "Закрыта" });
    expect(normalizeProcess("Химки  Мира (удален)")).toBe("Химки  Мира");
    expect(canonicalCity("")).toBe("Город не заполнен");
    expect(canonicalCity("Казань Стоблова")).toBe("Казань Столбова");
  });

  test("номенклатура «код, название» — по первой запятой; числа как float() Python", () => {
    expect(splitNomenclature("00000080534, Абонемент, 8 занятий")).toEqual([
      "00000080534",
      "Абонемент, 8 занятий",
    ]);
    expect(splitNomenclature(", ")).toEqual(["", ""]);
    expect(splitNomenclature("00000080534")).toEqual(["00000080534", ""]);
    expect(pyFloat(" 1_000.5 ")).toBe(1000.5);
    expect(Number.isNaN(pyFloat("1__0"))).toBe(true);
    // openpyxl пишет числа «%.16g»
    expect(excelRoundTrip(65989.1 - 11293)).toBe(54696.10000000001);
  });
});

describe("чтение .xlsx", () => {
  test("значения, пропуски строк и сущности XML; очищенный вид как после ExcelCleaner", async () => {
    expect(xmlUnescape("&#1050;од &amp; &#x41;")).toBe("Код & A");
    const bytes = await writeXlsx([
      {
        name: "Лист_1",
        rows: [
          ["Отбор: все", null, null, null],
          [null, null, null, null],
          ["Студия", null, "Сумма", "=SUM(A1)"],
          ["Абакан", null, 1.5, null],
        ],
      },
    ]);
    const rows = await rowsOf(bytes, { maxCol: 4 });
    expect(rows).toEqual([
      ["Отбор: все", null, null, null],
      [null, null, null, null],
      ["Студия", null, "Сумма", "=SUM(A1)"],
      ["Абакан", null, 1.5, null],
    ]);
    const book = await openXlsx(bytes, inflate, { sheet: "first" });
    const plan = await cleanPlan(book);
    expect(plan).toEqual({ columns: [0, 2, 3], emptyRows: [2] });
    const cleaned: Cell[][] = [];
    for await (const r of iterRows(cleanedView(book, plan))) cleaned.push(r);
    // Пустая строка и столбец ушли, «=…» стало формулой без значения.
    expect(cleaned).toEqual([
      ["Отбор: все", null, null],
      ["Студия", "Сумма"],
      ["Абакан", 1.5],
    ]);
  });
});

// --- Конвейер на синтетических выгрузках ------------------------------------------

const H = (cells: Cell[][]) => cells;

async function file(
  kind: OnecFileInput["kind"],
  name: string,
  rows: Cell[][],
): Promise<OnecFileInput> {
  const bytes = await writeXlsx([{ name: "Лист_1", rows }]);
  return { kind, name, load: async () => bytes };
}

async function baseInputs(extra: Partial<OnecInputs> = {}): Promise<OnecInputs> {
  const cash = await file("cash", "НДЯ выгрузка.xlsx", [
    ["Структурная единица", "Период день", "Сумма", null, null, null],
    [null, null, "Нач. остаток", "Приход", "Расход", "Кон. остаток"],
    [null, "01 октября 2026", 0, 1050, 100, 950],
    ["Абакан Ленина", null, 0, 1000, 100, 900],
    ["Бийск Мира (удален)", null, 0, 50, null, 50],
    [null, "02 октября 2026", 0, 200.5, 0, 200.5],
    ["Абакан Ленина", null, 0, 200.5, null, 200.5],
    ["Итого", null, null, 1250.5, 100, null],
  ]);
  const salesHead = H([
    ["Структурная единица", null, null, null, "Продажи", null, "Оплачено"],
    [
      "Структурная единица",
      "Код, Номенклатура",
      "Клиент.Код",
      "Документ продажи.Дата",
      "Количество",
      "Стоимость",
      "Оплата",
    ],
  ]);
  const sales2026 = await file("sales", "Продажи 2026г.xlsx", [
    ...salesHead,
    ["Абакан Ленина", null, null, null, 5, 3000, 2500],
    ["Абакан Ленина", "0001, Абонемент 8", "C1", "01.10.2026 10:00:00", 1, 1000, 1000],
    ["Абакан Ленина", "0001, Абонемент 8", "C1", "05.10.2026 10:00:00", 1, 1000, 500],
    ["Абакан Ленина", "0002, Пробное занятие Абакан", "C2", "02.10.2026 9:00:00", 1, null, null],
    ["Абакан Ленина", "0003, Заморозка", "C1", "03.10.2026 12:00", 1, 0, null],
    ["Абакан Ленина", "0001, Абонемент 8", "C2", "03.10.2026 18:00:00", 1, 1000, 1000],
    ["Итого", null, null, null, 5, 3000, 2500],
  ]);
  const sales2025 = await file("sales", "Продажи 2025г.xlsx", [
    ...salesHead,
    ["Бийск Мира (удален)", "0001, Абонемент 8", "C1", "15.09.2025 10:00:00", 1, 900, 900],
    // та же продажа, что в файле 2026 — дубль между годовыми файлами
    ["Абакан Ленина", "0001, Абонемент 8", "C2", "03.10.2026 18:00:00", 1, 1000, 1000],
  ]);
  const classes = await file("classes", "Занятия 2026.xlsx", [
    [
      "Структурная единица",
      "Услуга занятия",
      "Занятие.Дата.Начало дня",
      "Клиентов",
      null,
      "Занятий",
    ],
    [null, null, null, "Записано", "Посетило", "Проведено"],
    ["Абакан Ленина", "Stretching", "01.10.2026", 10, 8, 1],
    ["Абакан Ленина", "Stretching", "01.10.2026", 10, 8, 1],
    ["Абакан Ленина", "Barre", "02.10.2026", 0, 0, 1],
  ]);
  const visits = await file("visits", "Октябрь 2026.xlsx", [
    [
      "Структурная единица",
      "Статус прибытия",
      "Услуга занятия",
      "Клиент.Код",
      "Членство, Пакет услуг",
      "Занятие.Дата время начала",
      "Клиентов",
      null,
      "Занятий",
    ],
    [null, null, null, null, null, null, "Записано", "Посетило", "Проведено"],
    [
      "Абакан Ленина",
      "Прибыл",
      "Stretching",
      "C2",
      "Пробное занятие Абакан",
      "02.10.2026 19:00:00",
      5,
      4,
      1,
    ],
    [
      "Абакан Ленина",
      "Не прибыл",
      "Stretching",
      "C3",
      "Пробное  занятие Абакан",
      "04.10.2026 19:00:00",
      5,
      4,
      1,
    ],
    ["Абакан Ленина", "Прибыл", "Stretching", "C1", "Абонемент 8", "01.10.2026 10:00:00", 5, 4, 1],
  ]);
  return {
    files: [cash, sales2026, sales2025, classes, visits],
    studios: [
      { studio: "Абакан Ленина", status: "Открыта", city: "Абакан", partner: null, comment: null },
      { studio: "Бийск Мира", status: "Закрыта", city: "Бийск", partner: null, comment: null },
    ],
    nomenclature: [
      { code: "0001", names: "Абонемент 8", category: "Абонемент", direction: "" },
      { code: "0002", names: "Пробное занятие Абакан", category: "Пробное занятие", direction: "" },
      { code: "0003", names: "Заморозка", category: "Сервис / изменение условий", direction: "" },
    ],
    breakEven: [
      { direction: "Lady Stretch", city_for_board: "Абакан", amount: "700000" },
      { direction: "Lady Stretch", city_for_board: "Абакан", amount: "100" },
      { direction: "Lady Jump", city_for_board: "Бийск", amount: "1" },
      { direction: "Lady Stretch", city_for_board: "Бийск", amount: "нет" },
    ],
    sha256Hex: (s) => createHash("sha256").update(s, "utf8").digest("hex"),
    ...extra,
  };
}

async function run(input: OnecInputs) {
  const items = new Map<number, ItemRow>();
  const facts = new Map<string, number[]>();
  const result = await processOnec(input, {
    inflate,
    log: () => {},
    writer: {
      items: async (rows) => rows.forEach((r) => items.set(r.no, r)),
      facts: async (rows: FactRow[]) => {
        for (const [no, day, ...v] of rows) {
          const k = `${no}|${day}`;
          const f = facts.get(k);
          if (f) v.forEach((x, i) => (f[i] += x));
          else facts.set(k, v);
        }
      },
    },
  });
  const byKey = new Map<string, number[]>();
  for (const [k, v] of facts) {
    const [no, day] = k.split("|");
    const it = items.get(Number(no))!;
    byKey.set(
      [it.report, it.city, it.studio, it.dimension, it.code, it.status, day].join(" | "),
      v,
    );
  }
  return { result, facts: byKey };
}

describe("обработка 1С (process.py и своды)", () => {
  test("выручка, продажи, занятия, воронка, виды пробных, нулевая — по их правилам", async () => {
    const { result, facts } = await run(await baseInputs());
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    const f = (key: string) => facts.get(key)?.slice(0, 8);
    // Выручка: статус — из справочника, «Итого» и строки дней пропущены.
    expect(
      f("revenue | Абакан | Абакан Ленина | Без детализации |  | Открыта | 2026-10-01"),
    ).toEqual([1000, 100, 900, 0, 0, 0, 0, 0]);
    expect(f("revenue | Бийск | Бийск Мира | Без детализации |  | Закрыта | 2026-10-01")).toEqual([
      50, 0, 50, 0, 0, 0, 0, 0,
    ]);
    // Продажи: первая покупка C1 — в 2025 (по всей сети), поэтому в 2026 обе — повторные;
    // дубль C2 из файла 2025 не задвоился.
    expect(f("sales | Бийск | Бийск Мира | Абонемент 8 | 0001 | Закрыта | 2025-09-15")).toEqual([
      1, 1, 0, 900, 0, 900, 0, 0,
    ]);
    expect(f("sales | Абакан | Абакан Ленина | Абонемент 8 | 0001 | Открыта | 2026-10-01")).toEqual(
      [1, 0, 1, 0, 1000, 1000, 0, 0],
    );
    expect(f("sales | Абакан | Абакан Ленина | Абонемент 8 | 0001 | Открыта | 2026-10-05")).toEqual(
      [1, 0, 1, 0, 500, 1000, 0, 0],
    );
    expect(f("sales | Абакан | Абакан Ленина | Абонемент 8 | 0001 | Открыта | 2026-10-03")).toEqual(
      [1, 1, 0, 1000, 0, 1000, 0, 0],
    );
    // Занятия: одинаковые ключи суммируются, занятие с нулями исключено.
    expect(f("activities | Абакан | Абакан Ленина | Stretching |  | Открыта | 2026-10-01")).toEqual(
      [2, 20, 16, 0, 0, 0, 0, 0],
    );
    expect([...facts.keys()].some((k) => k.includes("Barre"))).toBe(false);
    // Воронка: C2 пришла 02.10, купила 03.10 (в окне 14 дней, не в день);
    // окно ещё не закрыто (последняя продажа 05.10). C3 не пришла.
    expect(f("funnel | Абакан | Абакан Ленина | Stretching |  | Открыта | 2026-10-02")).toEqual([
      1, 1, 1, 0, 1, 1, 1, 1,
    ]);
    expect(f("funnel | Абакан | Абакан Ленина | Stretching |  | Открыта | 2026-10-04")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(
      f(
        "trial_products | Абакан | Абакан Ленина | Пробное занятие Абакан |  | Открыта | 2026-10-02",
      ),
    ).toEqual([1, 1, 0, 1, 0, 0, 0, 0]);
    // Нулевая: «Заморозка» (стоимость 0) — да, пробное — нет.
    expect(f("zero | Абакан | Абакан Ленина | Заморозка | 0003 | Открыта | 2026-10-03")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(result.zeroControls).toEqual({
      blankCostRows: 1,
      explicitZeroRows: 1,
      excludedTrialRows: 1,
    });
    expect(result.breakEven).toEqual({ Абакан: 700100 });
  });

  test("новая номенклатура — обработка останавливается со списком; название с « | » спрашивается каждый раз", async () => {
    const input = await baseInputs();
    input.files.push(
      await file("sales", "Продажи 2024г.xlsx", [
        ["Структурная единица", null, null, null, "Продажи", null, "Оплачено"],
        ["Структурная единица", "Код, Номенклатура", null, null, null, null, null],
        ["Абакан Ленина", "0009, Пробное 2 за 490 | Акция", "C9", "01.01.2024", 1, null, null],
      ]),
    );
    const first = await run(input);
    expect(first.result.status).toBe("review");
    if (first.result.status !== "review") return;
    expect(first.result.review.items).toEqual([
      {
        code: "0009",
        name: "Пробное 2 за 490 | Акция",
        reason: "Новая номенклатура",
        suggested_designation: "Пробное занятие",
      },
    ]);
    // Категорию выбрали: в справочнике есть, но « | » внутри названия снова даёт «новое название».
    const classified = first.result.nomenclature.map((r) =>
      r.code === "0009" ? { ...r, category: "Пробное занятие" } : r,
    );
    const second = await run({ ...input, nomenclature: classified });
    expect(second.result.status).toBe("review");
    if (second.result.status !== "review") return;
    expect(second.result.review.items.map((i) => i.reason)).toEqual([
      "Новое название у известного кода",
    ]);
    // На только что отвеченное окно обработка идёт дальше (у них — в том же запуске).
    const third = await run({
      ...input,
      nomenclature: classified,
      answeredReview: new Set(second.result.review.items.map(reviewKey)),
    });
    expect(third.result.status).toBe("done");
  });

  test("студии нет в справочнике — обработка останавливается (их обязательная сверка статусов)", async () => {
    const input = await baseInputs();
    input.studios = input.studios.filter((s) => s.studio !== "Бийск Мира");
    await expect(run(input)).rejects.toThrow("Бийск Мира");
  });
});
