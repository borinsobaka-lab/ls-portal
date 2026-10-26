import { describe, expect, test } from "bun:test";

import type { SaleRecord } from "./dashboard-analytics";
import {
  NO_ANSWER,
  cohortByAnswer,
  firstPurchases,
  marketingMetrics,
  marketingSeries,
  newClients,
  newClientsFunnel,
  npsScore,
  promoCodes,
  trialOutcomes,
  type MarketingClient,
} from "./dashboard-marketing";

let seq = 0;
function sale(p: Partial<SaleRecord> & { clientId: string; soldAt: string }): SaleRecord {
  seq++;
  return {
    id: p.id ?? `s${seq}`,
    createdAt: `${p.soldAt}T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    totalAmount: 100,
    membershipName: "Пакет 8",
    trial: false,
    single: false,
    personal: false,
    method: "cash",
    source: "admin",
    promoCode: null,
    discount: 0,
    sellerKey: null,
    sellerName: null,
    endsAt: null,
    cancelled: false,
    noMembership: false,
    installments: [],
    ...p,
  };
}

const client = (id: string, registrationDate: string | null, userId: string | null = null) =>
  ({ id, registrationDate, userId }) satisfies MarketingClient;

const FROM = "2026-10-01";
const TO = "2026-10-31";

describe("firstPurchases", () => {
  test("первая покупка — не пробное и не удалённая", () => {
    const sales = [
      sale({ clientId: "a", soldAt: "2026-09-01", trial: true }),
      sale({ clientId: "a", soldAt: "2026-09-05", noMembership: true }),
      sale({ id: "first", clientId: "a", soldAt: "2026-09-10" }),
      sale({ clientId: "a", soldAt: "2026-10-10" }),
    ];
    expect(firstPurchases(sales).get("a")?.id).toBe("first");
  });
});

describe("trialOutcomes", () => {
  test("пробное в периоде и покупка после него; возврат пробного не в счёт", () => {
    const sales = [
      sale({ clientId: "a", soldAt: "2026-10-02", trial: true }),
      sale({ clientId: "a", soldAt: "2026-10-03" }),
      sale({ clientId: "b", soldAt: "2026-10-05", trial: true }),
      sale({ clientId: "c", soldAt: "2026-10-06", trial: true, cancelled: true }),
      // Абонемент до пробного — не конверсия пробного.
      sale({ clientId: "d", soldAt: "2026-09-01" }),
      sale({ clientId: "d", soldAt: "2026-10-07", trial: true }),
    ];
    const out = trialOutcomes(sales, FROM, TO);
    expect(out.map((t) => [t.trial.clientId, t.converted])).toEqual([
      ["a", true],
      ["b", false],
      ["d", false],
    ]);
  });
});

describe("npsScore", () => {
  test("промоутеры минус критики", () => {
    expect(npsScore([10, 9, 8, 5])).toBe(25);
    expect(npsScore([])).toBeUndefined();
  });
});

describe("marketingMetrics", () => {
  test("новые клиенты, покупатели, конверсии, канал и скидки", () => {
    const clients = [
      client("a", "2026-10-01", "u-a"),
      client("b", "2026-10-10"),
      client("c", "2026-09-01", "u-c"),
      client("d", null),
    ];
    const sales = [
      sale({ clientId: "a", soldAt: "2026-10-05", totalAmount: 300, discount: 20 }),
      sale({ clientId: "c", soldAt: "2026-09-02", source: "mobile" }),
      sale({ clientId: "c", soldAt: "2026-10-02", source: "mobile", promoCode: " fit10 " }),
      sale({ clientId: "b", soldAt: "2026-10-11", trial: true }),
    ];
    const m = marketingMetrics(
      { sales, clients, memberIds: new Set(["a", "c"]), nps: [{ date: "2026-10-03", score: 10 }] },
      FROM,
      TO,
    );
    expect(m.newClients).toBe(2);
    expect(m.newBuyers).toBe(1);
    expect(m.firstRevenue).toBe(300);
    expect(m.daysToPurchase).toBe(4);
    expect(m.purchaseConversion).toBe(50);
    expect(m.trialConversion).toBe(0);
    // Три продажи периода, одна — в приложении.
    expect(m.appSales).toBeCloseTo(100 / 3);
    expect(m.appMembers).toBe(100);
    expect(m.discounts).toBe(20);
    expect(m.nps).toBe(100);
    expect(promoCodes(sales, FROM, TO)).toEqual([{ key: "FIT10", value: 100, n: 1 }]);
  });
});

describe("общая база клиентов пакетных клубов", () => {
  test("член клуба с карточкой другого клуба — не новый клиент, но член клуба и покупатель", () => {
    const clients: MarketingClient[] = [
      client("own", "2026-10-02"),
      { ...client("guest", "2026-10-03", "u-g"), ownClub: false },
    ];
    const sales = [
      sale({ clientId: "own", soldAt: "2026-10-04" }),
      sale({ clientId: "guest", soldAt: "2026-10-06" }),
    ];
    expect(newClients(clients, FROM, TO).map((c) => c.id)).toEqual(["own"]);
    const m = marketingMetrics(
      { sales, clients, memberIds: new Set(["own", "guest"]), nps: [] },
      FROM,
      TO,
    );
    expect(m.newClients).toBe(1);
    expect(m.purchaseConversion).toBe(100);
    expect(m.newBuyers).toBe(2);
    // Дней до покупки — и у купившего здесь клиента с карточкой другого клуба.
    expect(m.daysToPurchase).toBe(2.5);
    expect(m.appMembers).toBe(50);
    const series = marketingSeries({ sales, clients });
    expect(series.purchaseConversion?.map((p) => p.date)).toEqual(["2026-10-02"]);
  });
});

describe("новые клиенты периода", () => {
  const cohort = [
    client("a", "2026-10-01", "u-a"),
    client("b", "2026-10-02"),
    client("c", "2026-10-03", "u-c"),
  ];
  const sales = [
    sale({ clientId: "a", soldAt: "2026-10-02", trial: true }),
    sale({ clientId: "a", soldAt: "2026-10-05", totalAmount: 250 }),
    sale({ clientId: "a", soldAt: "2026-10-20", totalAmount: 50 }),
    // Разовое — не абонемент: в покупки и выручку источника не идёт.
    sale({ clientId: "c", soldAt: "2026-10-04", totalAmount: 40, single: true }),
  ];

  test("путь: каждый шаг — от всех новых клиентов", () => {
    const steps = newClientsFunnel(cohort, sales, new Set(["a", "b"]), true);
    expect(steps.map((s) => [s.key, s.value])).toEqual([
      ["new", 3],
      ["app", 2],
      ["trial", 1],
      ["single", 1],
      ["visit", 2],
      ["purchase", 1],
    ]);
    const keys = newClientsFunnel(cohort, sales, new Set(), false).map((s) => s.key);
    expect(keys).not.toContain("trial");
    expect(keys).not.toContain("single");
  });

  test("по ответу анкеты; без ответа — последней строкой", () => {
    const profiles = new Map([
      ["u-a", { referralSource: "instagram", goal: "flexibility" }],
      ["u-c", { referralSource: null, goal: null }],
    ]);
    expect(cohortByAnswer(cohort, profiles, sales, (p) => p.referralSource)).toEqual([
      { key: "instagram", clients: 1, buyers: 1, revenue: 300, conversion: 100 },
      { key: NO_ANSWER, clients: 2, buyers: 0, revenue: 0, conversion: 0 },
    ]);
  });
});
