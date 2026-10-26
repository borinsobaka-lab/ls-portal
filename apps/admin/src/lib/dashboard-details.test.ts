import { describe, expect, test } from "bun:test";

import type { SaleRecord } from "./dashboard-analytics";
import { classesSeries, type ClassEntry } from "./dashboard-classes";
import {
  boughtSince,
  countText,
  detailRows,
  dueBadge,
  groupRows,
  type DetailRow,
} from "./dashboard-details";
import { marketingSeries, npsPoints } from "./dashboard-marketing";
import { formatNumber } from "./format";

const row = (p: Partial<DetailRow> & { key: string; date: string }): DetailRow => ({ ...p });

function sale(p: Partial<SaleRecord> & { id: string; clientId: string; soldAt: string }) {
  return {
    createdAt: `${p.soldAt}T10:00:00Z`,
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
  } satisfies SaleRecord;
}

const OCT = { from: "2026-10-01", to: "2026-10-31" };

describe("detailRows", () => {
  const rows = [
    row({ key: "a", date: "2026-09-30", value: 5 }),
    row({ key: "b", date: "2026-10-01", value: 1 }),
    row({ key: "c", date: "2026-10-15", value: 9, attention: true }),
    row({ key: "d", date: "2026-10-31", value: 3 }),
    row({ key: "e", date: "2026-11-01", value: 7 }),
  ];

  test("только строки периода, границы включительно", () => {
    const keys = detailRows(rows, { sort: "date" }, OCT).map((r) => r.key);
    expect(keys).toEqual(["c", "b", "d"]);
  });

  test("требующие внимания — первыми при любом порядке", () => {
    const by = (sort: "date" | "dateDesc" | "value" | "valueAsc") =>
      detailRows(rows, { sort }, OCT).map((r) => r.key);
    expect(by("dateDesc")).toEqual(["c", "d", "b"]);
    expect(by("value")).toEqual(["c", "d", "b"]);
    expect(by("valueAsc")).toEqual(["c", "b", "d"]);
  });

  test("без периода — все строки (список «сейчас»-плитки)", () => {
    expect(detailRows(rows, { sort: "value" })).toHaveLength(rows.length);
  });
});

describe("groupRows", () => {
  test("строки клиента — одной: сумма, последняя дата, внимание у любой", () => {
    const grouped = groupRows([
      row({ key: "1", date: "2026-10-02", clientId: "x", value: 1 }),
      row({ key: "2", date: "2026-10-09", clientId: "x", value: 1, attention: true }),
      row({ key: "3", date: "2026-10-05", userId: "u", value: 1 }),
      row({ key: "4", date: "2026-10-06", name: "Без карточки" }),
      row({ key: "5", date: "2026-10-07", name: "Без карточки" }),
    ]);
    expect(grouped.map((r) => [r.key, r.date, r.value, !!r.attention])).toEqual([
      ["c:x", "2026-10-09", 2, true],
      ["u:u", "2026-10-05", 1, false],
      ["n:Без карточки", "2026-10-07", 2, false],
    ]);
  });
});

describe("dueBadge", () => {
  const past = (d: number) => `Просрочен ${d} дн.`;
  test("прошёл, сегодня, скоро и позже", () => {
    expect(dueBadge("2026-10-15", "2026-10-18", past)).toEqual({
      text: "Просрочен 3 дн.",
      tone: "bad",
      overdue: true,
    });
    expect(dueBadge("2026-10-18", "2026-10-18", past).tone).toBe("warn");
    expect(dueBadge("2026-10-20", "2026-10-18", past)).toEqual({
      text: "Через 2 дн.",
      tone: "warn",
      overdue: false,
    });
    expect(dueBadge("2026-11-20", "2026-10-18", past).tone).toBe("muted");
  });
});

test("countText склоняет единицу", () => {
  const unit: [string, string, string] = ["клиент", "клиента", "клиентов"];
  expect(countText(1, unit)).toBe("1 клиент");
  expect(countText(3, unit)).toBe("3 клиента");
  expect(countText(11, unit)).toBe("11 клиентов");
  expect(countText(1500, unit)).toBe(`${formatNumber(1500)} клиентов`);
});

describe("boughtSince", () => {
  const sales = [
    sale({ id: "t", clientId: "a", soldAt: "2026-10-01", trial: true }),
    sale({ id: "p", clientId: "a", soldAt: "2026-10-05" }),
    sale({ id: "t2", clientId: "b", soldAt: "2026-10-01", trial: true }),
    sale({ id: "c", clientId: "b", soldAt: "2026-10-03", cancelled: true }),
    sale({ id: "s", clientId: "b", soldAt: "2026-10-04", single: true }),
  ];
  test("абонемент после пробного — купил; отменённый и разовое — нет", () => {
    expect(boughtSince(sales, "a", "2026-10-01")).toBe(true);
    expect(boughtSince(sales, "a", "2026-10-06")).toBe(false);
    expect(boughtSince(sales, "b", "2026-10-01")).toBe(false);
  });
});

describe("строки отчёта у точек графика", () => {
  test("пробные: кто не купил — с вниманием, сумма графика та же", () => {
    const sales = [
      sale({ id: "t1", clientId: "a", soldAt: "2026-10-01", trial: true }),
      sale({ id: "p1", clientId: "a", soldAt: "2026-10-03" }),
      sale({ id: "t2", clientId: "b", soldAt: "2026-10-02", trial: true }),
    ];
    const points = marketingSeries({ sales, clients: [] }).trialConversion!;
    expect(points.map((p) => [p.row?.clientId, p.amount, !!p.row?.attention])).toEqual([
      ["a", 100, false],
      ["b", 0, true],
    ]);
  });

  test("скидки: строки только у продаж со скидкой", () => {
    const sales = [
      sale({ id: "d", clientId: "a", soldAt: "2026-10-01", discount: 20, promoCode: "FIT" }),
      sale({ id: "n", clientId: "b", soldAt: "2026-10-02" }),
    ];
    const points = marketingSeries({ sales, clients: [] }).discounts!;
    expect(points.map((p) => p.row?.value)).toEqual([20, undefined]);
  });

  test("NPS: критик — с вниманием", () => {
    const points = npsPoints([
      { date: "2026-10-01", score: 10, clientId: "a" },
      { date: "2026-10-02", score: 3, clientId: "b", comment: "Шумно" },
    ]);
    expect(points.map((p) => [p.row?.badge?.text, !!p.row?.attention, p.row?.note])).toEqual([
      ["Промоутер", false, undefined],
      ["Критик", true, "Шумно"],
    ]);
  });

  test("«Не пришли»: по строке на пропуск, те же штуки, что без строк", () => {
    const e: ClassEntry = {
      id: "e1",
      studioId: "s",
      kind: "group",
      startsAt: Date.parse("2026-10-10T10:00:00Z"),
      date: "2026-10-10",
      weekday: 5,
      time: "14:00",
      cancelled: false,
      workoutId: "w",
      workoutName: "Растяжка",
      workoutColor: null,
      capacity: 10,
      trainers: [{ id: "t", name: "Иванова" }],
      bookings: [
        { status: "no_show", client: "c1", clientId: "c1", userId: null },
        { status: "no_show", client: "u2", clientId: null, userId: "u2" },
        { status: "attended", client: "c3", clientId: "c3", userId: null },
      ],
    };
    const now = Date.parse("2026-10-18T00:00:00Z");
    const plain = classesSeries([e], now, "noShows");
    const withRows = classesSeries([e], now, "noShows", true);
    const n = (points: { n: number }[]) => points.reduce((s, p) => s + p.n, 0);
    expect(n(withRows)).toBe(n(plain));
    expect(withRows.map((p) => [p.row?.clientId, p.row?.userId, p.row?.note])).toEqual([
      ["c1", null, "Сб 14:00 · Иванова"],
      [null, "u2", "Сб 14:00 · Иванова"],
    ]);
  });
});
