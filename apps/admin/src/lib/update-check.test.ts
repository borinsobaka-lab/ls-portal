import { describe, expect, test } from "bun:test";

import { isNewerVersion, isStaleChunkError } from "./update-check";

describe("update-check", () => {
  test("ошибки загрузки куска сборки в разных браузерах", () => {
    expect(
      isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/a.js")),
    ).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isStaleChunkError(new Error("Не удалось загрузить пользователей"))).toBe(false);
  });
  test("версия", () => {
    expect(isNewerVersion("1.7", "1.8")).toBe(true);
    expect(isNewerVersion("1.7", "1.7")).toBe(false);
    expect(isNewerVersion("1.7", undefined)).toBe(false);
  });
});
