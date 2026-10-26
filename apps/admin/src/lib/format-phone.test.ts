import { describe, expect, test } from "bun:test";

import { formatPhoneDisplay } from "./contacts";
import { formatPhone } from "./format";

describe("formatPhone", () => {
  test("совпадает с formatPhoneDisplay у грузинских мобильных и российских", () => {
    for (const p of ["+995555123456", "+995599000111", "+79161234567"]) {
      expect(formatPhone(p)).toBe(formatPhoneDisplay(p));
    }
  });

  test("прочее — как записано", () => {
    expect(formatPhone("+380501234567")).toBe("+380501234567");
    expect(formatPhone("8-916-старый")).toBe("8-916-старый");
    expect(formatPhone(null)).toBe("");
  });
});
