import { describe, expect, test } from "bun:test";

import {
  ALL,
  NO_FILTERS,
  activityDeltas,
  activityKpis,
  activityMetrics,
  activityTable,
  aggregateActivities,
  average,
  comparisonCell,
  comparisonPeriod,
  count,
  directionCount,
  directionLabel,
  filterRows,
  filtersSearch,
  inRange,
  matchesQuery,
  periodRows,
  rate,
  restoreFilters,
  shiftPeriod,
  studioKey,
  studioStatusOf,
  trend,
  unpackActivities,
  updateOptions,
  type ActivityRow,
} from "./activities";
import type { ActivitiesPayload } from "./payload";

const NB = " ";

// Период 2026-10-01 — 2026-10-12: текущие строки, прошлый месяц (09) и год (2025-10).
const payload: ActivitiesPayload = {
  generatedAt: "13.10.2026 10:50",
  sourceFile: "Сводные 1С · база портала",
  start: "2026-10-01",
  end: "2026-10-12",
  currentPeriod: "2026-10",
  minDate: "2025-01-01",
  maxDate: "2026-10-12",
  periods: [
    { key: "2026-10", label: "Октябрь 2026" },
    { key: "2026-09", label: "Сентябрь 2026" },
  ],
  previousPeriod: {
    start: "2026-09-19",
    end: "2026-09-30",
    records: [
      {
        city: "Абакан",
        studio: "Абакан Ленина",
        status: "Открыта",
        direction: "Стретчинг",
        held: 10,
        scheduled: 50,
        attended: 45,
      },
      {
        city: "Анапа",
        studio: "Анапа Морская",
        status: "Закрыта",
        direction: "Зумба",
        held: 5,
        scheduled: 20,
        attended: 20,
      },
    ],
  },
  cities: ["Абакан", "Анапа", "Ярославль"],
  studios: ["Абакан Ленина", "Абакан Мира", "Анапа Морская", "Ярославль Центр"],
  directions: ["Зумба", "Пилатес", "Стретчинг"],
  studioStatuses: ["Открыта", "Открыта", "Закрыта", "Открыта"],
  records: [
    ["2026-10-01", "2026-10", 0, 0, 2, 10, 60, 54],
    ["2026-10-01", "2026-10", 0, 0, 1, 4, 20, 10],
    ["2026-10-01", "2026-10", 0, 1, 2, 6, 30, 30],
    ["2026-10-01", "2026-10", 1, 2, 0, 5, 25, 20],
    ["2026-10-01", "2026-10", 2, 3, 1, 3, 12, 12],
    // прошлый месяц
    ["2026-09-01", "2026-09", 0, 0, 2, 10, 50, 50],
    ["2026-09-01", "2026-09", 1, 2, 0, 5, 25, 25],
    // прошлый год
    ["2025-10-01", "2025-10", 0, 0, 2, 8, 40, 30],
  ],
};

const rows = unpackActivities(payload);
const range = { start: payload.start, end: payload.end };

describe("форматы", () => {
  test("count — целое с неразрывным пробелом разрядов, пусто — 0", () => {
    expect(count(10881)).toBe(`10${NB}881`);
    expect(count(2.5)).toBe("3");
    expect(count(null)).toBe("0");
    expect(count(NaN)).toBe("0");
  });
  test("average — один знак после запятой, NaN — 0,0", () => {
    expect(average(5.55)).toBe("5,6");
    expect(average(5)).toBe("5,0");
    expect(average(NaN)).toBe("0,0");
    expect(average(-1.25)).toBe("-1,3");
  });
  test("rate — их toFixed с точкой, без базы — прочерк", () => {
    expect(rate(54791, 60803)).toBe("90.1%");
    expect(rate(1, 0)).toBe("—");
  });
});

describe("данные и фильтры", () => {
  test("unpack: город, студия, статус студии и направление по индексам", () => {
    expect(rows[2]).toEqual({
      date: "2026-10-01",
      period: "2026-10",
      city: "Абакан",
      studio: "Абакан Мира",
      status: "Открыта",
      direction: "Стретчинг",
      held: 6,
      scheduled: 30,
      attended: 30,
    });
  });

  test("в периоде — только строки с датой начала периода", () => {
    expect(rows.filter((r) => inRange(r, range))).toHaveLength(5);
    expect(filterRows(rows, range, NO_FILTERS).every((r) => r.period === "2026-10")).toBe(true);
  });

  test("фильтры: статус, город, студия, направления", () => {
    const f = { ...NO_FILTERS, status: "Закрыта" };
    expect(filterRows(rows, range, f).map((r) => r.studio)).toEqual(["Анапа Морская"]);
    const dirs = { ...NO_FILTERS, directions: ["Зумба", "Пилатес"] };
    expect(filterRows(rows, range, dirs).map((r) => r.direction)).toEqual([
      "Пилатес",
      "Зумба",
      "Пилатес",
    ]);
  });

  test("updateOptions: списки по-русски, пропавшее — «все», отметки снимаются", () => {
    const all = updateOptions(rows, range, NO_FILTERS);
    expect(all.options.cities).toEqual(["Абакан", "Анапа", "Ярославль"]);
    expect(all.options.studios).toEqual([
      "Абакан Ленина",
      "Абакан Мира",
      "Анапа Морская",
      "Ярославль Центр",
    ]);
    const abakan = updateOptions(rows, range, {
      ...NO_FILTERS,
      city: "Абакан",
      directions: ["Стретчинг", "Пилатес"],
    });
    expect(abakan.options.studios).toEqual(["Абакан Ленина", "Абакан Мира"]);
    expect(abakan.options.directions).toEqual(["Пилатес", "Стретчинг"]);
    // Студия «Абакан Мира» — только стретчинг: пилатес снимается.
    const mira = updateOptions(rows, range, { ...abakan.filters, studio: "Абакан Мира" });
    expect(mira.filters.directions).toEqual(["Стретчинг"]);
    // Закрытые — Абакана нет: город и студия становятся «все».
    const closed = updateOptions(rows, range, { ...mira.filters, status: "Закрыта" });
    expect(closed.filters).toEqual({
      status: "Закрыта",
      city: ALL,
      studio: ALL,
      directions: [],
    });
    expect(closed.options.cities).toEqual(["Анапа"]);
  });

  test("restoreFilters: город, студия, статус из адреса — только если есть в списке", () => {
    expect(
      restoreFilters(rows, range, { city: "Абакан", studio: "Абакан Мира" }).filters,
    ).toMatchObject({ city: "Абакан", studio: "Абакан Мира", status: ALL });
    // Студии нет в городе — остаётся «все».
    expect(
      restoreFilters(rows, range, { city: "Абакан", studio: "Анапа Морская" }).filters,
    ).toMatchObject({ city: "Абакан", studio: ALL });
    // Статус последним сбрасывает город.
    expect(
      restoreFilters(rows, range, { city: "Абакан", status: "Закрыта" }).filters,
    ).toMatchObject({ city: ALL, status: "Закрыта" });
    // Неизвестный статус и город не принимаются.
    expect(restoreFilters(rows, range, { city: "Москва", status: "Любая" }).filters).toEqual(
      NO_FILTERS,
    );
  });

  test("в адрес — только выбранное", () => {
    expect(filtersSearch({ ...NO_FILTERS, city: "Абакан" })).toEqual({
      city: "Абакан",
      studio: undefined,
      status: undefined,
    });
  });

  test("подпись направлений и счётчик", () => {
    expect(directionLabel([])).toBe("Все направления");
    expect(directionLabel(["Зумба"])).toBe("Зумба");
    expect(directionLabel(["Зумба", "Пилатес"])).toBe("Направлений выбрано: 2");
    expect(directionCount([])).toBe("");
    expect(directionCount(["Зумба", "Пилатес"])).toBe("Выбрано: 2");
  });

  test("поиск в списке — без регистра, по подстроке", () => {
    expect(matchesQuery("ЗУМБА Раменское", " зумба ")).toBe(true);
    expect(matchesQuery("Пилатес", "зум")).toBe(false);
    expect(matchesQuery("Пилатес", "  ")).toBe(true);
  });
});

describe("сравнения", () => {
  test("shiftPeriod — их сдвиг месяца, пустой — NaN-NaN", () => {
    expect(shiftPeriod("2026-10", -1)).toBe("2026-09");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-10", -12)).toBe("2025-10");
    expect(shiftPeriod("", -1)).toBe("NaN-NaN");
  });

  test("месяц сравнения — только если он есть в списке месяцев данных", () => {
    expect(comparisonPeriod(payload)).toBe("2026-10");
    expect(comparisonPeriod({ ...payload, currentPeriod: "2024-01" })).toBe("");
  });

  test("periodRows — по метке месяца и фильтрам", () => {
    expect(periodRows(rows, "2026-09", NO_FILTERS)).toHaveLength(2);
    expect(periodRows(rows, "2025-10", { ...NO_FILTERS, city: "Анапа" })).toHaveLength(0);
    expect(periodRows(rows, "NaN-NaN", NO_FILTERS)).toHaveLength(0);
  });
});

describe("плитки", () => {
  test("activityMetrics и activityDeltas", () => {
    const m = activityMetrics([{ held: 4, scheduled: 20, attended: 10 }]);
    expect(m).toEqual([4, 20, 10, 5, 2.5, 0.5]);
    expect(activityMetrics([])).toEqual([0, 0, 0, null, null, null]);
    expect(activityDeltas([10, 0, null], [5, 0, 3])).toEqual([100, null, null]);
  });

  test("значения, сравнение с предыдущим периодом и подсказка", () => {
    const current = filterRows(rows, range, NO_FILTERS);
    const kpis = activityKpis(current, payload.previousPeriod.records, payload.previousPeriod);
    expect(kpis.map((k) => k.value)).toEqual(["28", "147", "126", "5,3", "4,5", "85.7%"]);
    // 28 к 15 занятиям: +86,7%.
    expect(kpis[0].change).toEqual({ kind: "up", text: "+86,7%" });
    // Доходимость 126/147 к 65/70: падение — минус U+2212, в процентах.
    expect(kpis[5].change).toEqual({ kind: "down", text: "−7,7%" });
    expect(kpis[5].title).toBe(
      "Предыдущий период: 2026-09-19 — 2026-09-30 · изменение в п.п.: -7,1",
    );
    expect(kpis[1].title).toBe("Предыдущий период: 2026-09-19 — 2026-09-30");
  });

  test("без предыдущего периода по фильтрам — «—» и «нет базы»", () => {
    const f = { ...NO_FILTERS, city: "Ярославль" };
    const prev = payload.previousPeriod.records.filter((r) => r.city === "Ярославль");
    const kpis = activityKpis(filterRows(rows, range, f), prev, payload.previousPeriod);
    expect(kpis[0].change).toEqual({ kind: "missing", text: "—" });
    expect(kpis[0].title).toBe(
      "Предыдущий период: 2026-09-19 — 2026-09-30 · нет базы для сравнения",
    );
  });

  test("без строк — нули и прочерки, без изменений — 0,0%", () => {
    const empty = activityKpis([], [], undefined);
    expect(empty.map((k) => k.value)).toEqual(["0", "0", "0", "—", "—", "—"]);
    expect(empty[0].title).toBeUndefined();
    const same = activityKpis(
      [rows[0]],
      [{ ...payload.previousPeriod.records[0], held: 10, scheduled: 60, attended: 54 }],
    );
    expect(same[0].change).toEqual({ kind: "flat", text: "0,0%" });
  });
});

describe("таблица", () => {
  test("aggregate — суммы по разрезу в порядке появления", () => {
    const current = filterRows(rows, range, NO_FILTERS);
    expect(aggregateActivities(current, ["city"]).map((g) => [g.city, g.held])).toEqual([
      ["Абакан", 20],
      ["Анапа", 5],
      ["Ярославль", 3],
    ]);
  });

  test("trend: среднее — разница и %, доходимость — п.п.", () => {
    const cur = { scheduled: 6, attended: 5, attendance: 0.9 };
    const base = { scheduled: 5, attended: 5, attendance: 0.95 };
    expect(trend("scheduled", cur, base)).toEqual({ text: "+1,0 (+20.0%)", kind: "up" });
    expect(trend("attended", cur, base)).toEqual({ text: "0,0 (0.0%)", kind: "" });
    expect(trend("attendance", cur, base)).toEqual({ text: "-5,0 п.п.", kind: "down" });
    expect(trend("scheduled", cur, null)).toEqual({ text: "—", kind: "" });
    // Нулевая база — их «Infinity%».
    expect(trend("scheduled", cur, { ...base, scheduled: 0 }).text).toBe("+6,0 (+Infinity%)");
  });

  test("comparisonCell: текущее значение и изменения", () => {
    const item = { held: 10, scheduled: 60, attended: 54 };
    const prev = { held: 10, scheduled: 50, attended: 50 };
    expect(comparisonCell(item, prev, undefined, "scheduled", "current").text).toBe("6,0");
    expect(comparisonCell(item, prev, undefined, "attendance", "current").text).toBe("90.0%");
    expect(comparisonCell(item, prev, undefined, "scheduled", "month").text).toBe("+1,0 (+20.0%)");
    expect(comparisonCell(item, prev, undefined, "attendance", "year").text).toBe("—");
    expect(
      comparisonCell({ held: 0, scheduled: 0, attended: 0 }, prev, prev, "scheduled", "current")
        .text,
    ).toBe("—");
  });

  test("города по алфавиту, раскрытие студий и направлений, статус студии", () => {
    const current = filterRows(rows, range, NO_FILTERS);
    const prev = periodRows(rows, "2026-09", NO_FILTERS);
    const year = periodRows(rows, "2025-10", NO_FILTERS);
    const statusOf = studioStatusOf(payload);
    const closed = activityTable(current, prev, year, "current", new Set(), new Set(), statusOf);
    expect(closed.map((l) => l.name)).toEqual(["Абакан", "Анапа", "Ярославль"]);
    expect(closed[0]).toMatchObject({
      level: "city",
      expanded: false,
      held: "20",
      scheduled: "110",
      attended: "94",
    });
    const open = activityTable(
      current,
      prev,
      year,
      "month",
      new Set(["Абакан"]),
      new Set([studioKey("Абакан", "Абакан Ленина")]),
      statusOf,
    );
    expect(open.map((l) => [l.level, l.name])).toEqual([
      ["city", "Абакан"],
      ["studio", "Абакан Ленина"],
      ["direction", "Пилатес"],
      ["direction", "Стретчинг"],
      ["studio", "Абакан Мира"],
      ["city", "Анапа"],
      ["city", "Ярославль"],
    ]);
    expect(open[1].status).toBe("Открыта");
    // Абакан: 110/20 = 5,5 к 50/10 = 5,0 в прошлом месяце.
    expect(open[0].cells[0]).toEqual({ text: "+0,5 (+10.0%)", kind: "up" });
    // Стретчинг Ленина: 54/60 к 50/50 — минус 10 п.п.
    expect(open[3].cells[2]).toEqual({ text: "-10,0 п.п.", kind: "down" });
    // Пилатеса в прошлом месяце не было.
    expect(open[2].cells[0]).toEqual({ text: "—", kind: "" });
  });

  test("без месяца сравнения — изменений нет", () => {
    const current = filterRows(rows, range, NO_FILTERS);
    const none: ActivityRow[] = periodRows(rows, shiftPeriod("", -1), NO_FILTERS);
    const lines = activityTable(current, none, none, "year", new Set(), new Set(), () => "");
    expect(lines.every((l) => l.cells.every((c) => c.text === "—"))).toBe(true);
  });
});
