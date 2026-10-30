import { describe, expect, test } from "bun:test";

import {
  DIRECTION_SORT,
  directionRows,
  directionValue,
  dotDate,
  filtersPending,
  fmt,
  boardCity,
  nextDirectionSort,
  partnerRows,
  partnerSummary,
  pct,
  perClass,
  productRows,
  rub,
  salesTrend,
  studioChoices,
  studioRows,
  sumTotals,
  trendLabel,
  trendLabelPosition,
  trialProductRows,
} from "./mycity";
import type { PartnerPayload } from "./payload";

const NB = " "; // разделитель разрядов Intl ru-RU

/**
 * Строка records: период, город, студия, затем выручка, продажи, новые,
 * продления, оплаты новых, оплаты продлений, сумма продаж, занятия,
 * записано, посетило, пробные, пришли, купили в день, за 14 дней, позже.
 */
const rec = (
  period: string,
  city: string,
  studio: string,
  v: Partial<Record<string, number>> = {},
): (string | number)[] => [
  period,
  city,
  studio,
  v.revenue ?? 0,
  v.sales ?? 0,
  v.new_sales ?? 0,
  v.repeat_sales ?? 0,
  v.new_payments ?? 0,
  v.repeat_payments ?? 0,
  v.sales_amount ?? 0,
  v.classes ?? 0,
  v.booked ?? 0,
  v.attended ?? 0,
  v.trials ?? 0,
  v.trial_attended ?? 0,
  v.bought_day ?? 0,
  v.bought_14 ?? 0,
  v.bought_later ?? 0,
];

const PERIODS = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"];

function payload(p: Partial<PartnerPayload> = {}): PartnerPayload {
  return {
    generatedAt: "28.10.2026 09:57",
    sourceFile: "Сводные 1С · база портала",
    start: "2026-10-01",
    end: "2026-10-27",
    currentPeriod: "2026-10",
    minDate: "2018-10-31",
    maxDate: "2026-10-28",
    studioOptions: { Абакан: ["Абакан"], Бийск: ["Бийск 1", "Бийск 2"] },
    selectedStudio: "",
    selectedCity: "",
    periods: PERIODS,
    cities: ["Абакан", "Бийск"],
    records: [
      rec("2026-05", "Абакан", "Абакан", { revenue: 100000, new_sales: 8, repeat_sales: 1 }),
      rec("2026-06", "Абакан", "Абакан", { revenue: 300000, new_sales: 21, repeat_sales: 4 }),
      rec("2026-09", "Абакан", "Абакан", { revenue: 418000, new_sales: 20, repeat_sales: 3 }),
      rec("2026-10", "Абакан", "Абакан", {
        revenue: 357308,
        sales: 20,
        new_sales: 17,
        repeat_sales: 3,
        new_payments: 256708,
        repeat_payments: 55875,
        classes: 115,
        booked: 455,
        attended: 414,
        trials: 27,
        trial_attended: 25,
        bought_day: 6,
        bought_14: 9,
        bought_later: 3,
      }),
      rec("2026-10", "Бийск", "Бийск 1", { revenue: 1000, sales: 1, booked: 3, attended: 2 }),
      rec("2026-10", "Бийск", "Бийск 2", { revenue: 2000, sales: 2, booked: 0 }),
    ],
    previousRecords: [
      { city: "Абакан", studio: "Абакан", revenue: 418000, sales: 23 },
      { city: "Бийск", studio: "Бийск 1", revenue: 0 },
    ],
    productRecords: [
      ["2026-09", "Абакан", "КОМБО 12", 5, 50000, 5, 50000, 0, 0],
      ["2026-10", "Абакан", "ЗДОРОВАЯ СПИНА 48", 7, 114450, 6, 98000, 1, 16450],
      ["2026-10", "Абакан", "КОМБО 12", 2, 17000, 0, 0, 2, 17000],
      ["2026-10", "Абакан", "КОМБО 24", 2, 27000, 2, 27000, 0, 0],
      ["2026-10", "Абакан", "Возврат", 0, -5000, 0, 0, 0, 0],
      ["2026-10", "Бийск", "КОМБО 12", 1, 8500, 1, 8500, 0, 0],
    ],
    trialProductRecords: [
      ["2026-10", "Абакан", "Подарочная тренировка", 4, 4, 0, 0],
      ["2026-10", "Абакан", "Пробное занятие", 17, 17, 6, 8],
      ["2026-10", "Абакан", "Сертификат", 6, 4, 0, 1],
      ["2026-10", "Абакан", "Пустое", 0, 0, 0, 0],
    ],
    directionRecords: [
      ["2026-10", "Абакан", "Барре", 6, 18, 17],
      ["2026-10", "Абакан", "Здоровая спина", 26, 96, 81],
      ["2026-10", "Абакан", "Йога", 5, 0, 0],
      ["2026-10", "Абакан", "Пилатес", 7, 50, 44],
      ["2026-09", "Абакан", "Пилатес", 9, 60, 50],
    ],
    breakEven: { Абакан: 700000 },
    ...p,
  };
}

describe("форматирование — их fmt / rub / pct", () => {
  test("числа: Intl ru-RU без дробной части, пусто и NaN — 0", () => {
    expect(fmt(357308)).toBe(`357${NB}308`);
    expect(fmt(15100.5)).toBe(`15${NB}101`);
    expect(fmt(-1234.5)).toBe(`-1${NB}235`);
    expect(fmt(undefined)).toBe("0");
    expect(fmt(Number.NaN)).toBe("0");
    expect(rub(18625)).toBe(`18${NB}625 ₽`);
  });

  test("проценты: один знак после запятой, деление на ноль — «—»", () => {
    expect(pct(414, 455)).toBe("91,0%");
    expect(pct(1, 3)).toBe("33,3%");
    expect(pct(5, 0)).toBe("—");
    expect(pct(0, 4)).toBe("0,0%");
    expect(perClass(455, 115)).toBe("4,0 на занятие");
    expect(perClass(414, 115)).toBe("3,6 на занятие");
    expect(perClass(3, 0)).toBe("—");
    expect(dotDate("2026-10-01")).toBe("01.10.2026");
  });
});

describe("город и студия", () => {
  test("город — из адреса, если он в списке, иначе первый; при студии — город базы", () => {
    expect(boardCity(payload(), "Бийск")).toBe("Бийск");
    expect(boardCity(payload(), "Нет такого")).toBe("Абакан");
    expect(boardCity(payload(), undefined)).toBe("Абакан");
    expect(boardCity(payload({ cities: [] }), "Бийск")).toBe("");
    const withStudio = payload({ selectedCity: "Бийск", selectedStudio: "Бийск 1" });
    expect(boardCity(withStudio, "Абакан")).toBe("Бийск");
  });

  test("студии города — «Все студии» первой", () => {
    expect(studioChoices(payload(), "Бийск")).toEqual(["", "Бийск 1", "Бийск 2"]);
    expect(studioChoices(payload(), "Омск")).toEqual([""]);
  });

  test("ожидание данных: город без студии данные не меняет", () => {
    const p = payload();
    expect(filtersPending({ city: "Бийск" }, p)).toBe(false);
    expect(filtersPending({ city: "Бийск", studio: "Бийск 1" }, p)).toBe(true);
    const withStudio = payload({ selectedCity: "Бийск", selectedStudio: "Бийск 1" });
    expect(filtersPending({ city: "Бийск", studio: "Бийск 1" }, withStudio)).toBe(false);
  });
});

test("прежние данные на экране, пока адрес просит другую студию, город или период", () => {
  const p = payload({ selectedCity: "Бийск", selectedStudio: "Бийск 1" });
  expect(filtersPending({ city: "Бийск", studio: "Бийск 1" }, p)).toBe(false);
  expect(
    filtersPending({ city: "Бийск", studio: "Бийск 1", start: "2026-10-01", end: "2026-10-27" }, p),
  ).toBe(false);
  expect(filtersPending({ city: "Бийск", studio: "Бийск 2" }, p)).toBe(true);
  expect(filtersPending({ city: "Абакан" }, p)).toBe(true);
  expect(filtersPending({ city: "Бийск", studio: "Бийск 1", start: "2026-09-01" }, p)).toBe(true);
  expect(filtersPending({}, payload())).toBe(false);
});

describe("сводка города — их render()", () => {
  test("плитки и подписи", () => {
    const s = partnerSummary(payload(), "Абакан");
    expect(s.title).toBe("Мой город — Абакан");
    expect(s.subtitle).toBe("Главные показатели сети студий · 01.10.2026 — 27.10.2026");
    expect(s.revenue).toBe(`357${NB}308 ₽`);
    // (418 000 − 357 308) / 418 000 = 14,5 %, вниз.
    expect(s.revenueDelta).toEqual({ up: false, text: "14,5%" });
    expect(s.sales).toBe("20");
    expect(s.newSalesDetail).toBe("из них 17 новых клиентов");
    expect(s.attendance).toBe("91,0%");
    expect(s.attendanceDetail).toBe("414 из 455 записавшихся");
    expect(s.conversion).toBe("36,0%");
    expect(s.conversionDetail).toBe("9 покупок за 14 дней");
  });

  test("продажи, чеки, занятия, воронка", () => {
    const s = partnerSummary(payload(), "Абакан");
    expect(s.newSales).toBe("17");
    expect(s.newPayments).toBe(`Оплаты: 256${NB}708 ₽`);
    expect(s.repeatSales).toBe("3");
    expect(s.repeatPayments).toBe(`Оплаты: 55${NB}875 ₽`);
    expect(s.newCheck).toBe(`15${NB}100 ₽`); // 256 708 / 17 = 15 100,47
    expect(s.repeatCheck).toBe(`18${NB}625 ₽`);
    expect(s.classes).toBe("115");
    expect(s.bookedRate).toBe("4,0 на занятие");
    expect(s.attendedRate).toBe("3,6 на занятие");
    expect(s.funnel.map((f) => [f.label, f.value])).toEqual([
      ["Записались", "27"],
      ["Пришли", "25"],
      ["Купили в день", "6"],
      ["Купили за 14 дней", "9"],
    ]);
    expect(s.funnel[0].width).toBe(100);
    expect(s.funnel[2].width).toBeCloseTo((6 / 27) * 100);
    expect(s.trialAttendance).toBe("92,6%");
    expect(s.trialAttendanceDetail).toBe("25 из 27 записавшихся");
    expect(s.dayConversion).toBe("24,0%");
    expect(s.dayConversionDetail).toBe("6 из 25 пришедших");
    expect(s.laterConversion).toBe("+12,0%");
  });

  test("без продаж и пробных — «—»; прошлый месяц без выручки — «—», рост", () => {
    const s = partnerSummary(payload(), "Бийск");
    expect(s.newCheck).toBe("—");
    expect(s.repeatCheck).toBe("—");
    expect(s.conversion).toBe("—");
    expect(s.laterConversion).toBe("—");
    expect(s.bookedRate).toBe("—");
    expect(s.funnel.every((f) => f.width === 0)).toBe(true);
    expect(s.revenueDelta).toEqual({ up: true, text: "—" });
    // Город без записей вовсе — нули.
    const empty = partnerSummary(payload(), "Омск");
    expect(empty.revenue).toBe("0 ₽");
    expect(empty.attendance).toBe("—");
    expect(empty.revenueDelta).toEqual({ up: true, text: "—" });
  });

  test("один месяц в истории — «Нет периода для сравнения»", () => {
    const s = partnerSummary(payload({ periods: ["2026-10"] }), "Абакан");
    expect(s.revenueDelta).toBeNull();
    expect(s.revenueBars).toHaveLength(1);
  });

  test("выручка по месяцам: шесть месяцев от старого к новому, доля от максимума, не меньше 2 %", () => {
    const bars = partnerSummary(
      payload({
        records: [...payload().records, rec("2026-07", "Абакан", "Абакан", { revenue: -50000 })],
      }),
      "Абакан",
    ).revenueBars;
    expect(bars.map((b) => b.tick)).toEqual(["05", "06", "07", "08", "09", "10"]);
    expect(bars.map((b) => b.label)).toEqual([
      "Май 2026",
      "Июнь 2026",
      "Июль 2026",
      "Август 2026",
      "Сентябрь 2026",
      "Октябрь 2026",
    ]);
    expect(bars[4].height).toBe(100);
    expect(bars[0].height).toBeCloseTo((100000 / 418000) * 100);
    expect(bars[2].height).toBe(2); // отрицательная выручка
    expect(bars[3].height).toBe(2); // нет данных
    expect(bars[5].current).toBe(true);
    expect(bars.filter((b) => b.current)).toHaveLength(1);
    // Нет выручки вовсе — максимум 1, все столбики по 2 %.
    expect(
      partnerSummary(payload(), "Омск").revenueBars.every((b) => b.height === 2 && b.value === 0),
    ).toBe(true);
  });

  test("точка 0: выше / ниже, не задана, при студии — для всего города", () => {
    expect(partnerSummary(payload(), "Абакан").breakEven).toEqual({
      kind: "set",
      value: `700${NB}000 ₽`,
      above: false,
      amount: `342${NB}692 ₽`,
    });
    expect(
      partnerSummary(payload({ breakEven: { Абакан: 300000 } }), "Абакан").breakEven,
    ).toMatchObject({ above: true, amount: `57${NB}308 ₽` });
    expect(
      partnerSummary(payload({ breakEven: { Абакан: 357308 } }), "Абакан").breakEven,
    ).toMatchObject({ above: true, amount: "0 ₽" });
    expect(partnerSummary(payload({ breakEven: { Абакан: 0 } }), "Абакан").breakEven).toEqual({
      kind: "missing",
      value: "Не задана",
      detail: "Для города нет числового значения в справочнике",
    });
    const studio = partnerSummary(
      payload({ selectedCity: "Абакан", selectedStudio: "Абакан", breakEven: {} }),
      "Абакан",
    );
    expect(studio.breakEven).toEqual({
      kind: "studio",
      value: "Для всего города",
      detail: "Цель студии отдельно не задана. Для сравнения с точкой 0 выберите все студии.",
    });
    expect(studio.subtitle).toBe(
      "Главные показатели сети студий · 01.10.2026 — 27.10.2026 · Абакан",
    );
  });

  test("месяц доски — первый из periods, сравнение — previousRecords города", () => {
    const rows = partnerRows(payload());
    expect(rows[0]).toMatchObject({ period: "2026-05", city: "Абакан", revenue: 100000 });
    expect(sumTotals(rows.filter((r) => r.city === "Бийск")).revenue).toBe(3000);
    // previousRecords — объекты с частью полей: недостающие дают NaN, как у них.
    expect(sumTotals(payload().previousRecords).revenue).toBe(418000);
  });
});

describe("динамика продаж — их renderSalesTrend", () => {
  test("шесть месяцев, подписи «Май 26», шкала — чётная, не меньше 2", () => {
    const t = salesTrend(payload(), "Абакан");
    expect(t.points.map((p) => p.label)).toEqual([
      "Май 26",
      "Июн 26",
      "Июл 26",
      "Авг 26",
      "Сен 26",
      "Окт 26",
    ]);
    expect(t.points.map((p) => [p.newSales, p.repeatSales])).toEqual([
      [8, 1],
      [21, 4],
      [0, 0],
      [0, 0],
      [20, 3],
      [17, 3],
    ]);
    expect(t.ceiling).toBe(22);
    expect(t.ticks).toEqual([22, 11, 0]);
    expect(salesTrend(payload(), "Омск")).toMatchObject({ ceiling: 2, ticks: [2, 1, 0] });
    expect(trendLabel("2025-01")).toBe("Янв 25");
  });

  test("подпись значения: над / под точкой, у краёв и рядом — вбок", () => {
    const base = { top: 24, plotHeight: 194 };
    // Новые выше продлений — над точкой, продления — под.
    expect(trendLabelPosition({ ...base, series: "newSales", pointY: 100, otherY: 180 })).toEqual({
      dx: 0,
      y: 88,
    });
    expect(
      trendLabelPosition({ ...base, series: "repeatSales", pointY: 180, otherY: 100 }),
    ).toEqual({ dx: 0, y: 199 });
    // Рядом (ближе 22 px) — вбок: новые влево, продления вправо.
    expect(trendLabelPosition({ ...base, series: "newSales", pointY: 100, otherY: 110 })).toEqual({
      dx: -10,
      y: 88,
    });
    expect(
      trendLabelPosition({ ...base, series: "repeatSales", pointY: 110, otherY: 100 }),
    ).toEqual({ dx: 10, y: 129 });
    // У верхнего края — под точкой, у нижнего — над.
    expect(trendLabelPosition({ ...base, series: "newSales", pointY: 30, otherY: 200 })).toEqual({
      dx: -10,
      y: 49,
    });
    expect(
      trendLabelPosition({ ...base, series: "repeatSales", pointY: 218, otherY: 100 }),
    ).toEqual({ dx: 10, y: 206 });
    // Равные значения — над точкой у обеих (pointY <= otherY).
    expect(
      trendLabelPosition({ ...base, series: "repeatSales", pointY: 150, otherY: 150 }),
    ).toEqual({ dx: 10, y: 138 });
  });
});

describe("таблицы", () => {
  test("«Что покупают»: месяц и город, продажи > 0, по убыванию; новые / продления", () => {
    const p = payload();
    expect(productRows(p, "Абакан", "all")).toEqual([
      { name: "ЗДОРОВАЯ СПИНА 48", count: 7, amount: 114450 },
      { name: "КОМБО 12", count: 2, amount: 17000 },
      { name: "КОМБО 24", count: 2, amount: 27000 },
    ]);
    expect(productRows(p, "Абакан", "new").map((r) => [r.name, r.count, r.amount])).toEqual([
      ["ЗДОРОВАЯ СПИНА 48", 6, 98000],
      ["КОМБО 24", 2, 27000],
    ]);
    expect(productRows(p, "Абакан", "repeat").map((r) => [r.name, r.count])).toEqual([
      ["КОМБО 12", 2],
      ["ЗДОРОВАЯ СПИНА 48", 1],
    ]);
    expect(productRows(p, "Омск", "all")).toEqual([]);
  });

  test("номенклатуры пробных — по убыванию записавшихся", () => {
    expect(trialProductRows(payload(), "Абакан").map((r) => r.name)).toEqual([
      "Пробное занятие",
      "Сертификат",
      "Подарочная тренировка",
      "Пустое",
    ]);
    expect(trialProductRows(payload(), "Абакан")[0]).toEqual({
      name: "Пробное занятие",
      trials: 17,
      attended: 17,
      boughtDay: 6,
      bought14: 8,
    });
  });

  test("направления: по занятиям по убыванию; тот же показатель — смена направления", () => {
    const p = payload();
    expect(directionRows(p, "Абакан", DIRECTION_SORT).map((r) => r.name)).toEqual([
      "Здоровая спина",
      "Пилатес",
      "Барре",
      "Йога",
    ]);
    const asc = nextDirectionSort(DIRECTION_SORT, "classes");
    expect(asc).toEqual({ key: "classes", order: "asc" });
    expect(nextDirectionSort(asc, "classes")).toEqual({ key: "classes", order: "desc" });
    expect(nextDirectionSort(asc, "booked")).toEqual({ key: "booked", order: "desc" });
    // Доходимость: без записей — −1, внизу при убывании и вверху при возрастании.
    const att = directionRows(p, "Абакан", { key: "attendance", order: "desc" });
    expect(att.map((r) => r.name)).toEqual(["Барре", "Пилатес", "Здоровая спина", "Йога"]);
    expect(directionValue(att[3], "attendance")).toBe(-1);
    expect(
      directionRows(p, "Абакан", { key: "attendance", order: "asc" }).map((r) => r.name)[0],
    ).toBe("Йога");
  });

  test("студии города: по убыванию строки таблицы (от Я к А), свод по студии", () => {
    const rows = studioRows(payload(), "Бийск");
    expect(rows.map((r) => r.name)).toEqual(["Бийск 2", "Бийск 1"]);
    expect(rows[1]).toMatchObject({
      revenue: `1${NB}000 ₽`,
      sales: "1",
      attendance: "66,7%",
      conversion: "—",
    });
    expect(rows[0].attendance).toBe("—");
    // Их сортировка — по строке разметки: «Абакан</td>» выше «Абакан 2</td>».
    const two = studioRows(
      payload({
        records: [rec("2026-10", "Абакан", "Абакан 2"), rec("2026-10", "Абакан", "Абакан")],
      }),
      "Абакан",
    );
    expect(two.map((r) => r.name)).toEqual(["Абакан", "Абакан 2"]);
    expect(studioRows(payload(), "Омск")).toEqual([]);
  });
});
