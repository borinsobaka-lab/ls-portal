import { describe, expect, test } from "bun:test";

import {
  change,
  classesSummary,
  directionLines,
  filterStudios,
  forecast,
  formatChange,
  formatRate,
  formatRub,
  groupByCity,
  monthStarts,
  monthWeeks,
  nomenclature,
  pointZeroOf,
  rating,
  revenueTable,
  salesSummary,
  shiftPeriod,
  trialsSummary,
  zeroTree,
} from "./logic";
import type { AnStudio, RevenueRow, SalesData } from "./types";

const studio = (id: string, city: string | null, extra: Partial<AnStudio> = {}): AnStudio => ({
  id,
  name: id,
  city,
  partner: null,
  source: "1c",
  brandId: null,
  brandName: null,
  closedOn: null,
  needsReview: false,
  ...extra,
});

const TODAY = "2026-09-10";

describe("студии по городам", () => {
  test("сначала города с открытыми студиями по алфавиту, внутри — открытые, затем закрытые", () => {
    const groups = groupByCity(
      [
        studio("Ленина", "Барнаул"),
        studio("Старая", "Барнаул", { closedOn: "2026-01-01" }),
        studio("Есенина", "Белгород", { closedOn: "2026-01-01" }),
        studio("Мира", "Абакан"),
        studio("Без", null),
      ],
      TODAY,
    );
    expect(groups.map((g) => g.city)).toEqual(["Абакан", "Барнаул", "Без города", "Белгород"]);
    expect(groups[1].studios.map((s) => s.id)).toEqual(["Ленина", "Старая"]);
  });

  test("закрытие с будущей даты ещё не действует; фильтр статуса", () => {
    const list = [
      studio("a", "X", { closedOn: "2026-09-11" }),
      studio("b", "X", { closedOn: TODAY }),
    ];
    const f = { brandId: null, city: null, clubId: null };
    expect(filterStudios(list, { ...f, status: "open" }, TODAY).map((s) => s.id)).toEqual(["a"]);
    expect(filterStudios(list, { ...f, status: "closed" }, TODAY).map((s) => s.id)).toEqual(["b"]);
  });

  test("точка 0 — у целых городов: сумма городов, у части города — нет", () => {
    const all = [studio("a", "X"), studio("b", "X"), studio("c", "Y")];
    const targets = { X: 1000, Y: 500 };
    expect(pointZeroOf(all, all, targets)).toBe(1500);
    expect(pointZeroOf([all[0], all[1]], all, targets)).toBe(1000);
    expect(pointZeroOf([all[0]], all, targets)).toBeNull();
    expect(pointZeroOf([all[2]], all, {})).toBeNull();
  });
});

describe("периоды", () => {
  test("недели месяца — пн–вс, обрезаны месяцем (как август 2026 у Lady Stretch)", () => {
    expect(monthWeeks("2026-08-01").map((w) => w.label)).toEqual([
      "1–2",
      "3–9",
      "10–16",
      "17–23",
      "24–30",
      "31–31",
    ]);
  });

  test("сдвиг периода: конец месяца остаётся концом, день ограничен длиной месяца", () => {
    expect(shiftPeriod({ from: "2026-09-01", to: "2026-09-30" }, -1)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(shiftPeriod({ from: "2026-03-01", to: "2026-03-30" }, -1)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(shiftPeriod({ from: "2026-09-01", to: "2026-09-17" }, -12)).toEqual({
      from: "2025-09-01",
      to: "2025-09-17",
    });
    expect(monthStarts("2026-09-17", 3)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
  });

  test("прогноз: по прошедшим полным дням, 1-го числа и не в текущем месяце — нет", () => {
    expect(forecast(900, "2026-09-01", "2026-09-10")).toBe(3000);
    expect(forecast(0, "2026-09-01", "2026-09-01")).toBeNull();
    expect(forecast(900, "2026-08-01", "2026-09-10")).toBeNull();
  });

  test("изменение и формат", () => {
    expect(change(150, 100)).toBe(50);
    expect(change(5, 0)).toBeNull();
    expect(formatChange(-4.6)).toBe("−5%");
    expect(formatRate(null)).toBe("—");
    expect(formatRate(48.25, 1)).toBe("48,3%");
    expect(formatRub(661113.4)).toBe("661 113 ₽");
  });
});

describe("выручка", () => {
  const row = (studioId: string, date: string, income: number, expense = 0): RevenueRow => ({
    studioId,
    date,
    income,
    expense,
  });

  test("недели, факт без сегодняшнего дня, прогноз города от суммы, точка 0, история", () => {
    const studios = [studio("a", "Барнаул"), studio("b", "Барнаул"), studio("c", "Смоленск")];
    const days = [
      row("a", "2026-09-02", 500),
      row("a", "2026-09-08", 400, 100),
      row("b", "2026-09-09", 300),
      row("a", "2026-09-10", 1000), // сегодня — не в счёт
    ];
    const months = [row("a", "2026-08-01", 5000), row("b", "2026-07-01", 700)];
    const t = revenueTable({
      studios,
      all: studios,
      targets: { Барнаул: 5000 },
      days,
      months,
      month: "2026-09-01",
      today: TODAY,
      history: 2,
    });
    expect(t.historyMonths).toEqual(["2026-08-01", "2026-07-01"]);
    const city = t.cities.find((c) => c.line.label === "Барнаул")!;
    expect(city.line.weeks).toEqual([500, 600, 0, 0, 0]);
    expect(city.line.fact).toBe(1100);
    expect(city.line.forecast).toBeCloseTo((1100 / 9) * 30, 6);
    expect(city.line.pointZero).toBe(5000);
    expect(city.line.pointZeroDiff).toBeCloseTo((1100 / 9) * 30 - 5000, 6);
    expect(city.studios[0].pointZero).toBeNull();
    expect(city.line.history).toEqual([5000, 700]);
    // У Смоленска точки 0 нет — у сети считается по тем, что есть.
    expect(t.total.pointZero).toBe(5000);
  });
});

const sales: SalesData = {
  sold: [
    {
      studioId: "a",
      date: "2026-09-01",
      nomenclatureId: "m1",
      origin: "new",
      count: 2,
      paid: 200,
      cost: 200,
    },
    {
      studioId: "a",
      date: "2026-09-02",
      nomenclatureId: "m1",
      origin: "renewal",
      count: 3,
      paid: 300,
      cost: 330,
    },
    {
      studioId: "a",
      date: "2026-09-02",
      nomenclatureId: "m2",
      origin: "return",
      count: 1,
      paid: 150,
      cost: 150,
    },
    {
      studioId: "a",
      date: "2026-09-03",
      nomenclatureId: "m2",
      origin: "unknown",
      count: 1,
      paid: 100,
      cost: 100,
    },
    {
      studioId: "b",
      date: "2026-09-03",
      nomenclatureId: "m1",
      origin: "new",
      count: 5,
      paid: 500,
      cost: 500,
    },
  ],
  names: { m1: "8 занятий", m2: "Безлимит" },
};

describe("продажи", () => {
  test("новые, повторные = продления + возвращённые, средний чек по оплатам", () => {
    const s = salesSummary(sales, new Set(["a"]));
    expect([s.sold, s.newSold, s.repeatSold, s.unknown]).toEqual([7, 2, 4, 1]);
    expect([s.paid, s.newPaid, s.repeatPaid, s.cost]).toEqual([750, 200, 450, 780]);
    expect(s.avgCheck).toBeCloseTo(750 / 7, 6);
    expect(s.avgRepeat).toBeCloseTo(450 / 4, 6);
  });

  test("что покупают: все / новые / продления", () => {
    const ids = new Set(["a", "b"]);
    expect(nomenclature(sales, ids, "all").map((l) => [l.name, l.count])).toEqual([
      ["8 занятий", 10],
      ["Безлимит", 2],
    ]);
    expect(nomenclature(sales, ids, "new").map((l) => l.count)).toEqual([7]);
    expect(nomenclature(sales, ids, "repeat").map((l) => l.count)).toEqual([3, 1]);
  });
});

describe("занятия и пробные", () => {
  test("средние и доходимость — взвешенно, из итоговых сумм", () => {
    const rows = [
      { studioId: "a", date: "d", direction: "Стретчинг", classes: 2, booked: 10, attended: 8 },
      { studioId: "a", date: "d", direction: "Пилатес", classes: 3, booked: 15, attended: 9 },
    ];
    const s = classesSummary(rows, new Set(["a"]));
    expect([s.classes, s.avgBooked, s.avgAttended, s.attendance]).toEqual([5, 5, 3.4, 68]);
    expect(directionLines(rows, new Set(["a"])).map((d) => d.name)).toEqual([
      "Пилатес",
      "Стретчинг",
    ]);
  });

  test("конверсии пробных — от пришедших; без пришедших — нет доли", () => {
    const t = trialsSummary(
      [
        {
          studioId: "a",
          date: "d",
          membership: "Пробное",
          trials: 10,
          attended: 8,
          day0: 4,
          d14: 6,
          open: 1,
        },
      ],
      new Set(["a"]),
    );
    expect([t.attendance, t.day0Rate, t.d14Rate]).toEqual([80, 50, 75]);
    expect(trialsSummary([], new Set(["a"])).d14Rate).toBeNull();
  });

  test("рейтинг: по городам, доли — у городов с пришедшими", () => {
    const r = rating({
      studios: [studio("a", "Барнаул"), studio("b", "Барнаул"), studio("c", "Смоленск")],
      trials: [
        {
          studioId: "a",
          date: "d",
          membership: "П",
          trials: 4,
          attended: 4,
          day0: 1,
          d14: 2,
          open: 0,
        },
        {
          studioId: "c",
          date: "d",
          membership: "П",
          trials: 2,
          attended: 2,
          day0: 2,
          d14: 2,
          open: 0,
        },
      ],
      sales,
      by: "city",
    });
    expect(r.day0.map((e) => [e.key, e.value])).toEqual([
      ["Смоленск", 100],
      ["Барнаул", 25],
    ]);
    expect(r.renewals).toEqual([{ key: "Барнаул", label: "Барнаул", value: 3 }]);
    expect(r.returns.map((e) => e.value)).toEqual([1]);
  });
});

test("нулевая номенклатура: город → студия → позиции, пустые не показываются", () => {
  const tree = zeroTree(
    [
      { studioId: "a", name: "Пакет", category: "subscription", count: 2, lastOn: "2026-09-01" },
      { studioId: "a", name: "Вода", category: "other", count: 5, lastOn: "2026-09-02" },
    ],
    [studio("a", "X"), studio("b", "Y")],
    TODAY,
  );
  expect(tree.map((c) => [c.city, c.count])).toEqual([["X", 7]]);
  expect(tree[0].studios[0].items.map((i) => i.name)).toEqual(["Вода", "Пакет"]);
});
