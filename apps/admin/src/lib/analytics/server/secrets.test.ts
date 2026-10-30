import { describe, expect, test } from "bun:test";

describe("ключи интеграций аналитики", () => {
  test("AES-256-GCM: зашифровать и расшифровать; без ключа — понятная ошибка", async () => {
    process.env.ANALYTICS_SECRETS_KEY = "k".repeat(40);
    const { decryptSecret, encryptSecret, secretsReady } = await import("./secrets.server");
    expect(secretsReady()).toBe(true);
    const stored = encryptSecret("токен VK Ads");
    expect(stored).not.toContain("токен");
    expect(decryptSecret(stored)).toBe("токен VK Ads");
    expect(encryptSecret("a")).not.toBe(encryptSecret("a"));
    const broken = Buffer.from(stored, "base64");
    broken[20] ^= 1;
    expect(() => decryptSecret(broken.toString("base64"))).toThrow();
    delete process.env.ANALYTICS_SECRETS_KEY;
    expect(secretsReady()).toBe(false);
    expect(() => encryptSecret("a")).toThrow("ANALYTICS_SECRETS_KEY");
  });
});
