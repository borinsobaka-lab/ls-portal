import { describe, expect, test } from "bun:test";

import { APP_VERSION, nextAppVersion } from "./app-version";

describe("nextAppVersion", () => {
  test("младшая часть растёт до 99, затем — следующая старшая", () => {
    expect(nextAppVersion("1.0")).toBe("1.1");
    expect(nextAppVersion("1.9")).toBe("1.10");
    expect(nextAppVersion("1.98")).toBe("1.99");
    expect(nextAppVersion("1.99")).toBe("2.0");
    expect(nextAppVersion("2.99")).toBe("3.0");
  });

  test("неверная строка — ошибка", () => {
    expect(() => nextAppVersion("1.0.0")).toThrow();
    expect(() => nextAppVersion("v1")).toThrow();
  });

  test("текущая версия — в формате «N.M»", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d{1,2}$/);
  });
});
