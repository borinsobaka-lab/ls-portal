import { describe, expect, test } from "bun:test";

import type { SalesPayload, SalesRecord } from "./payload";
import {
  SALES_ALL,
  cycleSalesSort,
  salesBoardPeriod,
  salesCardTexts,
  salesCardTrendText,
  salesCardTrends,
  salesCardValues,
  salesCharts,
  salesCityOptions,
  salesCityVisible,
  salesComparisonAmount,
  salesCount,
  salesFiltered,
  salesMoney,
  salesPreviousPeriod,
  salesSelectCity,
  salesSelection,
  salesShortMonth,
  salesSortRows,
  salesStudioOptions,
  salesTableRows,
  salesTotals,
  salesTrendCell,
  salesUrlValue,
  shiftPeriod,
  stripRuble,
} from "./sales";

/** Разделитель разрядов ru-RU — неразрывный пробел (между цифрами). */
const n = (s: string) => s.replace(/(\d) (?=\d)/g, "$1\u00a0");

const rec = (p: Partial<SalesRecord>): SalesRecord => ({
  date: "2026-10-01",
  period: "2026-10",
  city: "Абакан",
  studio: "Абакан Ленина",
  product: "Абонемент 8",
  sales: 0,
  newSales: 0,
  repeatSales: 0,
  newPayments: 0,
  repeatPayments: 0,
  salesAmount: 0,
  ...p,
});

const current: SalesRecord[] = [
  rec({
    sales: 3,
    newSales: 2,
    repeatSales: 1,
    newPayments: 20000,
    repeatPayments: 9000,
    salesAmount: 29000,
  }),
  rec({ product: "Абонемент 4", sales: 1, newSales: 1, newPayments: 6000, salesAmount: 6000 }),
  rec({
    studio: "Абакан Мира",
    sales: 2,
    repeatSales: 2,
    repeatPayments: 18000,
    salesAmount: 18000,
  }),
  rec({
    city: "Бийск",
    studio: "Бийск Центр",
    sales: 4,
    newSales: 3,
    repeatSales: 1,
    newPayments: 27000,
    repeatPayments: 10000,
    salesAmount: 37000,
  }),
];

const history: SalesRecord[] = [
  rec({ date: "2026-09-01", period: "2026-09", product: "", sales: 5, salesAmount: 40000 }),
  rec({
    date: "2026-09-01",
    period: "2026-09",
    city: "Бийск",
    studio: "Бийск Центр",
    product: "",
    sales: 2,
    salesAmount: 50000,
  }),
  rec({ date: "2026-08-01", period: "2026-08", product: "", sales: 1, salesAmount: 9000 }),
];

const payload = (p: Partial<SalesPayload> = {}): SalesPayload => ({
  generatedAt: "30.10.2026 06:06",
  sourceFile: "Сводные 1С · база портала",
  start: "2026-10-01",
  end: "2026-10-15",
  currentPeriod: "2026-10",
  minDate: "2026-08-01",
  maxDate: "2026-10-28",
  periods: [
    { key: "2026-10", label: "Октябрь 2026" },
    { key: "2026-09", label: "Сентябрь 2026" },
    { key: "2026-08", label: "Август 2026" },
  ],
  records: [...current, ...history],
  cities: ["Абакан", "Бийск"],
  studios: ["Абакан Ленина", "Абакан Мира", "Бийск Центр"],
  dailyRecords: [
    ["2026-09-01", 0, 0, 25000],
    ["2026-09-01", 0, 1, 0],
    ["2026-09-01", 1, 2, 40000],
    ["2025-10-01", 0, 0, 10000],
  ],
  periodLastDays: { "2026-10": 31 },
  dailyMetrics: {
    "2026-10": [
      [31, "Абакан", "Абакан Ленина", 4, 3, 1, 26000, 9000, 35000],
      [31, "Абакан", "Абакан Мира", 2, 0, 2, 0, 18000, 18000],
      [31, "Бийск", "Бийск Центр", 4, 3, 1, 27000, 10000, 37000],
    ],
    "2026-09": [
      [31, "Абакан", "Абакан Ленина", 5, 4, 1, 30000, 8000, 38000],
      [31, "Бийск", "Бийск Центр", 4, 2, 2, 20000, 20000, 40000],
    ],
    "2025-10": [[31, "Абакан", "Абакан Ленина", 1, 1, 0, 10000, 0, 10000]],
  },
  ...p,
});

const ALL = { city: SALES_ALL, studio: SALES_ALL };

describe("форматирование", () => {
  test("деньги и счётчики — без копеек, ₽ слева, «-0» как у Intl", () => {
    expect(salesMoney(1234567.4)).toBe(n("₽ 1 234 567"));
    expect(salesMoney(Number.NaN)).toBe("₽ 0");
    expect(salesMoney(-0.3)).toBe("₽ -0");
    expect(salesCount(1532.5)).toBe(n("1 533"));
  });

  test("слой оформления снимает «₽»", () => {
    expect(stripRuble("₽ 1 234")).toBe("1 234");
    expect(stripRuble("+₽ 154 783 (+88%)")).toBe("+154 783 (+88%)");
    expect(stripRuble("₽ -94 656 (-17%)")).toBe("-94 656 (-17%)");
  });
});

describe("период", () => {
  test("месяц доски — месяц начала, если он есть среди месяцев снимка", () => {
    expect(salesBoardPeriod(payload())).toBe("2026-10");
    expect(salesBoardPeriod(payload({ currentPeriod: "2026-07" }))).toBe("");
  });

  test("сдвиг месяца: их shiftPeriod и previousPeriod", () => {
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-10", -12)).toBe("2025-10");
    expect(shiftPeriod("", -1)).toBe("NaN-NaN");
    expect(salesPreviousPeriod("2026-01")).toBe("2025-12");
    expect(salesPreviousPeriod("2026-10")).toBe("2026-09");
  });
});

describe("фильтры", () => {
  test("в плитки и таблицу идут только строки периода, без истории по месяцам", () => {
    expect(salesFiltered(payload(), ALL)).toHaveLength(4);
    expect(salesFiltered(payload(), { city: "Абакан", studio: SALES_ALL })).toHaveLength(3);
    expect(salesFiltered(payload(), { city: "Абакан", studio: "Абакан Мира" })).toHaveLength(1);
  });

  test("города и студии — из строк периода, по алфавиту", () => {
    const p = payload({
      records: [...current, rec({ city: "Анапа", studio: "Анапа 1" }), ...history],
    });
    expect(salesCityOptions(p)).toEqual(["Абакан", "Анапа", "Бийск"]);
    expect(salesStudioOptions(p, "Абакан")).toEqual(["Абакан Ленина", "Абакан Мира"]);
    expect(salesStudioOptions(p, SALES_ALL)).toHaveLength(4);
  });

  test("«Найти город» — без регистра, «все» видны при пустом запросе", () => {
    expect(salesCityVisible("Абакан", " аба ")).toBe(true);
    expect(salesCityVisible("Бийск", "аба")).toBe(false);
    expect(salesCityVisible("Бийск", "  ")).toBe(true);
  });

  test("город и студия из адреса — только если такой пункт есть", () => {
    const p = payload();
    expect(salesSelection(p, { city: "Бийск", studio: "Бийск Центр" })).toEqual({
      city: "Бийск",
      studio: "Бийск Центр",
    });
    expect(salesSelection(p, { city: "Казань", studio: "Бийск Центр" })).toEqual({
      city: SALES_ALL,
      studio: "Бийск Центр",
    });
    expect(salesSelection(p, { city: "Бийск", studio: "Абакан Мира" })).toEqual({
      city: "Бийск",
      studio: SALES_ALL,
    });
    expect(salesSelection(p, {})).toEqual(ALL);
  });

  test("смена города оставляет студию, если она есть у города", () => {
    const p = payload();
    const f = { city: SALES_ALL, studio: "Абакан Мира" };
    expect(salesSelectCity(p, f, "Абакан")).toEqual({ city: "Абакан", studio: "Абакан Мира" });
    expect(salesSelectCity(p, f, "Бийск")).toEqual({ city: "Бийск", studio: SALES_ALL });
  });

  test("в адрес не пишутся «все» и пустое", () => {
    expect(salesUrlValue(SALES_ALL)).toBeUndefined();
    expect(salesUrlValue("")).toBeUndefined();
    expect(salesUrlValue("Бийск")).toBe("Бийск");
  });
});

describe("плитки", () => {
  const totals = salesTotals(salesFiltered(payload(), ALL));

  test("суммы и средние чеки", () => {
    expect(totals).toEqual({
      sales: 10,
      newSales: 6,
      repeatSales: 4,
      newPayments: 53000,
      repeatPayments: 37000,
      salesAmount: 90000,
    });
    expect(salesCardValues(totals).slice(6)).toEqual([53000 / 6, 9250, 9000]);
    expect(salesCardValues(salesTotals([])).slice(6)).toEqual([0, 0, 0]);
  });

  test("подписи: «₽» снят слоем оформления, без него — остаётся", () => {
    expect(salesCardTexts(totals, true)).toEqual(
      ["10", "6", "4", "53 000", "37 000", "90 000", "8 833", "9 250", "9 000"].map(n),
    );
    expect(salesCardTexts(totals, false).slice(2, 4)).toEqual(["4", n("₽ 53 000")]);
  });

  test("сравнение с прошлым месяцем — по снимку сравнения, % округлён", () => {
    expect(salesCardTrends(payload(), "2026-10", SALES_ALL, SALES_ALL)).toEqual([
      11, 0, 33, 6, 32, 15, 6, -1, 4,
    ]);
    // Math.round(-7.5) = -7: половина — вверх, как у них в JS.
    expect(salesCardTrends(payload(), "2026-10", "Бийск", SALES_ALL).slice(0, 6)).toEqual([
      0, 50, -50, 35, -50, -7,
    ]);
    // Без базы прошлого месяца — «—».
    expect(salesCardTrends(payload(), "2026-10", "Абакан", "Абакан Мира")).toEqual(
      Array(9).fill(null),
    );
  });

  test("подпись сравнения плитки", () => {
    expect(salesCardTrendText(8)).toEqual({ arrow: "up", text: "+8%" });
    expect(salesCardTrendText(-1)).toEqual({ arrow: "down", text: "-1%" });
    expect(salesCardTrendText(0)).toEqual({ arrow: "up", text: "+0%" });
    expect(salesCardTrendText(-0)).toEqual({ arrow: "up", text: "+0%" });
    expect(salesCardTrendText(null)).toEqual({ arrow: null, text: "—" });
  });
});

describe("сравнения строк", () => {
  test("сумма прошлого периода — по индексам города и студии, до дня периода", () => {
    const p = payload();
    expect(salesComparisonAmount(p, "2026-09", 31, SALES_ALL, SALES_ALL)).toBe(65000);
    expect(salesComparisonAmount(p, "2026-09", 31, "Абакан", SALES_ALL)).toBe(25000);
    expect(salesComparisonAmount(p, "2026-09", 31, "Абакан", "Абакан Мира")).toBe(0);
    expect(salesComparisonAmount(p, "2025-10", 31, SALES_ALL, SALES_ALL)).toBe(10000);
    expect(salesComparisonAmount(p, "2026-09", 0, SALES_ALL, SALES_ALL)).toBe(0);
    expect(salesComparisonAmount(p, "2026-09", 31, "Казань", SALES_ALL)).toBe(0);
  });

  test("ячейка динамики", () => {
    expect(salesTrendCell(28000, 25000)).toEqual({
      text: n("+28 000 (+112%)"),
      dir: "up",
      noBase: false,
    });
    expect(salesTrendCell(-3000, 40000)).toEqual({
      text: n("-3 000 (-7%)"),
      dir: "down",
      noBase: false,
    });
    expect(salesTrendCell(37000, 0)).toEqual({ text: "нет базы", dir: "up", noBase: true });
    expect(salesTrendCell(0, 500).text).toBe("+0 (+0%)");
    expect(salesTrendCell(-0.3, 100)).toEqual({ text: "-0 (0%)", dir: "down", noBase: false });
  });
});

describe("таблица", () => {
  const p = payload();
  const rows = salesFiltered(p, ALL);
  const none = new Set<string>();

  test("сортировка по нажатию: убывание → возрастание → выкл.", () => {
    const desc = cycleSalesSort(null, "sales");
    expect(desc).toEqual({ key: "sales", direction: "desc" });
    const asc = cycleSalesSort(desc, "sales");
    expect(asc).toEqual({ key: "sales", direction: "asc" });
    expect(cycleSalesSort(asc, "sales")).toBeNull();
    expect(cycleSalesSort(asc, "avgAll")).toEqual({ key: "avgAll", direction: "desc" });
  });

  test("без сортировки — город и студия по алфавиту (ru)", () => {
    const list = [
      { city: "Ёлкино", studio: "б" },
      { city: "елкино", studio: "а" },
      { city: "Абакан", studio: "в" },
      { city: "Ёлкино", studio: "а" },
    ].map((r) => ({ ...r, ...salesTotals([]) }));
    expect(salesSortRows(list, null).map((r) => `${r.city}/${r.studio}`)).toEqual([
      "Абакан/в",
      "елкино/а",
      "Ёлкино/а",
      "Ёлкино/б",
    ]);
  });

  test("свернуто — только города: итоги, средние, сравнения", () => {
    const table = salesTableRows(p, rows, "2026-10", null, none, none);
    expect(table.map((r) => [r.level, r.name])).toEqual([
      ["city", "Абакан"],
      ["city", "Бийск"],
    ]);
    expect(table[0].cells).toEqual(
      ["6", "3", "3", "26 000", "27 000", "53 000", "8 667", "9 000", "8 833"].map(n),
    );
    expect(table[0].prev.text).toBe(n("+28 000 (+112%)"));
    expect(table[0].year.text).toBe(n("+43 000 (+430%)"));
    expect(table[1].prev.text).toBe(n("-3 000 (-7%)"));
    expect(table[1].year).toEqual({ text: "нет базы", dir: "up", noBase: true });
  });

  test("раскрытые город и студия; у номенклатуры «—» со стрелкой ↑", () => {
    const table = salesTableRows(
      p,
      rows,
      "2026-10",
      null,
      new Set(["Абакан"]),
      new Set(["Абакан Абакан Ленина"]),
    );
    expect(table.map((r) => [r.level, r.name])).toEqual([
      ["city", "Абакан"],
      ["studio", "Абакан Ленина"],
      ["product", "Абонемент 8"],
      ["product", "Абонемент 4"],
      ["studio", "Абакан Мира"],
      ["city", "Бийск"],
    ]);
    expect(table[1].prev.text).toBe(n("+10 000 (+40%)"));
    expect(table[1].year.text).toBe(n("+25 000 (+250%)"));
    expect(table[2].prev).toEqual({ text: "—", dir: "up", noBase: false });
    expect(table[4].prev.noBase).toBe(true);
    expect(table[1].toggle).toBe("Абакан Абакан Ленина");
    expect(table[2].toggle).toBeNull();
  });

  test("сортировка — на каждом уровне", () => {
    const open = new Set(["Абакан"]);
    const studios = new Set(["Абакан Абакан Ленина"]);
    const names = (sort: Parameters<typeof salesTableRows>[3]) =>
      salesTableRows(p, rows, "2026-10", sort, open, studios).map((r) => r.name);
    expect(names({ key: "salesAmount", direction: "desc" })).toEqual([
      "Абакан",
      "Абакан Ленина",
      "Абонемент 8",
      "Абонемент 4",
      "Абакан Мира",
      "Бийск",
    ]);
    expect(names({ key: "salesAmount", direction: "asc" })).toEqual([
      "Бийск",
      "Абакан",
      "Абакан Мира",
      "Абакан Ленина",
      "Абонемент 4",
      "Абонемент 8",
    ]);
    // Средний чек повторных: Бийск 10 000 > Абакан 9 000.
    expect(names({ key: "avgRepeat", direction: "desc" })[0]).toBe("Бийск");
  });

  test("без месяца периода сравнений нет — «нет базы»", () => {
    const table = salesTableRows(p, rows, "", null, none, none);
    expect(table.every((r) => r.prev.noBase && r.year.noBase)).toBe(true);
  });
});

describe("графики", () => {
  test("девять месяцев до месяца периода: месяц периода — строки периода", () => {
    const charts = salesCharts(payload(), "2026-10", ALL);
    expect(charts?.months).toEqual([
      { key: "2026-08", label: "Авг", sales: 1, amount: 9000 },
      { key: "2026-09", label: "Сен", sales: 7, amount: 90000 },
      { key: "2026-10", label: "Окт", sales: 10, amount: 90000 },
    ]);
    expect(charts?.maxSales).toBe(10);
    expect(charts?.salesBadge).toBe("10");
    expect(charts?.amountBadge).toBe(n("90 000"));
    expect(charts?.donut).toEqual({
      total: "10",
      newSales: "6",
      repeatSales: "4",
      newShare: 0.6,
      newPercent: "60,0",
      repeatPercent: "40,0",
    });
  });

  test("город и студия фильтруют графики", () => {
    const charts = salesCharts(payload(), "2026-10", { city: "Бийск", studio: SALES_ALL });
    expect(charts?.months.map((m) => m.sales)).toEqual([0, 2, 4]);
  });

  test("сумма от миллиона — «12,3 млн»; без продаж — повторные 100,0%", () => {
    const big = payload({ records: [rec({ sales: 1, salesAmount: 12_345_678 })] });
    expect(salesCharts(big, "2026-10", ALL)?.amountBadge).toBe("12,3 млн");
    const empty = salesCharts(payload(), "2026-10", { city: "Казань", studio: SALES_ALL });
    expect(empty?.maxSales).toBe(1);
    expect(empty?.donut.newPercent).toBe("0,0");
    expect(empty?.donut.repeatPercent).toBe("100,0");
  });

  test("без месяца периода графиков нет", () => {
    expect(salesCharts(payload(), "", ALL)).toBeNull();
    expect(salesShortMonth("2026-01")).toBe("Янв");
  });
});
