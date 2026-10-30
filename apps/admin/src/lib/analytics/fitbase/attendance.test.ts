import { describe, expect, test } from "bun:test";

import {
  fbAttCells,
  fbAttDelta,
  fbAttendanceReport,
  fbAttGroup,
  fbAttNotReady,
  fbAttNumber,
  fbAttPartialNumber,
  fbAttPendingLabel,
  fbAttRows,
  fbAttStudioValues,
  fbAttSummarize,
  FB_ATT_TEXT,
  type FbAttConnection,
  type FbAttendanceData,
} from "./attendance";

// Ожидания — их attendance_report, fitbase_attendance_page и partial.js
// (промежуточные итоги, строки студий без данных) на синтетических данных.

const conn = (id: number, patch: Partial<FbAttConnection> = {}): FbAttConnection => ({
  id,
  name: `Студия ${id}`,
  city: "Самара",
  brand: "Lady Stretch",
  studio_status: "active",
  attendance_synced_at: 1793000000 + id,
  attendance_from: "2025-01-01",
  attendance_to: "2026-10-29",
  attendance_state: "Занятия загружены",
  sync_state: "Загружено",
  busy: false,
  ...patch,
});

const base = (selected: FbAttConnection[], patch: Partial<FbAttendanceData> = {}) =>
  ({
    from: "2026-10-01",
    to: "2026-10-29",
    pm_from: "2026-09-01",
    pm_to: "2026-09-29",
    py_from: "2025-10-01",
    py_to: "2025-10-29",
    admin: true,
    connections: [],
    selected,
    trainings: ["Стретчинг", "Пилон"],
    groups: [
      ["current", null, null, null, 10, 40, 30, false],
      ["month", null, null, null, 8, 30, 24, false],
      ["current", "Самара", null, null, 10, 40, 30, false],
      ["month", "Самара", null, null, 8, 30, 24, false],
      ["current", "Самара", 1, null, 6, 24, 20, false],
      ["month", "Самара", 1, null, 8, 30, 24, false],
      ["current", "Самара", 1, "Стретчинг", 6, 24, 20, false],
      ["month", "Самара", 1, "Стретчинг", 8, 30, 24, false],
      ["current", "Самара", 2, null, 4, 16, 10, false],
      ["current", "Самара", 2, "Пилон", 4, 16, 10, false],
    ],
    unknown: [],
    ...patch,
  }) as FbAttendanceData;

describe("FitBase: «Занятия и посещаемость» — форматы", () => {
  test("их number() и Intl скрипта", () => {
    expect(fbAttNumber(1234567, "lessons")).toBe("1 234 567");
    expect(fbAttNumber(2.25, "avg_registered")).toBe("2,2");
    expect(fbAttNumber(82.35, "attendance")).toBe("82,3%");
    expect(fbAttNumber(null, "visited")).toBe("—");
    expect(fbAttPartialNumber(1234, 0)).toBe("1 234");
    expect(fbAttPartialNumber(2.25, 3)).toBe("2,3");
    expect(fbAttPartialNumber(null, 5)).toBe("—");
  });
  test("их summarize(): только строки с известными числами", () => {
    expect(
      fbAttSummarize([
        [6, 24, 20],
        [4, null, null],
      ]).map((x) => [x.value, x.known]),
    ).toEqual([
      [10, 2],
      [24, 1],
      [20, 1],
      [4, 1],
      [20 / 6, 1],
      [(20 / 24) * 100, 1],
    ]);
  });
});

describe("FitBase: «Занятия и посещаемость» — отчёт", () => {
  test("полные данные: итоги, сравнение плиток, «половина к чётному»", () => {
    const r = fbAttendanceReport(base([conn(1), conn(2)]));
    expect(r.ready).toBe(true);
    expect(r.updated).toBe(1793000001);
    expect(r.trainings).toEqual(["Пилон", "Стретчинг"]);
    expect(fbAttDelta(r, "lessons")).toEqual({ text: "↗ +25,0%", up: true });
    expect(fbAttDelta(r, "avg_registered")?.text).toBe("↗ +6,7%");
    // (75 − 80) / 80 = −6,25 % — у них format(+.1f) → −6,2.
    expect(fbAttDelta(r, "attendance")).toEqual({ text: "↘ -6,2%", up: false });
    expect(fbAttNotReady(r)).toBeNull();
  });

  test("сравнение с прошлым месяцем в таблице", () => {
    const r = fbAttendanceReport(base([conn(1), conn(2)]));
    const g = fbAttGroup(r, ["Самара", 1, null])!;
    expect(fbAttCells(g.metrics, g.coverage, "month").map((c) => c.text)).toEqual([
      "-25,0%",
      "-20,0%",
      "-16,7%",
      "+6,7%",
      "+11,1%",
      "+4,2%",
    ]);
    // У второй студии прошлого месяца нет — прочерки.
    const g2 = fbAttGroup(r, ["Самара", 2, null])!;
    expect(fbAttCells(g2.metrics, g2.coverage, "month").map((c) => c.text)).toEqual(
      Array(6).fill("—"),
    );
    expect(fbAttCells(g2.metrics, g2.coverage, "current").map((c) => c.text)).toEqual([
      "4",
      "16",
      "10",
      "4,0",
      "2,5",
      "62,5%",
    ]);
  });

  test("незагруженная студия: прочерки, промежуточные итоги, строки администратора", () => {
    const r = fbAttendanceReport(
      base([
        conn(1),
        conn(2, { attendance_from: "2026-10-01" }),
        conn(3, { city: "Тольятти", attendance_synced_at: null }),
      ]),
    );
    expect(r.ready).toBe(false);
    expect(r.metricCoverage.current.lessons).toBe(false);
    expect(fbAttDelta(r, "lessons")).toBeNull();
    const nr = fbAttNotReady(r)!;
    expect(nr.reason).toBe(FB_ATT_TEXT.notLoaded);
    expect(nr.affected).toEqual([]);

    const rows = fbAttRows(r, true);
    expect(rows.map((row) => [row.kind, row.label])).toEqual([
      ["city", "Самара"],
      ["studio", "Студия 1"],
      ["training", "Стретчинг"],
      ["studio", "Студия 2"],
      ["training", "Пилон"],
      ["pending-city", "Тольятти"],
      ["pending-studio", "Студия 3"],
    ]);
    expect(rows.at(-1)).toMatchObject({ status: "Ожидает загрузки" });
    // Сотруднику — только строки с данными.
    expect(fbAttRows(r, false)).toHaveLength(5);

    const totals = fbAttSummarize(
      rows.filter((row) => row.kind === "studio").map((row) => fbAttStudioValues(r, row.key)),
    );
    expect(totals.map((t, i) => [fbAttPartialNumber(t.value, i), t.known])).toEqual([
      ["10", 2],
      ["40", 2],
      ["30", 2],
      ["4,0", 2],
      ["3,0", 2],
      ["75,0%", 2],
    ]);
    // Итог «Итого» — прочерки (их сервер), страница подставит частичные.
    expect(fbAttCells(r.total, r.metricCoverage, "current").map((c) => c.text)).toEqual(
      Array(6).fill("—"),
    );
  });

  test("неизвестные коды и «Клиент не указан»", () => {
    const groups = base([]).groups.map((g) =>
      g[0] === "current" && (g[2] === 2 || g[2] === null)
        ? ([...g.slice(0, 7), true] as typeof g)
        : g,
    );
    const r = fbAttendanceReport(base([conn(1), conn(2)], { groups, unknown: [[2, "9"]] }));
    expect(r.ready).toBe(false);
    expect(r.metricCoverage.current.lessons).toBe(true);
    expect(r.metricCoverage.current.visited).toBe(false);
    const g2 = fbAttGroup(r, ["Самара", 2, null])!;
    expect(fbAttCells(g2.metrics, g2.coverage, "current").map((c) => c.text)).toEqual([
      "4",
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
    const nr = fbAttNotReady(r)!;
    expect(nr.reason).toBe(FB_ATT_TEXT.unknownCodes);
    expect(nr.affected.map((c) => c.id)).toEqual([2]);
    const r2 = fbAttendanceReport(
      base([conn(1), conn(2)], { groups, unknown: [[2, "Клиент не указан"]] }),
    );
    expect(fbAttNotReady(r2)!.reason).toBe(FB_ATT_TEXT.noClient);
    expect(fbAttNotReady(fbAttendanceReport(base([], { groups: [] })))!.reason).toBe(
      FB_ATT_TEXT.noStudios,
    );
  });

  test("подпись студии без данных (их statusLabel)", () => {
    expect(fbAttPendingLabel(conn(1, { busy: true }))).toBe("Загружается");
    expect(fbAttPendingLabel(conn(1, { sync_state: "Нет доступа к API" }))).toBe("Нет доступа API");
    expect(fbAttPendingLabel(conn(1))).toBe("Данные периода ещё не доступны");
    expect(fbAttPendingLabel(conn(1, { attendance_synced_at: null }))).toBe("Ожидает загрузки");
  });
});
