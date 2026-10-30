import { describe, expect, test } from "bun:test";

import {
  baseMeta,
  label,
  onecPayload,
  periodList,
  pyRound,
  shift,
  type AggRow,
  type Aggregate,
  type OnecReportMeta,
  type PartnerPayload,
  type RevenuePayload,
  type ZeroPayload,
} from "./payload";

const meta: OnecReportMeta = {
  generated_at: "2026-10-28T06:57:58.360910+00:00",
  coverage: { min: "2026-08-03", max: "2026-10-28" },
  breakEven: { Абакан: 700000, Бийск: 1 },
  zeroControls: null,
  studioOptions: null,
};

const row = (p: Partial<AggRow>): AggRow => ({
  period: "",
  day: "",
  city: "Абакан",
  studio: "Абакан Ленина",
  status: "Открыта",
  dimension: "",
  code: "",
  v1: 0,
  v2: 0,
  v3: 0,
  v4: 0,
  v5: 0,
  v6: 0,
  v7: 0,
  v8: 0,
  ...p,
});

/** Агрегаты по таблице «отчёт|разрез|начало|конец» → строки. */
function fake(table: Record<string, AggRow[]>): Aggregate {
  return async (report, start, end, grain = "detail") =>
    table[`${report}|${grain}|${start}|${end}`] ?? table[`${report}|${grain}`] ?? [];
}

describe("перенос full_reports.py: даты", () => {
  test("shift — их календарный сдвиг с обрезкой дня по концу месяца", () => {
    expect(shift("2026-03-31", -1)).toBe("2026-02-28");
    expect(shift("2024-03-31", -1)).toBe("2024-02-29");
    expect(shift("2026-01-15", -12)).toBe("2025-01-15");
    expect(shift("2026-10-01", -8)).toBe("2026-02-01");
  });

  test("period_list — от конца к началу; label — «Октябрь 2026»", () => {
    expect(periodList("2026-08-03", "2026-10-28")).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(label("2026-10")).toBe("Октябрь 2026");
  });

  test("период по умолчанию — с 1-го по вчера МСК, не позже данных", () => {
    // 29.10.2026 02:00 МСК: вчера — 28.10, данные — по 28.10.
    const b = baseMeta(meta, {}, Date.parse("2026-10-28T23:00:00Z"));
    expect([b.start, b.end, b.currentPeriod]).toEqual(["2026-10-01", "2026-10-28", "2026-10"]);
    expect(b.generatedAt).toBe("28.10.2026 09:57");
    // 30.10 — вчера 29.10, но данных после 28.10 нет.
    expect(baseMeta(meta, {}, Date.parse("2026-10-30T09:00:00Z")).end).toBe("2026-10-28");
    expect(() => baseMeta(meta, { start: "2026-10-05", end: "2026-10-01" })).toThrow(
      "Начало периода позже конца",
    );
    expect(() => baseMeta(meta, { start: "2026-02-30" })).toThrow("Неверная дата");
  });

  test("round — как в Python: ровно посередине — к чётному", () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(2.675, 2)).toBe(2.67); // 2.67499999… в двоичном
    expect(pyRound(-0.125, 2)).toBe(-0.12);
    expect(pyRound(1234.5678, 2)).toBe(1234.57);
  });
});

describe("перенос full_reports.py: доски", () => {
  test("выручка: недели месяца до конца месяца, прогноз, точка 0 города, порядок городов", async () => {
    const studio = [
      row({ v3: 300 }),
      row({ city: "Бийск", studio: "Бийск Мира", status: "Закрыта", v3: 20 }),
    ];
    const p = (await onecPayload(
      "revenue",
      { start: "2026-10-01", end: "2026-10-10" },
      meta,
      fake({
        "revenue|studio": studio,
        "revenue|monthly": [
          row({ period: "2026-09", v3: 900 }),
          row({ period: "2026-10", v3: 300 }),
          row({
            period: "2026-10",
            city: "Бийск",
            studio: "Бийск Мира",
            status: "Закрыта",
            v3: 20,
          }),
        ],
        "revenue|daily": [row({ day: "2026-10-01", v3: 100 }), row({ day: "2026-10-06", v3: 200 })],
      }),
    )) as RevenuePayload;
    // 01.10.2026 — четверг: 1-4, 5-11, …, 26-31 (до конца месяца).
    expect(p.bucketHeaders).toEqual(["1-4", "5-11", "12-18", "19-25", "26-31"]);
    expect(p.generatedAt).toBe("2026-10-28 09:57");
    expect(p.monthHeaders.map((m) => m.key)).toEqual(["2026-10", "2026-09", "2026-08"]);
    // Город с открытой студией — раньше.
    expect(p.rows.map((r) => r.name)).toEqual(["Абакан", "Бийск"]);
    const abakan = p.rows[0];
    expect(abakan.current).toBe(300);
    expect(abakan.forecast).toBe(930); // 300 / 10 × 31
    expect(abakan.breakEven).toBe(700000);
    expect(abakan.breakEvenDelta).toBe(300 - 700000);
    expect(abakan.buckets).toEqual({ "1-4": 100, "5-11": 200, "12-18": 0, "19-25": 0, "26-31": 0 });
    expect(abakan.months["2026-09"]).toBe(900);
    expect(p.networkRows.map((r) => [r.name, r.current])).toEqual([
      ["Итого по сети", 320],
      ["Итого открытые", 300],
      ["Итого закрытые", 20],
    ]);
    expect(p.summary).toMatchObject({
      totalCurrent: 320,
      openCurrent: 300,
      closedCurrent: 20,
      cities: 2,
      openStudios: 1,
    });
    expect(p.currentMonth).toBe("Октябрь 2026");
  });

  test("выручка за несколько месяцев: недели «дд.мм–дд.мм», без прогноза и точки 0", async () => {
    const p = (await onecPayload(
      "revenue",
      { start: "2026-09-28", end: "2026-10-06" },
      meta,
      fake({ "revenue|studio": [row({ v3: 5 })] }),
    )) as RevenuePayload;
    expect(p.bucketHeaders).toEqual(["28.09–04.10", "05.10–06.10"]);
    expect(p.rows[0].forecast).toBeNull();
    expect(p.rows[0].breakEven).toBeNull();
    expect(p.currentMonth).toBe("2026-09-28 — 2026-10-06");
  });

  test("нулевая номенклатура: строки и контроль нулевых продаж", async () => {
    const p = (await onecPayload(
      "zero",
      { start: "2026-10-01", end: "2026-10-28" },
      { ...meta, zeroControls: { blankCostRows: 3, explicitZeroRows: 1 } },
      fake({ "zero|detail": [row({ dimension: "Заморозка", code: "0003", v1: 2 })] }),
    )) as ZeroPayload;
    expect(p.records).toEqual([
      {
        period: "2026-10",
        city: "Абакан",
        studio: "Абакан Ленина",
        code: "0003",
        product: "Заморозка",
        sales: 2,
      },
    ]);
    expect([p.blankCostRows, p.explicitZeroRows, p.excludedTrialRows]).toEqual([3, 1, 0]);
  });

  test("«Мой город»: 15 показателей студии, прошлый месяц, точка 0 только без студии", async () => {
    const m = { ...meta, studioOptions: { Абакан: ["Абакан Ленина"], Бийск: ["Бийск Мира"] } };
    const table = {
      "revenue|studio": [row({ v3: 300 })],
      "sales|studio": [row({ v1: 2, v2: 1, v6: 5000 })],
      "funnel|studio": [row({ v1: 4, v2: 3, v4: 2, v6: 1, v7: 1 })],
      "trial_products|detail": [row({ dimension: "Пробное", v1: 4, v2: 3 })],
    };
    const p = (await onecPayload(
      "partner",
      { start: "2026-10-01", end: "2026-10-28" },
      m,
      fake(table),
    )) as PartnerPayload;
    expect(p.periods).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"]);
    expect(p.cities).toEqual(["Абакан", "Бийск"]);
    expect(p.records).toEqual([
      ["2026-10", "Абакан", "Абакан Ленина", 300, 2, 1, 0, 0, 0, 5000, 0, 0, 0, 4, 3, 2, 1, 1],
    ]);
    expect(p.previousRecords[0]).toMatchObject({
      city: "Абакан",
      studio: "Абакан Ленина",
      revenue: 300,
      trials: 4,
      bought_later: 1,
    });
    expect(p.trialProductRecords).toEqual([["2026-10", "Абакан", "Пробное", 4, 3, 0, 0]]);
    expect(p.breakEven).toEqual({ Абакан: 700000 });
    const withStudio = (await onecPayload(
      "partner",
      { start: "2026-10-01", end: "2026-10-28", city: "Абакан", studio: "Абакан Ленина" },
      m,
      fake(table),
    )) as PartnerPayload;
    expect(withStudio.breakEven).toEqual({});
    await expect(
      onecPayload("partner", { city: "Абакан", studio: "Бийск Мира" }, m, fake(table)),
    ).rejects.toThrow("Выбранная студия недоступна в этом городе");
  });
});
