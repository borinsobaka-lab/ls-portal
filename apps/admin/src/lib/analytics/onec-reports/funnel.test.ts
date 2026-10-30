import { describe, expect, test } from "bun:test";

import {
  FUNNEL_ALL,
  FUNNEL_NO_FILTERS,
  funnelAggregate,
  funnelCards,
  funnelCells,
  funnelClearDirections,
  funnelCount,
  funnelDirectionCount,
  funnelDirectionLabel,
  funnelFiltered,
  funnelInRange,
  funnelMatches,
  funnelOptions,
  funnelRange,
  funnelRate,
  funnelRestore,
  funnelSearchFilters,
  funnelSelect,
  funnelStudioId,
  funnelTable,
  funnelToggle,
  funnelToggleDirection,
  funnelTotals,
  unpackFunnel,
  type FunnelRow,
} from "./funnel";
import type { FunnelPayload } from "./payload";

const NBSP = " ";

const payload: FunnelPayload = {
  generatedAt: "28.10.2026 09:57",
  sourceFile: "Сводные 1С · база портала",
  start: "2026-10-01",
  end: "2026-10-27",
  currentPeriod: "2026-10",
  minDate: "2026-08-03",
  maxDate: "2026-10-28",
  periods: [],
  cities: ["Абакан", "Бийск", "Москва"],
  studios: ["Абакан Ленина", "Бийск Центр", "Москва Арбат", "Москва Сити"],
  directions: ["Йога", "Растяжка", "Пилатес"],
  studioStatuses: ["Открыта", "Закрыта", "Открыта", ""],
  records: [
    // [начало, период, город, студия, направление, v1…v8]
    ["2026-10-01", "2026-10", 0, 0, 1, 10, 6, 6, 2, 6, 3, 1, 4],
    ["2026-10-01", "2026-10", 0, 0, 0, 5, 4, 4, 1, 3, 2, 1, 0],
    ["2026-10-01", "2026-10", 1, 1, 1, 8, 2, 2, 0, 2, 1, 1, 0],
    ["2026-10-01", "2026-10", 2, 2, 2, 20, 10, 9, 3, 8, 4, 1, 2],
    ["2026-10-01", "2026-10", 2, 3, 1, 3, 0, 0, 0, 0, 0, 0, 0],
  ],
};

const rows = unpackFunnel(payload);
const range = funnelRange(payload);

const row = (p: Partial<FunnelRow>): FunnelRow => ({
  date: "2026-10-01",
  period: "2026-10",
  city: "Абакан",
  studio: "Абакан Ленина",
  status: "Открыта",
  direction: "Йога",
  scheduled: 0,
  attended: 0,
  closedDay: 0,
  boughtDay: 0,
  closed14: 0,
  bought14: 0,
  boughtLater: 0,
  ...p,
});

describe("формат — их count и rate", () => {
  test("целое ru-RU с неразрывным пробелом, округление Math.round", () => {
    expect(funnelCount(3096)).toBe(`3${NBSP}096`);
    expect(funnelCount(1234567.5)).toBe(`1${NBSP}234${NBSP}568`);
    expect(funnelCount(2.5)).toBe("3");
    expect(funnelCount(0)).toBe("0");
    expect(funnelCount(Number.NaN)).toBe("0");
  });

  test("особенность: −0,4 округляется в −0 и печатается «-0»", () => {
    expect(funnelCount(-0.4)).toBe("-0");
  });

  test("доля — точка и один знак, без базы — «—»", () => {
    expect(funnelRate(1765, 3096)).toBe("57.0%");
    expect(funnelRate(2, 3)).toBe("66.7%");
    expect(funnelRate(0, 5)).toBe("0.0%");
    expect(funnelRate(5, 0)).toBe("—");
    expect(funnelRate(7, 4)).toBe("175.0%");
  });
});

describe("записи и период", () => {
  test("unpack: индексы в названия, статус — по студии, v8 не читается", () => {
    expect(rows[0]).toEqual({
      date: "2026-10-01",
      period: "2026-10",
      city: "Абакан",
      studio: "Абакан Ленина",
      status: "Открыта",
      direction: "Растяжка",
      scheduled: 10,
      attended: 6,
      closedDay: 6,
      boughtDay: 2,
      closed14: 6,
      bought14: 3,
      boughtLater: 1,
    });
    expect(rows[4].status).toBe("");
  });

  test("период — их onecInitPeriod: начало, конец и месяц доски", () => {
    expect(range).toEqual({ start: "2026-10-01", end: "2026-10-27", months: ["2026-10"] });
    expect(funnelInRange(rows[0], range)).toBe(true);
    expect(funnelInRange(row({ period: "2026-09" }), range)).toBe(false);
    expect(funnelInRange(row({ date: "2026-09-30" }), range)).toBe(false);
    expect(funnelInRange(row({ period: "2026-09" }), { start: "", end: "", months: [] })).toBe(
      true,
    );
  });
});

describe("плитки", () => {
  const t = funnelTotals(rows);

  test("суммы по всем записям", () => {
    expect(t).toEqual({
      scheduled: 46,
      attended: 22,
      closedDay: 21,
      boughtDay: 6,
      closed14: 19,
      bought14: 10,
      boughtLater: 4,
    });
  });

  test("конверсии делятся на свои базы, не на «Пришли»", () => {
    const cards = funnelCards(t);
    expect(cards.map((c) => c.label)).toEqual([
      "Записались на пробное",
      "Пришли на пробное",
      "Доходимость",
      "Купили в день пробного",
      "Конверсия продажи в день пробного",
      "Купили в течение 14 дней с пробного",
      "Конверсия продажи в течение 14 дней с пробного",
      "Купили не в день пробного",
    ]);
    expect(cards.map((c) => c.value)).toEqual([
      "46",
      "22",
      "47.8%",
      "6",
      "28.6%",
      "10",
      "52.6%",
      "4",
    ]);
  });

  test("без записей — нули и «—»", () => {
    expect(funnelCards(funnelTotals([])).map((c) => c.value)).toEqual([
      "0",
      "0",
      "—",
      "0",
      "—",
      "0",
      "—",
      "0",
    ]);
  });

  test("ячейки строки — в порядке колонок, доли отмечены", () => {
    expect(funnelCells(t)).toEqual([
      { value: "46", rate: false },
      { value: "22", rate: false },
      { value: "47.8%", rate: true },
      { value: "6", rate: false },
      { value: "28.6%", rate: true },
      { value: "10", rate: false },
      { value: "52.6%", rate: true },
      { value: "4", rate: false },
    ]);
  });
});

describe("фильтры — их updateOptions", () => {
  test("списки по алфавиту ru, без фильтров — всё", () => {
    const o = funnelOptions(rows, range, FUNNEL_NO_FILTERS);
    expect(o.cities).toEqual(["Абакан", "Бийск", "Москва"]);
    expect(o.studios).toEqual(["Абакан Ленина", "Бийск Центр", "Москва Арбат", "Москва Сити"]);
    expect(o.directions).toEqual(["Йога", "Пилатес", "Растяжка"]);
  });

  test("статус сужает города, город — студии, студия — направления", () => {
    const closed = funnelOptions(rows, range, { ...FUNNEL_NO_FILTERS, status: "Закрыта" });
    expect(closed.cities).toEqual(["Бийск"]);
    const moscow = funnelOptions(rows, range, { ...FUNNEL_NO_FILTERS, city: "Москва" });
    expect(moscow.studios).toEqual(["Москва Арбат", "Москва Сити"]);
    expect(moscow.directions).toEqual(["Пилатес", "Растяжка"]);
    const arbat = funnelOptions(rows, range, {
      ...FUNNEL_NO_FILTERS,
      city: "Москва",
      studio: "Москва Арбат",
    });
    expect(arbat.directions).toEqual(["Пилатес"]);
  });

  test("особенность: числа сортируются строкой — «10» раньше «9»", () => {
    const o = funnelOptions(
      [row({ city: "9" }), row({ city: "10" }), row({ city: "Абакан" })],
      range,
      FUNNEL_NO_FILTERS,
    );
    expect(o.cities).toEqual(["10", "9", "Абакан"]);
  });

  test("выбранное, которого нет в новом списке, сбрасывается насовсем", () => {
    let f = funnelSelect(rows, range, FUNNEL_NO_FILTERS, "city", "Москва");
    f = funnelSelect(rows, range, f, "studio", "Москва Арбат");
    expect(f).toEqual({
      status: FUNNEL_ALL,
      city: "Москва",
      studio: "Москва Арбат",
      directions: [],
    });
    // В закрытых студиях Москвы нет — город и студия во «все».
    f = funnelSelect(rows, range, f, "status", "Закрыта");
    expect(f).toEqual({ status: "Закрыта", city: FUNNEL_ALL, studio: FUNNEL_ALL, directions: [] });
    // Вернули статус — город не возвращается.
    f = funnelSelect(rows, range, f, "status", FUNNEL_ALL);
    expect(f.city).toBe(FUNNEL_ALL);
  });

  test("смена города сбрасывает студию другого города", () => {
    let f = funnelSelect(rows, range, FUNNEL_NO_FILTERS, "studio", "Абакан Ленина");
    f = funnelSelect(rows, range, f, "city", "Москва");
    expect(f.studio).toBe(FUNNEL_ALL);
  });

  test("направления: отметка без пересчёта, недоступные снимаются при смене селекта", () => {
    let f = funnelToggleDirection(FUNNEL_NO_FILTERS, "Растяжка", true);
    f = funnelToggleDirection(f, "Пилатес", true);
    expect(f.directions).toEqual(["Растяжка", "Пилатес"]);
    f = funnelSelect(rows, range, f, "city", "Абакан");
    expect(f.directions).toEqual(["Растяжка"]);
    expect(funnelToggleDirection(f, "Растяжка", false).directions).toEqual([]);
    expect(funnelClearDirections(rows, range, f)).toEqual({ ...f, directions: [] });
  });

  test("подпись поля направлений и счётчик", () => {
    expect(funnelDirectionLabel([])).toBe("Все направления");
    expect(funnelDirectionLabel(["Йога"])).toBe("Йога");
    expect(funnelDirectionLabel(["Йога", "Пилатес"])).toBe("Направлений выбрано: 2");
    expect(funnelDirectionCount([])).toBe("");
    expect(funnelDirectionCount(["Йога", "Пилатес"])).toBe("Выбрано: 2");
  });

  test("поиск в списках — без регистра, с обрезкой пробелов запроса", () => {
    expect(funnelMatches("Великий Новгород", "  новг ")).toBe(true);
    expect(funnelMatches("Все города", "моск")).toBe(false);
    expect(funnelMatches("Ёлки", "ёл")).toBe(true);
    expect(funnelMatches("Абакан", "")).toBe(true);
  });

  test("записи под фильтрами — их rows()", () => {
    expect(funnelFiltered(rows, range, FUNNEL_NO_FILTERS)).toHaveLength(5);
    expect(
      funnelFiltered(rows, range, { ...FUNNEL_NO_FILTERS, status: "Открыта" }).map((r) => r.studio),
    ).toEqual(["Абакан Ленина", "Абакан Ленина", "Москва Арбат"]);
    expect(
      funnelFiltered(rows, range, { ...FUNNEL_NO_FILTERS, directions: ["Растяжка"] }),
    ).toHaveLength(3);
  });
});

describe("фильтры из адреса — их server-controls.js", () => {
  test("ставится то, что есть в списке, по очереди город → студия → статус", () => {
    expect(funnelRestore(rows, range, { city: "Москва", studio: "Москва Сити" })).toEqual({
      status: FUNNEL_ALL,
      city: "Москва",
      studio: "Москва Сити",
      directions: [],
    });
  });

  test("студия другого города не ставится, неизвестный город — тоже", () => {
    expect(funnelRestore(rows, range, { city: "Москва", studio: "Бийск Центр" }).studio).toBe(
      FUNNEL_ALL,
    );
    expect(funnelRestore(rows, range, { city: "Казань" }).city).toBe(FUNNEL_ALL);
  });

  test("статус ставится последним и сбрасывает несовместимые город и студию", () => {
    expect(
      funnelRestore(rows, range, { city: "Москва", studio: "Москва Арбат", status: "Закрыта" }),
    ).toEqual({ status: "Закрыта", city: FUNNEL_ALL, studio: FUNNEL_ALL, directions: [] });
  });

  test("неизвестный статус пропускается", () => {
    expect(funnelRestore(rows, range, { status: "Ремонт" }).status).toBe(FUNNEL_ALL);
  });

  test("в адрес — только не «все»", () => {
    expect(funnelSearchFilters(FUNNEL_NO_FILTERS)).toEqual({
      city: undefined,
      studio: undefined,
      status: undefined,
    });
    expect(
      funnelSearchFilters({
        status: "Открыта",
        city: "Москва",
        studio: FUNNEL_ALL,
        directions: [],
      }),
    ).toEqual({ city: "Москва", studio: undefined, status: "Открыта" });
  });
});

describe("таблица — их aggregate и renderTable", () => {
  test("aggregate: суммы по ключу полей в порядке первой встречи", () => {
    const g = funnelAggregate(
      [
        row({ city: "Москва", scheduled: 2 }),
        row({ city: "Абакан", scheduled: 1 }),
        row({ city: "Москва", scheduled: 3, attended: 1 }),
      ],
      ["city"],
    );
    expect(g.map((x) => [x.city, x.scheduled, x.attended])).toEqual([
      ["Москва", 5, 1],
      ["Абакан", 1, 0],
    ]);
  });

  test("свёрнутое — только города по алфавиту", () => {
    const t = funnelTable(rows, new Set(), new Set());
    expect(t.map((r) => [r.level, r.name, r.expanded])).toEqual([
      ["city", "Абакан", false],
      ["city", "Бийск", false],
      ["city", "Москва", false],
    ]);
    expect(funnelCells(t[2].totals).map((c) => c.value)).toEqual([
      "23",
      "10",
      "43.5%",
      "3",
      "33.3%",
      "4",
      "50.0%",
      "1",
    ]);
  });

  test("раскрытый город — студии со статусом, раскрытая студия — направления", () => {
    const t = funnelTable(
      rows,
      new Set(["Москва", "Абакан"]),
      new Set([funnelStudioId("Абакан", "Абакан Ленина")]),
    );
    expect(t.map((r) => [r.level, r.name, r.status ?? null])).toEqual([
      ["city", "Абакан", null],
      ["studio", "Абакан Ленина", "Открыта"],
      ["direction", "Йога", null],
      ["direction", "Растяжка", null],
      ["city", "Бийск", null],
      ["city", "Москва", null],
      ["studio", "Москва Арбат", "Открыта"],
      ["studio", "Москва Сити", null],
    ]);
    expect(t[1]).toMatchObject({
      toggleId: funnelStudioId("Абакан", "Абакан Ленина"),
      expanded: true,
    });
    expect(new Set(t.map((r) => r.key)).size).toBe(t.length);
  });

  test("раскрытие переживает фильтр: скрытый город остаётся раскрытым", () => {
    const expanded = new Set(["Москва"]);
    const only = funnelFiltered(rows, range, { ...FUNNEL_NO_FILTERS, city: "Абакан" });
    expect(funnelTable(only, expanded, new Set()).map((r) => r.name)).toEqual(["Абакан"]);
    expect(
      funnelTable(rows, expanded, new Set())
        .filter((r) => r.level === "studio")
        .map((r) => r.name),
    ).toEqual(["Москва Арбат", "Москва Сити"]);
  });

  test("toggle — новый Set", () => {
    const a = new Set(["Москва"]);
    const b = funnelToggle(a, "Москва");
    expect([...a]).toEqual(["Москва"]);
    expect([...b]).toEqual([]);
    expect([...funnelToggle(b, "Абакан")]).toEqual(["Абакан"]);
  });
});
