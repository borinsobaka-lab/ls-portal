import { describe, expect, test } from "bun:test";

import type { RevenuePayload, RevenueRow } from "./payload";
import {
  allRevenueCities,
  cycleRevenueSort,
  parseRevenueStatus,
  revenueBodyRows,
  revenueCell,
  revenueColumns,
  revenueMoney,
  revenueRowMatches,
  revenueSortValue,
  revenueStatusLabel,
  revenueSummary,
  sortRevenueRows,
  sumChildRows,
  visibleRevenueColumns,
  type RevenueSort,
  type RevenueStatus,
} from "./revenue";

const NBSP = " ";

const row = (
  name: string,
  type: RevenueRow["type"],
  group: string,
  values: {
    current: number;
    forecast?: number | null;
    sep?: number;
    w1?: number;
    w2?: number;
    breakEven?: number | null;
    status?: string;
  },
): RevenueRow => {
  const r: RevenueRow = {
    name,
    type,
    group,
    current: values.current,
    forecast: values.forecast === undefined ? values.current * 2 : values.forecast,
    breakEven: values.breakEven ?? null,
    breakEvenDelta: values.breakEven == null ? null : values.current - values.breakEven,
    months: { "2026-10": values.current, "2026-09": values.sep ?? 0 },
    buckets: { "1-4": values.w1 ?? 0, "5-10": values.w2 ?? values.current - (values.w1 ?? 0) },
  };
  if (values.status !== undefined) r.status = values.status;
  return r;
};

const studios: Record<string, RevenueRow[]> = {
  Абакан: [
    row("Абакан Ленина", "studio", "Абакан", {
      current: 300,
      sep: 500,
      w1: 100,
      status: "Открыта",
    }),
    row("Абакан Мира", "studio", "Абакан", {
      current: 50,
      sep: 10,
      w1: 50,
      forecast: null,
      status: "Закрыта",
    }),
  ],
  Бийск: [row("Бийск Центр", "studio", "Бийск", { current: 300, sep: 100, status: "Открыта" })],
  Казань: [row("Казань Фучика", "studio", "Казань", { current: 0, sep: 900, status: "Закрыта" })],
};

const data: RevenuePayload = {
  generatedAt: "2026-10-30 06:06",
  sourceFile: "Сводные 1С · база портала",
  start: "2026-10-01",
  end: "2026-10-10",
  currentPeriod: "2026-10",
  minDate: "2026-09-01",
  maxDate: "2026-10-10",
  periods: [],
  currentMonth: "Октябрь 2026",
  currentDays: 10,
  monthDays: 31,
  monthHeaders: [
    { key: "2026-10", label: "Октябрь 2026" },
    { key: "2026-09", label: "Сентябрь 2026" },
  ],
  bucketHeaders: ["1-4", "5-10"],
  networkRows: [
    row("Итого по сети", "network", "Итого", { current: 650, sep: 1510, status: "Все" }),
    row("Итого открытые", "network", "Итого", { current: 600, sep: 600, status: "Открыта" }),
    row("Итого закрытые", "network", "Итого", { current: 50, sep: 910, status: "Закрыта" }),
  ],
  rows: [
    row("Абакан", "city", "Абакан", { current: 350, sep: 510, w1: 150, breakEven: 400 }),
    row("Бийск", "city", "Бийск", { current: 300, sep: 100 }),
    row("Казань", "city", "Казань", { current: 0, sep: 900 }),
  ],
  studios,
  summary: {
    totalCurrent: 650.4,
    totalForecast: null,
    openCurrent: 600,
    closedCurrent: 50,
    cities: 3,
    studios: 4,
    openStudios: 2,
  },
};

const view = (
  over: Partial<{
    search: string;
    statusFilter: RevenueStatus;
    expanded: Set<string>;
    sort: RevenueSort;
  }> = {},
) => ({
  search: "",
  statusFilter: "all" as RevenueStatus,
  expanded: new Set<string>(),
  sort: null,
  ...over,
});

const names = (rows: ReturnType<typeof revenueBodyRows>) =>
  rows.map((r) => `${r.kind}:${r.row.name}`);

describe("формат (их money / cell)", () => {
  test("целые с пробелами по разрядам, минус — дефисом", () => {
    expect(revenueMoney(1234567.6)).toBe(`1${NBSP}234${NBSP}568`);
    expect(revenueMoney(-1234.5)).toBe(`-1${NBSP}234`);
    expect(revenueMoney(-1.5)).toBe("-1");
    expect(revenueMoney(0.5)).toBe("1");
    expect(revenueMoney(999)).toBe("999");
  });
  test("null — «—», undefined и округлённый ноль — «0»", () => {
    expect(revenueMoney(null)).toBe("—");
    expect(revenueMoney(undefined)).toBe("0");
    expect(revenueMoney(0)).toBe("0");
    expect(revenueMoney(-0.4)).toBe("0");
  });
  test("ячейка: нет значения — приглушённое «—»; меньше нуля — красная, даже «0»", () => {
    expect(revenueCell(null)).toEqual({ text: "—", muted: true, negative: false });
    expect(revenueCell(undefined)).toEqual({ text: "—", muted: true, negative: false });
    expect(revenueCell(-0.3)).toEqual({ text: "0", muted: false, negative: true });
    expect(revenueCell(-31504)).toEqual({ text: `-31${NBSP}504`, muted: false, negative: true });
    expect(revenueCell(0)).toEqual({ text: "0", muted: false, negative: false });
  });
});

describe("сводка", () => {
  test("шесть плиток их подписями, прогноза нет — «—», студии — строкой", () => {
    expect(revenueSummary(data)).toEqual([
      { key: "current", label: "Факт текущего месяца", value: "650", note: "по текущему месяцу" },
      { key: "forecast", label: "Прогноз месяца", value: "—", note: "по текущему темпу" },
      { key: "open", label: "Факт открытые", value: "600", note: "активные студии" },
      { key: "closed", label: "Факт закрытые", value: "50", note: "без изменений" },
      { key: "cities", label: "Городов", value: "3", note: "в отчёте" },
      { key: "studios", label: "Студий всего", value: "4 / открытых 2", note: "по справочнику" },
    ]);
  });
});

describe("колонки", () => {
  test("недели, итог месяца, прогноз, точка 0, месяцы истории — их порядок и подписи", () => {
    const cols = revenueColumns(data);
    expect(cols.map((c) => [c.label, c.sub ?? "", c.sortKey ?? ""])).toEqual([
      ["1-4", "", "bucket:1-4"],
      ["5-10", "", "bucket:5-10"],
      ["Итого месяца", "Октябрь 2026", "month:2026-10"],
      ["Прогноз", "месяца", ""],
      ["Точка 0", "", "break-even"],
      ["Факт − точка 0", "", "break-even-delta"],
      ["Сентябрь", "2026", "month:2026-09"],
    ]);
    const abakan = data.rows[0];
    expect(cols.map((c) => c.value(abakan))).toEqual([150, 200, 350, 700, 400, -50, 510]);
  });
  test("«Свернуть текущий месяц» и «Показать точку 0»", () => {
    const cols = revenueColumns(data);
    const ids = (v: { currentMonthVisible: boolean; breakEvenVisible: boolean }) =>
      visibleRevenueColumns(cols, v).map((c) => c.id);
    expect(ids({ currentMonthVisible: true, breakEvenVisible: false })).toEqual([
      "bucket:1-4",
      "bucket:5-10",
      "current-month",
      "forecast",
      "month:2026-09",
    ]);
    expect(ids({ currentMonthVisible: false, breakEvenVisible: true })).toEqual([
      "break-even",
      "break-even-delta",
      "month:2026-09",
    ]);
  });
});

describe("сортировка", () => {
  test("клик: по убыванию → по возрастанию → выкл; другая колонка — снова по убыванию", () => {
    let s: RevenueSort = null;
    s = cycleRevenueSort(s, "month:2026-10");
    expect(s).toEqual({ key: "month:2026-10", direction: "desc" });
    s = cycleRevenueSort(s, "month:2026-10");
    expect(s).toEqual({ key: "month:2026-10", direction: "asc" });
    expect(cycleRevenueSort(s, "month:2026-10")).toBeNull();
    expect(cycleRevenueSort(s, "bucket:1-4")).toEqual({ key: "bucket:1-4", direction: "desc" });
  });
  test("значение: нет — 0; точка 0 — ?? 0; прогноз — || 0", () => {
    const kazan = data.rows[2];
    expect(revenueSortValue(kazan, { key: "break-even", direction: "desc" })).toBe(0);
    expect(revenueSortValue(kazan, { key: "month:2025-01", direction: "desc" })).toBe(0);
    expect(revenueSortValue(kazan, { key: "bucket:нет", direction: "desc" })).toBe(0);
    expect(revenueSortValue(studios.Абакан[1], { key: "forecast", direction: "desc" })).toBe(0);
    expect(revenueSortValue(data.rows[0], null)).toBe(0);
  });
  test("равные — по названию; без сортировки — порядок данных", () => {
    const rows = data.rows;
    const order = (s: RevenueSort) => sortRevenueRows(rows, s).map((r) => r.name);
    expect(order(null)).toEqual(["Абакан", "Бийск", "Казань"]);
    expect(order({ key: "month:2026-10", direction: "desc" })).toEqual([
      "Абакан",
      "Бийск",
      "Казань",
    ]);
    expect(order({ key: "month:2026-10", direction: "asc" })).toEqual([
      "Казань",
      "Бийск",
      "Абакан",
    ]);
    // 1-4: Абакан 150, Бийск 0, Казань 0 — у равных порядок по имени и при «по убыванию».
    expect(order({ key: "bucket:1-4", direction: "desc" })).toEqual(["Абакан", "Бийск", "Казань"]);
    expect(order({ key: "bucket:1-4", direction: "asc" })).toEqual(["Бийск", "Казань", "Абакан"]);
    expect(order({ key: "month:2026-09", direction: "desc" })).toEqual([
      "Казань",
      "Абакан",
      "Бийск",
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Абакан", "Бийск", "Казань"]);
  });
});

describe("поиск и статус", () => {
  test("ищет по названию, городу и статусу строки", () => {
    const [lenina, mira] = studios.Абакан;
    expect(revenueRowMatches(lenina, "абакан", "all")).toBe(true);
    expect(revenueRowMatches(lenina, "ленина", "all")).toBe(true);
    expect(revenueRowMatches(mira, "закрыта", "all")).toBe(true);
    expect(revenueRowMatches(lenina, "закрыта", "all")).toBe(false);
    expect(revenueRowMatches(mira, "", "Открыта")).toBe(false);
    expect(revenueRowMatches(data.rows[0], "", "Открыта")).toBe(true);
  });
  test("фильтр из адреса: неизвестное — «Все студии»", () => {
    expect(parseRevenueStatus("Закрыта")).toBe("Закрыта");
    expect(parseRevenueStatus("Открыта")).toBe("Открыта");
    expect(parseRevenueStatus(undefined)).toBe("all");
    expect(parseRevenueStatus("Все")).toBe("all");
  });
  test("подпись статуса: у итога сети «Все» не пишется", () => {
    expect(revenueStatusLabel(data.networkRows[0])).toBe("");
    expect(revenueStatusLabel(data.networkRows[1])).toBe("Открыта");
    expect(revenueStatusLabel(studios.Абакан[1])).toBe("Закрыта");
    expect(revenueStatusLabel(data.rows[0])).toBe("");
  });
});

describe("строки таблицы (их renderBody)", () => {
  test("итог сети и свёрнутые города", () => {
    expect(names(revenueBodyRows(data, view()))).toEqual([
      "network:Итого по сети",
      "city:Абакан",
      "city:Бийск",
      "city:Казань",
    ]);
  });
  test("раскрытый город — его студии; «Раскрыть все» — все города", () => {
    const rows = revenueBodyRows(data, view({ expanded: new Set(["Абакан"]) }));
    expect(names(rows)).toEqual([
      "network:Итого по сети",
      "city:Абакан",
      "studio:Абакан Ленина",
      "studio:Абакан Мира",
      "city:Бийск",
      "city:Казань",
    ]);
    expect(rows[1]).toMatchObject({ kind: "city", expanded: true });
    expect(allRevenueCities(data)).toEqual(new Set(["Абакан", "Бийск", "Казань"]));
  });
  test("поиск: найденные студии видны без раскрытия, город — с полными суммами", () => {
    const rows = revenueBodyRows(data, view({ search: "  МИРА " }));
    expect(names(rows)).toEqual(["city:Абакан", "studio:Абакан Мира"]);
    expect(rows[0].row).toBe(data.rows[0]);
    expect(names(revenueBodyRows(data, view({ search: "бийск" })))).toEqual([
      "city:Бийск",
      "studio:Бийск Центр",
    ]);
    expect(names(revenueBodyRows(data, view({ search: "итого" })))).toEqual([
      "network:Итого по сети",
    ]);
    expect(revenueBodyRows(data, view({ search: "нет такого" }))).toEqual([]);
  });
  test("фильтр статуса: свой итог сети, города без таких студий скрыты, суммы — по студиям", () => {
    const rows = revenueBodyRows(data, view({ statusFilter: "Закрыта" }));
    expect(names(rows)).toEqual(["network:Итого закрытые", "city:Абакан", "city:Казань"]);
    const abakan = rows[1].row;
    expect(abakan.current).toBe(50);
    expect(abakan.months).toEqual({ "2026-10": 50, "2026-09": 10 });
    expect(abakan.buckets).toEqual({ "1-4": 50, "5-10": 0 });
    // Прогноз студии null — у суммы 0, а не «—» (их особенность).
    expect(abakan.forecast).toBe(0);
    // «Точка 0» — городская, разница — от суммы видимых студий.
    expect(abakan.breakEven).toBe(400);
    expect(abakan.breakEvenDelta).toBe(-350);
    expect(rows[2].row.breakEvenDelta).toBeNull();
  });
  test("при фильтре статуса города сортируются по полным суммам, а студии — по своим", () => {
    const sort: RevenueSort = { key: "month:2026-09", direction: "desc" };
    const rows = revenueBodyRows(
      data,
      view({ statusFilter: "Закрыта", sort, expanded: new Set(["Абакан", "Казань"]) }),
    );
    // Сентябрь полностью: Казань 900, Абакан 510 — хотя видимые суммы 900 и 10.
    expect(names(rows)).toEqual([
      "network:Итого закрытые",
      "city:Казань",
      "studio:Казань Фучика",
      "city:Абакан",
      "studio:Абакан Мира",
    ]);
    const asc = revenueBodyRows(
      data,
      view({
        sort: { key: "month:2026-10", direction: "asc" },
        expanded: new Set(["Абакан"]),
      }),
    );
    expect(names(asc).slice(0, 5)).toEqual([
      "network:Итого по сети",
      "city:Казань",
      "city:Бийск",
      "city:Абакан",
      "studio:Абакан Мира",
    ]);
  });
  test("сумма по студиям не трогает исходную строку", () => {
    const before = JSON.stringify(data.rows[0]);
    sumChildRows(data, data.rows[0], studios.Абакан);
    expect(JSON.stringify(data.rows[0])).toBe(before);
    const all = sumChildRows(data, data.rows[0], studios.Абакан);
    expect(all.forecast).toBe(600);
    expect(all.current).toBe(350);
  });
});
