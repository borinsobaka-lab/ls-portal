import { describe, expect, test } from "bun:test";

import {
  mktGroups,
  mktKpis,
  mktModeNote,
  mktMoney,
  mktQualificationText,
  mktRate,
  mktSourceBudget,
  MKT_TEXT,
  type MktRow,
} from "./marketing";

const row = (r: Partial<MktRow>): MktRow => ({
  city: "Абакан",
  partner_name: "ИП Иванова",
  source: "Сайт",
  leads: 0,
  qualified: 0,
  booked: 0,
  attended: 0,
  paid: 0,
  ...r,
});

describe("подписи — как f-строки Python", () => {
  test('rate: f"{v / base:.0%}", посередине — к чётному', () => {
    expect(mktRate(1, 8)).toBe("12%");
    expect(mktRate(3, 8)).toBe("38%");
    expect(mktRate(2, 3)).toBe("67%");
    expect(mktRate(5, 5)).toBe("100%");
    expect(mktRate(0, 7)).toBe("0%");
    expect(mktRate(3, 0)).toBe("—");
  });

  test('money: f"{v:,.0f} ₽" с пробелами, без бюджета — «—»', () => {
    expect(mktMoney(null)).toBe("—");
    expect(mktMoney(0)).toBe("0 ₽");
    expect(mktMoney(2.5)).toBe("2 ₽");
    expect(mktMoney(1234567.5)).toBe("1 234 568 ₽");
    expect(mktMoney(39111.979999999996)).toBe("39 112 ₽");
  });

  test("режим результата и подсказка квалификации", () => {
    expect(mktModeNote("today", true)).toBe(MKT_TEXT.noteToday);
    expect(mktModeNote("first", true)).toBe(MKT_TEXT.noteFirst);
    expect(mktModeNote("first", false)).toBe(MKT_TEXT.noteFirstMissing);
    expect(mktQualificationText(["Дубль", "Спам"])).toBe(
      "В этом городе неквалифицированным лидом считаются закрытые сделки с основанием для закрытия: Дубль, Спам.",
    );
    expect(mktQualificationText([])).toContain("основанием для закрытия: не выбраны.");
    expect(mktQualificationText(undefined)).toContain("не выбраны.");
  });
});

describe("бюджет канала — их source_budget", () => {
  const budgets = { Абакан: { lead_forms: 1000, community_messages: 5000 } };
  test("сообщения и лид-формы VK без регистра и пробелов по краям", () => {
    expect(mktSourceBudget(row({ source: " ВКонтакте сообщения " }), budgets)).toBe(5000);
    expect(mktSourceBudget(row({ source: "Сообщения сообщества" }), budgets)).toBe(5000);
    expect(mktSourceBudget(row({ source: "вконтакте ЛФ нк" }), budgets)).toBe(1000);
    expect(mktSourceBudget(row({ source: "Авито" }), budgets)).toBeNull();
  });
  test("город без расхода VK — 0, не «—»", () => {
    expect(mktSourceBudget(row({ city: "Казань", source: "ВКонтакте ЛФ НК" }), budgets)).toBe(0);
  });
});

describe("блоки города и плитки", () => {
  const rows: MktRow[] = [
    row({
      city: "Город не сопоставлен",
      partner_name: "—",
      source: "Сайт",
      leads: 7,
      qualified: 7,
    }),
    row({ city: "абакан", partner_name: "Б", source: "Сайт", leads: 1, qualified: 1 }),
    row({
      source: "ВКонтакте сообщения",
      leads: 10,
      qualified: 8,
      booked: 4,
      attended: 2,
      paid: 1,
    }),
    row({
      source: "Сообщения сообщества",
      leads: 5,
      qualified: 4,
      booked: 2,
      attended: 1,
      paid: 1,
    }),
    row({ source: "Авито", leads: 4, qualified: 3, booked: 3, attended: 3, paid: 0 }),
    row({ city: "Абакан", partner_name: "а", source: "Сайт", leads: 2, qualified: 2 }),
  ];
  const budgets = { Абакан: { lead_forms: 0, community_messages: 3000 } };

  test("порядок: город и партнёр без регистра, «Город не сопоставлен» — последним", () => {
    const g = mktGroups({ rows, budgets, qualification: {} });
    expect(g.map((x) => [x.city, x.partner])).toEqual([
      ["Абакан", "а"],
      ["абакан", "Б"],
      ["Абакан", "ИП Иванова"],
      ["Город не сопоставлен", "—"],
    ]);
  });

  test("строки, итог города и бюджеты — их, включая двойной бюджет сообщений", () => {
    const g = mktGroups({ rows, budgets, qualification: { Абакан: ["Спам"] } }).find(
      (x) => x.partner === "ИП Иванова",
    )!;
    expect(g.channels).toBe(3);
    expect(g.qualification).toContain(": Спам.");
    expect(g.rows.map((r) => [r.source, r.budget, r.cpl, r.costPerSale])).toEqual([
      ["ВКонтакте сообщения", "3 000 ₽", "300 ₽", "3 000 ₽"],
      ["Сообщения сообщества", "3 000 ₽", "600 ₽", "3 000 ₽"],
      ["Авито", "—", "—", "—"],
    ]);
    expect(g.rows[0]).toMatchObject({
      leads: 10,
      qualified: 8,
      leadToQualified: "80%",
      qualifiedToBooked: "50%",
      bookedToAttended: "50%",
      attendedToPaid: "50%",
      qualifiedToPaid: "12%",
    });
    expect(g.total).toMatchObject({
      source: "Итого по городу",
      budget: "6 000 ₽",
      leads: 19,
      cpl: "316 ₽",
      qualified: 15,
      paid: 2,
      costPerSale: "3 000 ₽",
      qualifiedToPaid: "13%",
    });
  });

  test("город без каналов с бюджетом — «—» в итоге", () => {
    const g = mktGroups({ rows, budgets, qualification: {} }).find((x) => x.partner === "Б")!;
    expect(g.total.budget).toBe("—");
    expect(g.total.cpl).toBe("—");
  });

  test("плитки — без «Город не сопоставлен»", () => {
    expect(mktKpis(rows)).toEqual([
      { label: "Всего лидов", value: 22 },
      { label: "Квалифицированные", value: 18, note: "82% от всех лидов" },
      { label: "Записались на пробное", value: 9, note: "50% от квалифицированных" },
      { label: "Пришли на пробное", value: 6, note: "67% доходимость" },
      { label: "Купили", value: 2, note: "11% от квалифицированных" },
    ]);
    expect(mktKpis([])[1].note).toBe("— от всех лидов");
  });
});
