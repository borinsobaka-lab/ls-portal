import { describe, expect, test } from "bun:test";

import { createAttemptLimiter, hashPassword, verifyPassword } from "./password.server";

describe("пароли входа по логину", () => {
  test("хэш проверяется, чужой пароль — нет", async () => {
    const hash = await hashPassword("Platrum-123");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(hash).not.toContain("Platrum-123");
    expect(await verifyPassword("Platrum-123", hash)).toBe(true);
    expect(await verifyPassword("platrum-123", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  test("у одинаковых паролей разные хэши (соль)", async () => {
    expect(await hashPassword("x1234")).not.toBe(await hashPassword("x1234"));
  });

  test("испорченный хэш — не пускает", async () => {
    expect(await verifyPassword("a", "")).toBe(false);
    expect(await verifyPassword("a", "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword("a", "scrypt$abc$8$1$AAAA$BBBB")).toBe(false);
  });

  test("ограничитель попыток", () => {
    const l = createAttemptLimiter(2, 1000);
    expect(l.take("ip", 0)).toBe(true);
    expect(l.take("ip", 10)).toBe(true);
    expect(l.take("ip", 20)).toBe(false);
    expect(l.take("other", 20)).toBe(true);
    expect(l.take("ip", 1500)).toBe(true);
  });
});
