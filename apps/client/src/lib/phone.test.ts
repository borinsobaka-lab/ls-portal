import { describe, expect, test } from "bun:test";

import { applyNationalInput, formatPhone, isValidPhone, maskRemainder, parsePhone } from "./phone";

describe("parsePhone", () => {
  test("пусто — Грузия по умолчанию", () => {
    expect(parsePhone("")).toEqual({ code: "995", national: "" });
  });
  test("международный формат", () => {
    expect(parsePhone("+995 555 12 34 56")).toEqual({ code: "995", national: "555123456" });
    expect(parsePhone("+7 916 123-45-67")).toEqual({ code: "7", national: "9161234567" });
    expect(parsePhone("+374 91 123456")).toEqual({ code: "374", national: "91123456" });
    expect(parsePhone("00995555123456")).toEqual({ code: "995", national: "555123456" });
  });
  test("грузинский без «+» и без кода", () => {
    expect(parsePhone("995555123456")).toEqual({ code: "995", national: "555123456" });
    expect(parsePhone("555 123 456")).toEqual({ code: "995", national: "555123456" });
    expect(parsePhone("0555123456")).toEqual({ code: "995", national: "555123456" });
  });
  test("непонятный номер не теряется", () => {
    expect(parsePhone("89161234567")).toEqual({ code: "", national: "89161234567" });
  });
});

describe("маска", () => {
  test("формат и остаток", () => {
    expect(formatPhone({ code: "995", national: "5910997" })).toBe("+995 591 09 97");
    expect(maskRemainder("995", "5910997")).toBe(" __");
    expect(maskRemainder("995", "")).toBe("___ __ __ __");
    expect(maskRemainder("7", "916")).toBe("");
  });
});

describe("ввод номера", () => {
  test("лишние цифры отрезаются по маске", () => {
    expect(applyNationalInput("995", "5551234569")).toEqual({
      code: "995",
      national: "555123456",
    });
  });
  test("автоподстановка номера целиком меняет код", () => {
    expect(applyNationalInput("995", "+7 916 123 45 67")).toEqual({
      code: "7",
      national: "9161234567",
    });
    expect(applyNationalInput("995", "+995555123456")).toEqual({
      code: "995",
      national: "555123456",
    });
  });
});

describe("isValidPhone", () => {
  test("грузинский — ровно 9 цифр", () => {
    expect(isValidPhone("+995 555 12 34 56")).toBe(true);
    expect(isValidPhone("+995 591 09 97")).toBe(false);
  });
  test("другие страны — 6–12 цифр", () => {
    expect(isValidPhone("+7 9161234567")).toBe(true);
    expect(isValidPhone("+7 916")).toBe(false);
  });
  test("без кода — нет", () => {
    expect(isValidPhone("89161234567")).toBe(false);
    expect(isValidPhone("")).toBe(false);
  });
});
