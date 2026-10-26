import { describe, expect, test } from "bun:test";

import {
  checkPhone,
  emailError,
  emailSuggestion,
  formatPhoneDisplay,
  normalizeEmail,
  phoneCountries,
  phoneCountryOf,
  phoneForEditing,
} from "./contacts";

describe("checkPhone", () => {
  test("пусто", () => expect(checkPhone("  ").status).toBe("empty"));

  test("грузинский мобильный без кода — страна по умолчанию", () => {
    const r = checkPhone("555 12-34-56");
    expect(r).toMatchObject({ status: "valid", e164: "+995555123456", country: "GE" });
  });

  test("с «+» страна берётся из номера, выбранная не мешает", () => {
    expect(checkPhone("+7 916 123-45-67", "GE")).toMatchObject({
      status: "valid",
      e164: "+79161234567",
      country: "RU",
    });
  });

  test("00 в начале — то же, что «+»", () =>
    expect(checkPhone("00995555123456")).toMatchObject({ status: "valid", e164: "+995555123456" }));

  test("российский с 8 при выбранной России", () =>
    expect(checkPhone("8 (916) 123-45-67", "RU")).toMatchObject({
      status: "valid",
      e164: "+79161234567",
    }));

  test("код страны без «+» — ошибка с подсказкой страны", () => {
    const r = checkPhone("79161234567", "GE");
    expect(r.status).toBe("invalid");
    if (r.status !== "invalid") return;
    expect(r.suggestion).toMatchObject({ e164: "+79161234567", country: "RU" });
  });

  test("неполный номер", () => {
    const r = checkPhone("555 12");
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(r.error).toContain("неполный");
  });

  test("буквы", () => expect(checkPhone("555 abc").status).toBe("invalid"));
});

describe("телефон в базе", () => {
  test("E.164 → поле: национальный вид у своей страны", () => {
    const r = phoneForEditing("+79161234567");
    expect(r.country).toBe("RU");
    expect(checkPhone(r.value, r.country)).toMatchObject({ e164: "+79161234567" });
  });

  test("старая запись без кода — как есть", () =>
    expect(phoneForEditing("12345")).toEqual({ value: "12345", country: "GE" }));

  test("показ в таблице", () => {
    expect(formatPhoneDisplay("+995555123456")).toBe("+995 555 12 34 56");
    expect(formatPhoneDisplay("8-916-старый")).toBe("8-916-старый");
    expect(formatPhoneDisplay(null)).toBe("");
  });

  test("страна по набранному «+»", () => {
    expect(phoneCountryOf("+37529")).toBe("BY");
    expect(phoneCountryOf("555")).toBeUndefined();
  });

  test("список стран: Грузия первой, у всех код", () => {
    const list = phoneCountries();
    expect(list[0].code).toBe("GE");
    expect(list.every((c) => c.dial.startsWith("+"))).toBe(true);
  });
});

describe("email", () => {
  test("нормализация", () => expect(normalizeEmail(" Anna.K@Gmail.com ")).toBe("anna.k@gmail.com"));

  test("верные", () => {
    for (const v of ["a@b.co", "anna.k+gym@mail.ru", "x_y-z@sub.domain.ge"])
      expect(emailError(v)).toBeNull();
  });

  test("ошибки", () => {
    expect(emailError("anna.gmail.com")).toContain("@");
    expect(emailError("anna@gmail")).toContain("домена");
    expect(emailError("анна@mail.ru")).toContain("раскладку");
    expect(emailError("a@@b.ru")).not.toBeNull();
    expect(emailError("a..b@mail.ru")).not.toBeNull();
    expect(emailError("a@mail.r")).not.toBeNull();
    expect(emailError("")).toBeNull();
  });

  test("опечатки в домене", () => {
    expect(emailSuggestion("anna@gmial.com")).toBe("anna@gmail.com");
    expect(emailSuggestion("anna@mail.ry")).toBe("anna@mail.ru");
    expect(emailSuggestion("anna@gmail.com")).toBeNull();
  });
});
