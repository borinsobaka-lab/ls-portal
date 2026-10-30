import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import type { Inflate } from "../onec/xlsx-read";
import { writeXlsx } from "../onec/xlsx-write";
import {
  formFloat,
  formInt,
  planBudget,
  planFromXlsx,
  planMoney,
  plansFromMultiMonthXlsx,
  plansFromRows,
  pyG,
} from "./plans";
import {
  Frac,
  monthsBetween,
  registerPeriod,
  registerView,
  remainingPlan,
  summaryMoney,
  summaryPrice,
  type RegisterPayload,
  type RegisterRow,
} from "./register";
import {
  pyQuoteRange,
  ssDailyCounts,
  ssDays,
  ssSheetDate,
  ssSpreadsheetId,
  vkCanonicalCity,
} from "./ss";

const inflate: Inflate = async function* (data) {
  const s = Readable.from([Buffer.from(data)]).pipe(createInflateRaw());
  for await (const c of s) yield c as Uint8Array;
};

describe("VK Ads: источники СС — их _sheet_date и счётчики", () => {
  test("даты таблиц: ISO где угодно, ДД.ММ.ГГГГ и через «/», «5 октября 2026», серийный номер", () => {
    expect(ssSheetDate("05.10.2026 12:30")).toBe("2026-10-05");
    expect(ssSheetDate("\u00a05/10/2026 ")).toBe("2026-10-05");
    expect(ssSheetDate("Заявка от 2026-10-06T10:00")).toBe("2026-10-06");
    expect(ssSheetDate("5 Октября 2026")).toBe("2026-10-05");
    expect(ssSheetDate("5 окт. 2026")).toBe("2026-10-05");
    expect(ssSheetDate("46301")).toBe("2026-10-06");
    expect(ssSheetDate("46301,75")).toBe("2026-10-06");
    // Найдено, но такого дня нет — дальше не ищут.
    expect(ssSheetDate("31.02.2026")).toBeNull();
    expect(ssSheetDate("2026-02-30 и 05.10.2026")).toBeNull();
    expect(ssSheetDate("5 брюмера 2026")).toBeNull();
    expect(ssSheetDate("вчера")).toBeNull();
    expect(ssSheetDate("")).toBeNull();
  });

  test("счётчики по дням: со второй строки, колонка даты C / D, короткие строки — мимо", () => {
    const leads = [
      ["Имя", "Город", "Дата"],
      ["А", "Абакан", "05.10.2026"],
      ["Б", "Другой город", "5 октября 2026"],
      ["В"],
      ["Г", "", "2026-10-06"],
      ["Д", "", "нет даты"],
    ];
    expect([...ssDailyCounts(leads, 2)]).toEqual([
      ["2026-10-05", 2],
      ["2026-10-06", 1],
    ]);
    const apps = [
      ["Имя", "Телефон", "Город", "Дата"],
      ["А", "1", "", "06.10.2026"],
    ];
    expect(ssDays(leads, apps)).toEqual([
      { date: "2026-10-05", leads: 2, applications: 0 },
      { date: "2026-10-06", leads: 1, applications: 1 },
    ]);
    expect(() => ssDays([["h"], ["x", "y", "z"]], [])).toThrow(
      "В источниках СС не найдены строки с распознанной датой. Получено строк: лиды — 1, заявки — 0.",
    );
  });

  test("ID таблицы из ссылки, адрес диапазона как их quote, Казань Lady Jump", () => {
    expect(ssSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=0")).toBe(
      "1AbC_d-9",
    );
    expect(() => ssSpreadsheetId("https://docs.google.com/spreadsheets/u/1/x")).toThrow(
      "Не удалось извлечь ID Google Таблицы из ссылки.",
    );
    expect(() => ssSpreadsheetId("https://docs.google.com/spreadsheets/d/a.b/edit")).toThrow(
      "Некорректный ID Google Таблицы.",
    );
    expect(pyQuoteRange("Сбор лидов!A:Z")).toBe(
      "%D0%A1%D0%B1%D0%BE%D1%80%20%D0%BB%D0%B8%D0%B4%D0%BE%D0%B2!A:Z",
    );
    expect(pyQuoteRange("a*(b)'~")).toBe("a%2A%28b%29'~");
    expect(vkCanonicalCity(" Lady Jump ", "Казань\u00a0Вишневского")).toBe("Казань · Вишневского");
    expect(vkCanonicalCity("Lady Stretch", "Казань")).toBe("Казань");
  });
});

describe("VK Ads: планы таргета — их разбор Excel и форм", () => {
  test("строки листа: заголовки без регистра, пустые и «только город» пропускаются, номер — среди непустых", () => {
    expect(
      plansFromRows([
        [null, null],
        [" ГОРОД ", "Заявки", "Стоимость заявки"],
        ["Абакан", "1 200", "850,5"],
        ["Бийск", null, ""],
        ["", "", ""],
        ["Омск", "12.0", "1e3"],
      ]),
    ).toEqual([
      { city: "Абакан", applications_plan: 1200, target_cpl: 850.5 },
      { city: "Омск", applications_plan: 12, target_cpl: 1000 },
    ]);
    expect(() => plansFromRows([])).toThrow("Файл плана пуст.");
    expect(() => plansFromRows([["Город", "Заявки"]])).toThrow(
      "В первой строке нужны колонки: Город, Заявки, Стоимость заявки.",
    );
    expect(() =>
      plansFromRows([["Город", "Заявки", "Стоимость заявки"], [null], ["", "5", "100"]]),
    ).toThrow("Строка 2: заполните город, заявки и стоимость заявки.");
    expect(() =>
      plansFromRows([
        ["Город", "Заявки", "Стоимость заявки"],
        ["А", "5.5", "100"],
      ]),
    ).toThrow("Строка 2: заявки должны быть целым числом, стоимость — числом.");
    expect(() =>
      plansFromRows([
        ["Город", "Заявки", "Стоимость заявки"],
        ["А", "5", "сто"],
      ]),
    ).toThrow("Строка 2: заявки должны быть целым числом, стоимость — числом.");
  });

  test("файл: один лист, лист месяца, все листы года — их ошибки", async () => {
    const sheet = (name: string, rows: (string | number | null)[][]) => ({ name, rows });
    const head = ["Город", "Заявки", "Стоимость заявки"];
    const one = await writeXlsx([sheet("План", [head, ["Абакан", 30, 1000]])]);
    expect(await planFromXlsx(one, "2026-10", inflate)).toEqual([
      { city: "Абакан", applications_plan: 30, target_cpl: 1000 },
    ]);
    const two = await writeXlsx([
      sheet(" Сентябрь ", [head, ["Абакан", 25, 1000]]),
      sheet("Октябрь 2026", [head, ["Абакан", 31, 900]]),
    ]);
    expect(await planFromXlsx(two, "2026-10", inflate)).toEqual([
      { city: "Абакан", applications_plan: 31, target_cpl: 900 },
    ]);
    await expect(planFromXlsx(two, "2026-11", inflate)).rejects.toThrow(
      "Для обычной загрузки используйте файл с одним листом. В этом файле не удалось однозначно найти выбранный месяц.",
    );
    expect(await plansFromMultiMonthXlsx(two, 2026, inflate)).toEqual([
      { month: "2026-09", plans: [{ city: "Абакан", applications_plan: 25, target_cpl: 1000 }] },
      { month: "2026-10", plans: [{ city: "Абакан", applications_plan: 31, target_cpl: 900 }] },
    ]);
    await expect(plansFromMultiMonthXlsx(two, 2019, inflate)).rejects.toThrow(
      "Укажите корректный год планов.",
    );
    await expect(plansFromMultiMonthXlsx(one, 2026, inflate)).rejects.toThrow(
      "Лист «План» не является названием месяца.",
    );
    const dup = await writeXlsx([sheet("Май", [head]), sheet("май 2026", [head])]);
    await expect(plansFromMultiMonthXlsx(dup, 2026, inflate)).rejects.toThrow(
      "Месяц 2026-05 повторяется в файле.",
    );
    await expect(planFromXlsx(new Uint8Array([1, 2, 3]), "2026-10", inflate)).rejects.toThrow(
      "Не удалось прочитать .xlsx-файл плана.",
    );
    await expect(
      planFromXlsx(new Uint8Array(2 * 1024 * 1024 + 1), "2026-10", inflate),
    ).rejects.toThrow("Загрузите Excel-файл размером не больше 2 МБ.");
  });

  test("числа форм и подписи: int() / float(), f'{x:g}', бюджеты", () => {
    expect([formInt(" 12 "), formInt("1_000"), formInt("12.0"), formInt("")]).toEqual([
      12,
      1000,
      null,
      null,
    ]);
    expect([formFloat("850,5"), formFloat(" 1e3 "), formFloat("abc")]).toEqual([850.5, 1000, null]);
    expect(
      [
        850.5, 1000, 1234567.5, 0.0001, 0.00001234, 333.3333333333333, 100000, 999999.5, 1e16,
        123.456789,
      ].map(pyG),
    ).toEqual([
      "850.5",
      "1000",
      "1.23457e+06",
      "0.0001",
      "1.234e-05",
      "333.333",
      "100000",
      "1e+06",
      "1e+16",
      "123.457",
    ]);
    expect(planBudget(120, 850.5)).toBe("102 060 ₽");
    expect(planMoney(850.5)).toBe("850 ₽");
    expect(planMoney(null)).toBe("—");
  });
});

describe("VK Ads: реестр таргета — их target_register_page", () => {
  test("точные дроби, месяцы периода, период по умолчанию", () => {
    const f = new Frac(31n, 31n).mul(Frac.of(29));
    expect(f.ceil()).toBe(29);
    expect(new Frac(10n, 3n).ceil()).toBe(4);
    expect(Frac.of(0).ceil()).toBe(0);
    expect(monthsBetween("2026-11-15", "2027-02-01")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(registerPeriod(undefined, undefined, "2026-10-30")).toEqual({
      from: "2026-10-01",
      to: "2026-10-29",
    });
    // 1-е число: «по вчера» раньше начала — даты меняются местами (как у них).
    expect(registerPeriod(undefined, undefined, "2026-11-01")).toEqual({
      from: "2026-10-31",
      to: "2026-11-01",
    });
    expect(registerPeriod("2026-10-10", "2026-10-02", "2026-10-30")).toEqual({
      from: "2026-10-02",
      to: "2026-10-10",
    });
    expect(registerPeriod("2026-02-30", "x", "2026-10-30")).toEqual({
      from: "2026-10-01",
      to: "2026-10-29",
    });
  });

  test("план периода по остатку: факт до периода, будущий период — факт по сегодня", () => {
    const plans = [
      {
        month: "2026-10",
        brand: "Lady Stretch",
        city: "А",
        applications_plan: 31,
        target_cpl: 1000,
      },
    ];
    // С 11.10: до периода получено 13 → остаток 18 на 21 день, период 11–20.
    const facts = [{ month: "2026-10", brand: "Lady Stretch", city: "А", applications: 13 }];
    const p = remainingPlan("2026-10-11", "2026-10-20", plans, facts, "2026-10-30").get(
      "Lady Stretch\u0000А",
    )!;
    expect(p.applications.ceil()).toBe(9); // 18/21 × 10 = 8.57…
    expect(p.targetCpl).toBe(1000);
    // Будущий период с 25.10, сегодня 10.10: остаток делится на 31 − 10 дней.
    const fut = remainingPlan("2026-10-25", "2026-10-31", plans, facts, "2026-10-10").get(
      "Lady Stretch\u0000А",
    )!;
    expect(fut.applications.ceil()).toBe(6); // 18/21 × 7 = 6 ровно
    // Месячный план выполнен — остаток ноль.
    const done = remainingPlan(
      "2026-10-11",
      "2026-10-20",
      plans,
      [{ ...facts[0], applications: 40 }],
      "2026-10-30",
    );
    expect(done.get("Lady Stretch\u0000А")!.applications.ceil()).toBe(0);
  });

  const row = (p: Partial<RegisterRow>): RegisterRow => ({
    brand: "Lady Stretch",
    city: "Абакан",
    platform_spent: 0,
    lead_form_spent: 0,
    campaign_rows: 0,
    accounts_count: 1,
    community_leads: 0,
    community_applications: 0,
    lead_form_applications: 0,
    targetologist_name: null,
    zero_days: [],
    assumed_days: [],
    ...p,
  });

  test("строки, статусы, группы (без таргетолога — в конце), плашки с ROUND_HALF_UP", () => {
    const payload: RegisterPayload = {
      from: "2026-10-01",
      to: "2026-10-10",
      today: "2026-10-30",
      admin: true,
      targetologist: "",
      brand: "",
      people: [],
      rows: [
        row({
          city: "Абакан",
          targetologist_name: "яна",
          platform_spent: 10000,
          lead_form_spent: 2500,
          community_leads: 30,
          community_applications: 4,
          lead_form_applications: 6,
          zero_days: ["2026-10-02", "2026-10-03"],
          assumed_days: ["2026-10-03"],
        }),
        row({
          city: "Бийск",
          targetologist_name: "Анна",
          platform_spent: 1000,
          community_applications: 2,
        }),
        row({ city: "Омск", platform_spent: 0.5 }),
        row({ city: "", brand: "Lady Jump", targetologist_name: "Анна" }),
      ],
      plans: [
        {
          month: "2026-10",
          brand: "Lady Stretch",
          city: "Абакан",
          applications_plan: 31,
          target_cpl: 1000,
        },
        {
          month: "2026-10",
          brand: "Lady Stretch",
          city: "Бийск",
          applications_plan: 3,
          target_cpl: 700,
        },
      ],
      facts: [],
    };
    const v = registerView(payload);
    expect(v.groups.map((g) => [g.name, g.cities.map((c) => c.cityLabel), g.unassigned])).toEqual([
      ["Анна", ["Город не назначен", "Бийск"], false],
      ["яна", ["Абакан"], false],
      ["Не назначен", ["Омск"], true],
    ]);
    const abakan = v.groups[1].cities[0];
    expect(abakan).toMatchObject({
      ordinary: "10",
      adjusted: "8",
      applications: 10,
      percentage: "100%",
      targetCpl: "1 000 ₽",
      actualCpl: "1 220 ₽",
      cplTone: "high",
      total: "12 200 ₽",
      status: { label: "Выше цели", tone: "warning" },
      volume: { label: "+0 сверх", tone: "good" },
      planBudget: "10 000 ₽",
      zeroDays: 2,
      assumedDays: 1,
      qualification: "—",
    });
    expect(abakan.leadForms).toEqual({ spent: "3 050 ₽", applications: 6, price: "508 ₽" });
    expect(abakan.messages).toEqual({
      spent: "9 150 ₽",
      leads: 30,
      applications: 4,
      conversion: "13.3%",
      price: "2 288 ₽",
    });
    const biysk = v.groups[0].cities[1];
    expect(biysk.ordinary).toBe("1"); // 3 × 10/31 → остаток 3/31 в день × 10 = 0.97 → 1
    // 1 220 ₽ / 2 заявки = 610 ₽ — не выше цели 700 ₽, заявок больше плана.
    expect(biysk.status).toEqual({ label: "В норме", tone: "good" });
    const omsk = v.groups[2].cities[0];
    expect(omsk).toMatchObject({
      ordinary: "—",
      adjusted: "—",
      percentage: "—",
      status: { label: "Нет плана", tone: "neutral" },
      volume: null,
      planBudget: "—",
    });
    const noCity = v.groups[0].cities[0];
    expect(noCity.status.label).toBe("Нет плана");
    expect(v.summary).toEqual([
      {
        kind: "forms",
        title: "Лид-формы",
        subtitle: "",
        applications: 6,
        price: "508 ₽",
        spent: "3 050 ₽",
      },
      {
        kind: "messages",
        title: "Сообщения сообщества",
        subtitle: "",
        applications: 6,
        price: "1 728 ₽",
        spent: "10 371 ₽",
      },
      {
        kind: "total",
        title: "Итого",
        subtitle: "Общие показатели",
        applications: 12,
        price: "1 118 ₽",
        spent: "13 421 ₽",
      },
    ]);
    expect(v.scope).toBe("Показатели всех таргетологов");
    expect(v.period).toBe("01.10.2026 — 10.10.2026");
    expect(registerView({ ...payload, targetologist: "Анна" }).scope).toBe("Показатели: Анна");
  });

  test("Decimal плашек: цена — 28 знаков и ROUND_HALF_UP, суммы — от str(float)", () => {
    expect(
      [
        [0.3, 1],
        [2.5, 1],
        [33483.51299999999, 2],
        [1.5, 3],
        [100, 3],
        [878574.0300000001, 7],
      ].map(([s, n]) => summaryPrice(s, n)),
    ).toEqual(["0 ₽", "3 ₽", "16 742 ₽", "1 ₽", "33 ₽", "125 511 ₽"]);
    expect([0.5, 1.5, 2.5, 1234567.5].map(summaryMoney)).toEqual([
      "1 ₽",
      "2 ₽",
      "3 ₽",
      "1 234 568 ₽",
    ]);
  });
});
