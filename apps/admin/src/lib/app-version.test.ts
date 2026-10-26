import { describe, expect, test } from "bun:test";

import { ADMIN_VERSION, nextAdminVersion } from "./app-version";

describe("nextAdminVersion", () => {
  test("младшая часть растёт до 99, затем — следующая старшая", () => {
    expect(nextAdminVersion("1.0")).toBe("1.1");
    expect(nextAdminVersion("1.9")).toBe("1.10");
    expect(nextAdminVersion("1.98")).toBe("1.99");
    expect(nextAdminVersion("1.99")).toBe("2.0");
    expect(nextAdminVersion("2.99")).toBe("3.0");
  });

  test("неверная строка — ошибка", () => {
    expect(() => nextAdminVersion("1.0.0")).toThrow();
    expect(() => nextAdminVersion("v1")).toThrow();
  });

  test("текущая версия — в формате «N.M»", () => {
    expect(ADMIN_VERSION).toMatch(/^\d+\.\d{1,2}$/);
  });
});
