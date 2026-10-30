import { describe, expect, test } from "bun:test";

import {
  fbInteger,
  fbMarketingCities,
  fbPercent,
  fbRevenueMoney,
  fbRevenueNotes,
  fbRevenueReport,
  fbSalesAmountDelta,
  fbSalesAverage,
  fbSalesDelta,
  fbSalesMoney,
  fbSalesReport,
  fbWhole,
  type FbReportConnection,
} from "./reports";

// Ожидания — ответы своей транскрипции их revenue_report / sales_report /
// report и страниц app.py на тех же синтетических данных.

const conn = (id: number, patch: Partial<FbReportConnection> = {}): FbReportConnection => ({
  id,
  name: `Студия ${id}`,
  brand: "Lady Stretch",
  city: "Самара",
  domain: `d${id}`,
  club_id: "1",
  studio_status: "active",
  marketing_disabled: false,
  partner_name: "",
  synced_at: 1793000000,
  sales_payments_at: 1793000000,
  sales_state: "Продажи загружены",
  revenue_synced_at: 1793000000,
  revenue_from: "2026-04-01",
  revenue_to: "2026-10-29",
  revenue_state: "Выручка загружена",
  ...patch,
});

describe("FitBase: форматы их страниц", () => {
  test("Decimal ROUND_HALF_UP выручки и «-0»", () => {
    expect(fbRevenueMoney(150)).toBe("2");
    expect(fbRevenueMoney(149)).toBe("1");
    expect(fbRevenueMoney(-150)).toBe("-2");
    expect(fbRevenueMoney(-40)).toBe("-0");
    expect(fbRevenueMoney(123456789)).toBe("1 234 568");
    expect(fbRevenueMoney(null)).toBe("—");
  });
  test("f-строки Python: половина к чётному, знак, проценты", () => {
    expect(fbWhole(2.5)).toBe("2");
    expect(fbWhole(3.5)).toBe("4");
    expect(fbWhole(-0.01)).toBe("-0");
    expect(fbWhole(1234567.4)).toBe("1 234 567");
    expect(fbSalesMoney(-50000)).toBe("-500");
    expect(fbInteger(1234567)).toBe("1 234 567");
    expect(fbPercent(0.5, 1)).toBe("50.0%");
    expect(fbPercent(0, 0, true)).toBe("+0%");
    expect(fbPercent(-0.004, 0, true)).toBe("-0%");
  });
});

describe("FitBase: «Выручка по городам» (их revenue_report)", () => {
  const data = {
    connections: [
      conn(1),
      conn(2, { studio_status: "archived", name: "Арх" }),
      conn(3, { city: "Тольятти", revenue_synced_at: null }),
      // Тот же домен и клуб, что у 1-й, но загрузка старше — не учитывается.
      conn(4, { domain: "d1", revenue_synced_at: 1792000000 }),
    ],
    daily: [
      [1, "2026-10-01", 150],
      [1, "2026-10-05", 100000],
      [1, "2026-09-10", 50000],
      [2, "2026-10-02", -40],
      [2, "2026-10-29", 200000],
      [3, "2026-10-03", 777],
    ] as [number, string, number][],
  };
  const r = fbRevenueReport(data, { offset: 0, search: "", status: "", today: "2026-10-30" });
  test("период и выбор студий", () => {
    expect([r.period.first, r.period.cutoff, r.period.fromDate, r.period.elapsed]).toEqual([
      "2026-10-01",
      "2026-10-29",
      "2026-04-01",
      29,
    ]);
    expect(r.connections.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(r.ready).toBe(false);
  });
  test("итоги, прогноз, недели и неполные данные", () => {
    expect(r.total.current).toBe(300110);
    expect(fbRevenueMoney(r.total.current)).toBe("3 001");
    expect(fbRevenueMoney(r.total.forecast)).toBe("3 208");
    expect(r.total.weeks.map(fbRevenueMoney)).toEqual(["1", "1 000", "0", "0", "2 000"]);
    expect(r.total.coverage.current).toEqual({ known: 2, expected: 3 });
    expect(fbRevenueMoney(r.opened.current)).toBe("1 002");
    expect(fbRevenueMoney(r.closed.current)).toBe("2 000");
    expect(fbRevenueMoney(r.studios[2].weeks[0])).toBe("-0");
    expect(r.studios[3].current).toBeNull();
    expect(r.cities.map(([c]) => c)).toEqual(["Самара", "Тольятти"]);
  });
  test("подсказки в их порядке", () => {
    const notes = fbRevenueNotes(r, false);
    expect(notes[0].text).toStartWith("Учтено студий: 2 из 3.");
    expect(notes[0].text).toContain("Не учтены: Студия 3.");
    expect(notes[1].text).toStartWith("Выручка текущего месяца ещё не загружена полностью.");
    expect(notes[2].text).toStartWith("* Неполная сумма");
    expect(fbRevenueNotes(r, true)[0].text).toStartWith("Загрузка выполняется в фоне.");
  });
  test("их ошибки", () => {
    expect(() =>
      fbRevenueReport(data, { offset: 61, search: "", status: "", today: "2026-10-30" }),
    ).toThrow("Выберите историю не больше пяти лет.");
    expect(() =>
      fbRevenueReport(data, { offset: 0, search: "", status: "x", today: "2026-10-30" }),
    ).toThrow("Выберите статус студии.");
  });
});

describe("FitBase: «Продажи абонементов» (их sales_report)", () => {
  const data = {
    connections: [conn(1)],
    sales: [
      [1, "10", "c1", 1790000000, 500000, 0],
      [1, "11", "c1", 1791900000, 300000, 0],
      [1, "12", "c2", 1792000000, 400000, 0],
    ] as [number, string, string, number, number, number][],
    history: [
      [1, "9", "c1", 1780000000, 0],
      [1, "10", "c1", 1790000000, 500000],
      [1, "11", "c1", 1791900000, 300000],
      [1, "12", "c2", 1792000000, 400000],
    ] as [number, string, string, number, number][],
    payments: [
      [1, "purchase", "1", "10", "c1", 1790000100, "2026-09-21", 500000],
      [1, "purchase", "2", "11", "", 1791900100, "2026-10-14", 200000],
      [1, "refund", "3", "11", "c1", 1792100000, "2026-10-16", 50000],
      [1, "purchase", "4", "", "c3", 1792200000, "2026-10-17", 1000],
    ] as [number, string, string, string, string, number, string, number][],
  };
  const r = fbSalesReport(data, {
    start: "2026-10-01",
    end: "2026-10-30",
    brand: "",
    city: "",
    studio: "",
    search: "",
  });
  test("новые и повторные, оплаты, нераспределённое", () => {
    expect(r.ready).toBe(true);
    expect(r.total).toEqual({
      count: 2,
      new: 1,
      repeat: 1,
      new_paid: 0,
      repeat_paid: 150000,
      amount: 151000,
      new_amount: 0,
      repeat_amount: 150000,
      unassigned_paid: 1000,
      gross: 201000,
      refund: 50000,
      // Оплата без абонемента — их total['paid_count'] = None.
      paid_count: null,
      new_paid_count: 0,
      repeat_paid_count: 1,
    });
    expect(r.unclassified).toBe(1);
    expect(r.payment_rows.map((p) => [p.client_id, p.new, fbSalesMoney(p.paid_cents)])).toEqual([
      ["c1", false, "2 000"],
      ["c1", false, "-500"],
      ["c3", null, "10"],
    ]);
  });
  test("плитки, средние чеки, сравнения", () => {
    expect(fbSalesDelta(r.total.count, r.previous.count, true).text).toBe("↑ +100%");
    expect(fbSalesDelta(r.total.new, r.previous.new, true).text).toBe("→ +0%");
    expect(fbSalesDelta(r.total.repeat, r.previous.repeat, true).text).toBe("Нет базы сравнения");
    expect(fbSalesDelta(r.total.amount, r.previous.amount, true).text).toBe("↓ -70%");
    expect((["new", "repeat", "all"] as const).map((k) => fbSalesAverage(r.total, k))).toEqual([
      "—",
      "1 500",
      "—",
    ]);
    const [prior] = r.city_comparison.get("Самара")!;
    expect(fbSalesAmountDelta(r.total.amount, prior.amount, true).text).toBe("↓ -3 490 (-70%)");
  });
  test("студия без загрузки операций — суммы прочерком", () => {
    const partial = fbSalesReport(
      { ...data, connections: [conn(1), conn(2, { city: "Тольятти", sales_payments_at: null })] },
      { start: "2026-10-01", end: "2026-10-30", brand: "", city: "", studio: "", search: "" },
    );
    expect([partial.ready, partial.pending, partial.total.amount]).toEqual([false, 1, null]);
    expect(fbSalesDelta(partial.total.count, partial.previous.count, false).text).toBe("—");
  });
  test("период — не больше 366 дней", () => {
    expect(() =>
      fbSalesReport(data, {
        start: "2025-10-01",
        end: "2026-10-02",
        brand: "",
        city: "",
        studio: "",
        search: "",
      }),
    ).toThrow("Выберите период не больше 366 дней.");
  });
});

describe("FitBase: «Маркетинговый отчёт» (их report)", () => {
  const data = {
    brand: "Lady Stretch",
    from: "2026-10-01",
    to: "2026-10-30",
    connections: [
      {
        id: 1,
        name: "С1",
        brand: "Lady Stretch",
        city: "Самара",
        domain: "a",
        club_id: "1",
        partner_name: " Иванов ",
        synced_at: 1793000000,
        step_rules: { "1": "new", "2": "booked", "3": "paid", "4": "ignore" },
        source_rules: { "11": "community_messages", "12": "none" },
        sources: [
          { id: 11, name: "VK" },
          { id: 12, name: "Сайт" },
        ],
      },
    ],
    leads: [
      [1, "L1", "client:1", 1790900000, "1", "11"],
      [1, "L2", "client:1", 1790900100, "3", "12"],
      [1, "L3", "client:2", 1790900200, "2", "11"],
      [1, "L4", "client:3", 1790900300, "4", "11"],
      [1, "L5", "client:4", 1790900400, "9", ""],
    ] as [number, string, string, number, string, string][],
    budgets: [["Самара", 10000, 2500.5]] as [string, number, number][],
  };
  test("каналы, бюджет VK с НДС, конверсии, дубли", () => {
    const [c] = fbMarketingCities(data, "");
    expect(c.partners).toBe("Иванов");
    expect(
      c.channels.map((x) => [x.source, x.budget, x.leads, x.lead_price, x.lead_booked]),
    ).toEqual([
      ["Вконтакте Сообщения", "9 149 ₽", "2", "4 575 ₽", "50%"],
      ["Без источника", "—", "1", "—", "0%"],
      ["Сайт", "—", "1", "—", "100%"],
    ]);
    expect(c.total).toEqual({
      source: "Итого по городу",
      budget: "9 149 ₽",
      leads: "4",
      lead_price: "2 287 ₽",
      booked: "2",
      lead_booked: "50%",
      attended: "1",
      booked_attended: "50%",
      paid: "1",
      attended_paid: "100%",
      lead_paid: "25%",
      sale_price: "9 149 ₽",
    });
    expect(c.duplicates).toEqual([{ names: "ВКонтакте Сообщения / Сайт", count: 1 }]);
  });
});
