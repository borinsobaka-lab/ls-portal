import { describe, expect, test } from "bun:test";

import {
  budgetAlertText,
  budgetVerdict,
  Dec,
  tgChatIdOk,
  tgChatsFromUpdates,
  tgSettingsCheck,
} from "./budget";

const SETTINGS = { warning_days: "3", critical_days: "1", target_days: 7 };

// Эталон — Python Decimal (контекст по умолчанию) по их правилам evaluate_budget_alerts.
const REFERENCE = [
  ["2500.00", 7000, "1000.0", "2.5", "4500", "1000", "2.5"],
  ["350", 4900, "700.0", "0.5", "4550", "700", "0.5"],
  ["0", 187624.5, "26803.5", "0", "187625", "26804", "0.0"],
  ["100000", 2333.31, "333.33", "300.0030000300003000030000300", "0", "333", "300.0"],
  [
    "15234.50",
    10000.1,
    "1428.585714285714285714285714",
    "10.66404335956640433595664044",
    "0",
    "1429",
    "10.7",
  ],
  ["-12.5", 7, "1.0", "-12.5", "20", "1", "-12.5"],
  [
    "1234.56",
    1e-5,
    "0.000001428571428571428571428571429",
    "864191999.9999999999999999997",
    "0",
    "0",
    "864192000.0",
  ],
  [
    "99.99",
    1234.5678,
    "176.3668285714285714285714286",
    "0.5669433464893544121270617943",
    "1135",
    "176",
    "0.6",
  ],
  ["0.01", 0.07, "0.01", "1", "1", "0", "1.0"],
  ["3000", 7000, "1000.0", "3", "4000", "1000", "3.0"],
  ["1000", 7000, "1000.0", "1", "6000", "1000", "1.0"],
] as const;

describe("VK Ads: контроль бюджетов — их Decimal и evaluate_budget_alerts", () => {
  test("средние траты, прогноз и рекомендация — как Python Decimal", () => {
    for (const [balance, spent, average, forecast, recommended, a0, f1] of REFERENCE) {
      const v = budgetVerdict({ balance, spent, days: 7 }, { ...SETTINGS, warning_days: "1e9" });
      if (v.kind !== "alert") throw new Error(`нет предупреждения: ${balance}`);
      expect([v.average.toString(), v.forecast.toString(), v.recommended.toString()]).toEqual([
        average,
        forecast,
        recommended,
      ]);
      expect([v.average.fixed(0), v.forecast.fixed(1), v.balance.toString()]).toEqual([
        a0,
        f1,
        balance,
      ]);
    }
  });

  test("Decimal: разбор, округление к чётному, порядок у точного деления", () => {
    expect(Dec.parse("1.5E+2").toString()).toBe("150");
    expect(Dec.parse("-0.5").fixed(0)).toBe("-0");
    expect(Dec.parse("2.5").fixed(0)).toBe("2");
    expect(Dec.parse("3.5").fixed(0)).toBe("4");
    expect(Dec.parse("0.125").fixed(2)).toBe("0.12");
    expect(Dec.fromFloat(7000).div(Dec.int(7)).toString()).toBe("1000.0");
    expect(Dec.int(1).div(Dec.int(3)).toString()).toBe("0.3333333333333333333333333333");
    expect(Dec.int(2).div(Dec.int(3)).toString()).toBe("0.6666666666666666666666666667");
    expect(Dec.parse("-2.5").ceilInt().toString()).toBe("-2");
    expect(Dec.parse("2.01").ceilInt().toString()).toBe("3");
    expect(() => Dec.parse("abc")).toThrow();
  });

  test("уровни: исчерпан, критический, предупреждение, в норме; пропуски", () => {
    const stage = (balance: string, spent: number) => {
      const v = budgetVerdict({ balance, spent, days: 7 }, SETTINGS);
      return v.kind === "alert" ? v.stage : v.kind;
    };
    expect(stage("0", 7000)).toBe("zero");
    expect(stage("-1", 7000)).toBe("zero");
    expect(stage("1000", 7000)).toBe("critical");
    expect(stage("1000.01", 7000)).toBe("warning");
    expect(stage("3000", 7000)).toBe("warning");
    expect(stage("3000.01", 7000)).toBe("ok");
    expect(stage("500", 0)).toBe("no_spend");
    expect(stage("500", -7)).toBe("no_spend");
    expect(budgetVerdict({ balance: null, spent: 7000, days: 7 }, SETTINGS).kind).toBe("skip");
    expect(budgetVerdict({ balance: "10", spent: 7000, days: 6 }, SETTINGS).kind).toBe("skip");
  });

  test("текст в Telegram — их формат", () => {
    expect(
      budgetAlertText({
        stage: "critical",
        name: "Кабинет",
        city: "",
        balance: "350",
        average_daily_spend: "176.3668285714285714285714286",
        forecast_days: "0.5669433464893544121270617943",
        recommended_topup: "1135",
      }),
    ).toBe(
      "🔶 Критический остаток\n\nКабинет: Кабинет\nГород: не назначен\nОстаток: 350.00 ₽\n" +
        "Средние траты: 176 ₽/день\nХватит примерно на: 0.6 дн.\n\n" +
        "Рекомендуем пополнить на 7 дней: 1135 ₽",
    );
  });

  test("настройки Telegram и чаты бота — их проверки", () => {
    const base = { token: "", botUsername: "", testChatId: "", gatewayUrl: "", gatewaySecret: "" };
    expect(
      tgSettingsCheck({
        ...base,
        botUsername: " @@Bot ",
        testChatId: " -100123 ",
        gatewayUrl: "https://tg.example.workers.dev//",
      }),
    ).toMatchObject({
      username: "Bot",
      chatId: "-100123",
      gateway: "https://tg.example.workers.dev",
    });
    expect(() => tgSettingsCheck({ ...base, testChatId: "12a" })).toThrow("только из цифр");
    expect(() => tgSettingsCheck({ ...base, token: "без двоеточия" })).toThrow(
      "Токен Telegram выглядит некорректно.",
    );
    for (const url of ["http://a.workers.dev", "https://example.com", "мусор"]) {
      expect(() => tgSettingsCheck({ ...base, gatewayUrl: url })).toThrow("*.workers.dev");
    }
    expect(() => tgSettingsCheck({ ...base, gatewaySecret: "короткий" })).toThrow(
      "Секрет шлюза слишком короткий.",
    );
    expect([tgChatIdOk("-1"), tgChatIdOk(""), tgChatIdOk("1".repeat(33))]).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      tgChatsFromUpdates([
        { message: { chat: { id: 5, type: "private", first_name: "Анна", last_name: "Б" } } },
        { my_chat_member: { chat: { id: -7, type: "group", title: "бета" } } },
        { channel_post: { chat: { id: -8, type: "channel", username: "Альфа" } } },
        { message: { chat: { id: 5, type: "private", username: "anna" } } },
        { edited_message: { chat: { id: 9 } } },
        "мусор",
      ]),
    ).toEqual([
      { id: "5", title: "anna", type: "private" },
      { id: "-8", title: "Альфа", type: "channel" },
      { id: "-7", title: "бета", type: "group" },
    ]);
  });
});
