import { describe, expect, test } from "bun:test";

import {
  QUIZ_HEADERS,
  QUIZ_TEXT,
  quizClean,
  quizLeadFromPayload,
  quizPayload,
  quizPhoneHref,
  quizResultText,
  quizSheetRow,
  quizSpreadsheetId,
  quizUtmFromSearch,
  type QuizPendingLead,
} from "./rules";

const lead = (over: Record<string, unknown> = {}) => ({
  city: "Тестоград",
  name: "Анна",
  phone: "+7 (900) 000-00-00",
  consentAt: "2026-10-30T10:00:00.000Z",
  answers: { pain: "Спина", duration: "Давно", barrier: "Время" },
  recommendation: "Здоровая спина",
  utm: { utm_source: "vk" },
  ...over,
});

describe("их _clean", () => {
  test("пробелы подряд — один, края — без пробелов, Unicode-пробелы Python", () => {
    expect(quizClean("  Анна \n\t Мария\u00a0\u3000 ")).toBe("Анна Мария");
    expect(quizClean("a\u001fb")).toBe("a b");
    // \ufeff у Python — не пробел.
    expect(quizClean("\ufeffa")).toBe("\ufeffa");
  });
  test("str(value or ''): пустое и ложное — «», True, числа", () => {
    expect(quizClean(null)).toBe("");
    expect(quizClean(0)).toBe("");
    expect(quizClean(false)).toBe("");
    expect(quizClean(true)).toBe("True");
    expect(quizClean(42)).toBe("42");
  });
  test("обрезка по знакам, а не по UTF-16", () => {
    expect(quizClean("😀".repeat(5), 3)).toBe("😀😀😀");
    expect(quizClean("x".repeat(400))).toHaveLength(300);
  });
});

describe("приём заявки (их app.py и quiz_leads.create)", () => {
  test("согласие, имя и телефон — их тексты", () => {
    expect(() => quizLeadFromPayload([])).toThrow(QUIZ_TEXT.consent);
    expect(() => quizLeadFromPayload(lead({ consentAt: "" }))).toThrow(QUIZ_TEXT.consent);
    expect(() => quizLeadFromPayload(lead({ consentAt: "   " }))).toThrow(QUIZ_TEXT.consent);
    expect(() => quizLeadFromPayload(lead({ city: " " }))).toThrow(QUIZ_TEXT.nameOrPhone);
    expect(() => quizLeadFromPayload(lead({ name: " А " }))).toThrow(QUIZ_TEXT.nameOrPhone);
    expect(() => quizLeadFromPayload(lead({ phone: "8 900 000 00" }))).toThrow(
      QUIZ_TEXT.nameOrPhone,
    );
    // Пустое имя важнее пустого согласия после очистки — порядок их проверок.
    expect(() => quizLeadFromPayload(lead({ name: "", consentAt: "  " }))).toThrow(
      QUIZ_TEXT.nameOrPhone,
    );
  });
  test("цифры телефона — любые десятичные Unicode (их \\D)", () => {
    expect(quizLeadFromPayload(lead({ phone: "٠١٢٣٤٥٦٧٨٩" })).phone).toBe("٠١٢٣٤٥٦٧٨٩");
  });
  test("поля очищаются, телефон — до 40, согласие — до 80 знаков", () => {
    const r = quizLeadFromPayload(
      lead({
        name: "  Анна   Иванова ",
        phone: `+7 900 000 00 00 ${"9".repeat(40)}`,
        consentAt: "x".repeat(100),
      }),
    );
    expect(r.name).toBe("Анна Иванова");
    expect(Array.from(r.phone)).toHaveLength(40);
    expect(r.consentAt).toHaveLength(80);
    expect(r.pain).toBe("Спина");
    expect(r.recommendation).toBe("Здоровая спина");
  });
  test("ответы не словарём — пусто", () => {
    const r = quizLeadFromPayload(lead({ answers: ["a"] }));
    expect([r.pain, r.duration, r.barrier]).toEqual(["", "", ""]);
  });
  test("UTM: только utm_*, пустые значения — нет, ключ до 40, значение до 200", () => {
    const r = quizLeadFromPayload(
      lead({
        utm: {
          utm_source: " vk ",
          utm_medium: "  ",
          gclid: "x",
          [`utm_${"k".repeat(50)}`]: "v",
          utm_term: "t".repeat(250),
          utm_content: 0,
        },
      }),
    );
    expect(r.utm).toEqual({
      utm_source: "vk",
      [`utm_${"k".repeat(36)}`]: "v",
      utm_term: "t".repeat(200),
    });
    expect(quizLeadFromPayload(lead({ utm: "utm_source=vk" })).utm).toEqual({});
  });
});

describe("строка таблицы (их _row_values)", () => {
  const row: QuizPendingLead = {
    id: 17,
    created_at: "2026-10-30T21:05:59.900Z",
    city: "Тестоград",
    name: "Анна",
    phone: "+7 900",
    recommendation: "Здоровая спина",
    pain: "Спина",
    duration: "Давно",
    barrier: "Время",
    utm: { utm_campaign: "osen", utm_source: "vk", other: "x" },
    consent_at: "2026-10-30T21:05:58.000Z",
    spreadsheet_id: "id",
    sheet_name: "Заявки квиза",
  };
  test("16 колонок A:P, время — по Москве, UTM — по их порядку", () => {
    expect(QUIZ_HEADERS).toHaveLength(16);
    expect(quizSheetRow(row)).toEqual([
      "31.10.2026 00:05",
      "Тестоград",
      "Анна",
      "+7 900",
      "Здоровая спина",
      "Спина",
      "Давно",
      "Время",
      "vk",
      "",
      "osen",
      "",
      "",
      "",
      "2026-10-30T21:05:58.000Z",
      "17",
    ]);
  });
});

describe("лендинг (их app.js)", () => {
  test("рекомендация — по первому ответу, довод — по третьему", () => {
    expect(quizResultText({ pain: "back", duration: "year", barrier: "group" })).toBe(
      "Рекомендуем направление — Здоровая спина. У нас мини-группы до 8 человек: тренер видит и поправляет каждую.",
    );
  });
  test("заявка: ответы короткими фразами, их поля", () => {
    const p = quizPayload({
      name: " Анна ",
      phone: " +7 900 000 00 00 ",
      city: "Тестоград",
      citySlug: "test",
      landingVersion: "v1",
      landingPath: "/quiz/test",
      answers: { pain: "energy", duration: "months", barrier: "plan" },
      utm: { utm_source: "vk" },
      consentAt: "2026-10-30T10:00:00.000Z",
    });
    expect(p).toEqual({
      name: "Анна",
      phone: "+7 900 000 00 00",
      city: "Тестоград",
      citySlug: "test",
      source: "quiz",
      landingVersion: "v1",
      landingPath: "/quiz/test",
      consentAt: "2026-10-30T10:00:00.000Z",
      answers: {
        pain: "Постоянная усталость и мало энергии",
        duration: "Несколько месяцев пытается изменить ситуацию",
        barrier: "Не было понятного плана",
      },
      recommendation: "Функциональные петли или СТЕП-аэробика",
      utm: { utm_source: "vk" },
    });
    // Их заявку принимает их же проверка.
    expect(quizLeadFromPayload(p).pain).toBe("Постоянная усталость и мало энергии");
  });
  test("UTM из адреса, телефон студии, ID таблицы", () => {
    expect(quizUtmFromSearch("?utm_source=vk&x=1&utm_source=tg&utm_term=a%20b")).toEqual({
      utm_source: "tg",
      utm_term: "a b",
    });
    expect(quizPhoneHref("+7 (962) 000-00-00")).toBe("tel:+79620000000");
    expect(quizPhoneHref("")).toBe("");
    expect(quizSpreadsheetId("https://docs.google.com/spreadsheets/d/Ab-1_x/edit#gid=0")).toBe(
      "Ab-1_x",
    );
    expect(quizSpreadsheetId(" Ab-1_x ")).toBe("Ab-1_x");
  });
});
