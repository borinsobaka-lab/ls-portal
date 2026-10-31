import { describe, expect, test } from "bun:test";

import {
  fbCityFmt,
  fbCityPct,
  fbCityPercent,
  fbCityRub,
  fbMyCityProducts,
  fbMyCityRevenue,
  fbMyCitySummary,
  fbMyCityTrialRows,
  type FbMyCityConnection,
  type FbMyCityData,
  type FbMyCityPayload,
} from "./mycity";
import { fbSalesReport } from "./reports";

const conn = (id: number, extra: Partial<FbMyCityConnection> = {}): FbMyCityConnection => ({
  id,
  name: `Студия ${id}`,
  brand: "Lady Stretch",
  city: "Самара",
  domain: "ls",
  club_id: String(id),
  studio_status: "active",
  marketing_disabled: false,
  partner_name: "",
  synced_at: null,
  sales_payments_at: 1793000000,
  sales_synced_at: 1792000000,
  sales_state: "",
  revenue_synced_at: 1793000000,
  revenue_from: "2026-01-01",
  revenue_to: "2026-10-30",
  revenue_state: "",
  attendance_synced_at: 1793000000,
  ...extra,
});
// 31.10.2026 12:00 МСК.
const NOW = Date.parse("2026-10-31T09:00:00Z") / 1000;

describe("«Мой город · FitBase» — их revenue", () => {
  test("граница — вчера по Самаре, прогноз текущего месяца, владельцы пар «домен + клуб»", () => {
    const rows = [conn(1), conn(2, { club_id: "1", revenue_synced_at: 1700000000 }), conn(3)];
    const daily: [number, string, number][] = [
      [1, "2026-10-01", 100000],
      [1, "2026-10-30", 50000],
      [1, "2026-10-31", 99999],
      [2, "2026-10-02", 70000],
      [3, "2026-10-05", 30000],
    ];
    const r = fbMyCityRevenue(rows, daily, "2026-10-01", "2026-10-31", NOW);
    // Студия 2 — тот же клуб, что 1, с более старой загрузкой: не считается.
    expect([...r.amounts]).toEqual([
      [1, 150000],
      [3, 30000],
    ]);
    expect(r.total).toBe(180000);
    expect(r.cutoff).toBe("2026-10-30");
    expect(r.forecast).toBeCloseTo((180000 / 30) * 31, 6);
    expect([r.known, r.expected, r.complete]).toEqual([2, 2, true]);
  });

  test("нет полного периода — студия в «missing», без данных — null", () => {
    const r = fbMyCityRevenue(
      [conn(1, { revenue_to: "2026-10-20" })],
      [],
      "2026-10-01",
      "2026-10-30",
      NOW,
    );
    expect([r.total, r.forecast, r.missing, r.complete]).toEqual([null, null, ["Студия 1"], false]);
    const past = fbMyCityRevenue(
      [conn(1)],
      [[1, "2026-09-03", 5]],
      "2026-09-01",
      "2026-09-30",
      NOW,
    );
    expect([past.total, past.forecast]).toEqual([5, null]);
  });
});

describe("«Мой город · FitBase» — что покупают и пробные", () => {
  test("продажи по названию абонемента: новые и продления, оплаты периода", () => {
    const at = (day: string) => Date.parse(`${day}T09:00:00Z`) / 1000;
    const data = {
      start: "2026-10-01",
      end: "2026-10-31",
      connections: [conn(1)],
      sales: [
        [1, "10", "k1", at("2026-09-10"), 150000, 0],
        [1, "11", "k1", at("2026-10-05"), 300000, 0],
        [1, "12", "k2", at("2026-10-06"), 300000, 0],
      ],
      history: [],
      payments: [
        [1, "purchase", "s1", "11", "k1", at("2026-10-05"), "2026-10-05", 300000],
        [1, "purchase", "s2", "12", "k2", at("2026-10-06"), "2026-10-06", 300000],
        [1, "refund", "s3", "12", "k2", at("2026-10-07"), "2026-10-07", 100000],
      ],
      contract_labels: [
        [1, "11", "Безлимит"],
        [1, "12", "Безлимит"],
      ],
    } as unknown as FbMyCityData;
    const sales = fbSalesReport(data, {
      start: data.start,
      end: data.end,
      brand: "",
      city: "",
      studio: "",
      search: "",
    });
    // [название, все, оплаты, новые, оплаты новых, продления, оплаты продлений]
    expect(fbMyCityProducts(data, sales)).toEqual([["Безлимит", 2, 5000, 1, 2000, 1, 3000]]);
  });

  test("пробные по названию: без записавшихся не показываются, неизвестное — своим названием", () => {
    const day = "2026-10-05";
    const data = {
      trials: {
        from: "2026-10-01",
        to: "2026-10-31",
        now: NOW,
        selected: [
          conn(1, { attendance_from: "2026-01-01", attendance_to: "2026-10-31" } as never),
        ],
        records: [
          [1, "r1", "k1", true, day, 1790000000],
          [1, "r2", "k2", false, day, 1790000000],
        ],
        sales: [],
        payments: [],
      },
      trial_labels: [[1, "r1", "Пробное занятие"]],
      label_keys: [
        [1, "Пробное занятие"],
        [1, "Обычное"],
      ],
    } as unknown as FbMyCityData;
    const rows = fbMyCityTrialRows(data);
    expect(rows.map((r) => [r.label, r.registered, r.visited])).toEqual([
      ["Пробная услуга — название не загружено", 1, 0],
      ["Пробное занятие", 1, 1],
    ]);
  });
});

describe("«Мой город · FitBase» — доска (их правки шаблона)", () => {
  const totals = {
    revenue: null,
    sales: 5,
    new_sales: 3,
    repeat_sales: 2,
    new_payments: null,
    repeat_payments: 4000,
    sales_amount: null,
    classes: 2,
    booked: null,
    attended: 3,
    trials: 4,
    trial_attended: 2,
    bought_day: null,
    bought_14: 1,
    bought_later: null,
  };
  const payload = (extra: Partial<FbMyCityPayload> = {}): FbMyCityPayload => ({
    records: [
      [
        "2026-10",
        "Самара",
        "Б",
        100,
        2,
        null,
        null,
        null,
        null,
        null,
        1,
        2,
        1,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        "2026-10",
        "Самара",
        "А",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        "2026-09",
        "Самара",
        "Все студии",
        300,
        1,
        1,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    ],
    periods: ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"],
    cities: ["Самара"],
    previousRecords: [{ city: "Самара", studio: "Все студии", revenue: 200 }],
    breakEven: { Самара: 1000 },
    productRecords: [],
    directionRecords: [],
    studioIds: {},
    studioLabels: [],
    selectedStudio: "",
    selectedStudioId: "",
    selectedCity: "Самара",
    start: "2026-10-01",
    end: "2026-10-30",
    currentPeriod: "2026-10",
    generatedAt: "30.10.2026 20:51",
    fitbase: {
      totals,
      trialProducts: [],
      later_conversion: null,
      day_base: 4,
      day_mature: 1,
      attendance: 75,
      conversion: null,
      day_conversion: 25,
      trial_attendance: 50,
      notes: [],
      studioConversions: { Б: 12.345, А: null },
    },
    ...extra,
  });

  // Intl ru-RU разделяет разряды неразрывным пробелом — как у них в браузере.
  test("форматы: нет значения — «—»", () => {
    expect([fbCityFmt(null), fbCityFmt(1234.6), fbCityRub(undefined), fbCityRub(0)]).toEqual([
      "—",
      "1\u00a0235",
      "—",
      "0 ₽",
    ]);
    expect([fbCityPct(1, 0), fbCityPct(null, 2), fbCityPct(1, 3), fbCityPercent(12.345)]).toEqual([
      "—",
      "—",
      "33,3%",
      "12,3%",
    ]);
  });

  test("плитки — totals и проценты FitBase, без выручки — нет сравнения", () => {
    const s = fbMyCitySummary(payload());
    expect([s.revenue, s.revenueDelta, s.sales, s.attendance, s.conversion]).toEqual([
      "—",
      null,
      "5",
      "75,0%",
      "—",
    ]);
    expect(s.attendanceDetail).toBe("3 из — записавшихся");
    expect(s.dayConversionDetail).toBe("1 из 4 в подтверждённом окне");
    expect([s.newCheck, s.repeatCheck, s.bookedRate]).toEqual([
      "0 ₽",
      "2\u00a0000 ₽",
      "0,0 на занятие",
    ]);
    // Точка 0: выручки нет — «ниже» на всю цель (их арифметика JS).
    expect(s.breakEven).toEqual({
      kind: "set",
      value: "1\u00a0000 ₽",
      above: false,
      amount: "1\u00a0000 ₽",
    });
    expect(s.laterConversion).toBe("—");
  });

  test("сравнение с прошлым месяцем, столбики, студии от Я к А, тренд с пропусками", () => {
    const s = fbMyCitySummary(
      payload({ fitbase: { ...payload().fitbase, totals: { ...totals, revenue: 300 } } }),
    );
    expect(s.revenueDelta).toEqual({ up: true, text: "50,0%" });
    expect(s.revenueBars.map((b) => [b.period, b.height, b.text])).toEqual([
      ["2026-05", 2, "—"],
      ["2026-06", 2, "—"],
      ["2026-07", 2, "—"],
      ["2026-08", 2, "—"],
      ["2026-09", 100, "300 ₽"],
      ["2026-10", (100 / 300) * 100, "100 ₽"],
    ]);
    expect(s.studios.map((r) => [r.name, r.revenue, r.attendance, r.conversion])).toEqual([
      ["Б", "100 ₽", "50,0%", "12,3%"],
      ["А", "—", "—", "—"],
    ]);
    expect(s.trend.slice(-2)).toEqual([
      { key: "2026-09", newSales: 1, repeatSales: 0 },
      { key: "2026-10", newSales: null, repeatSales: null },
    ]);
    const studio = fbMyCitySummary(payload({ selectedStudio: "Б · Lady Stretch" }));
    expect(studio.breakEven.kind).toBe("studio");
    expect(fbMyCitySummary(payload({ breakEven: {} })).breakEven.value).toBe("Не задана");
  });
});
