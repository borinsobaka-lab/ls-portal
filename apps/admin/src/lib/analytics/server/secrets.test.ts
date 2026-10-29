import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, publicEncrypt } from "node:crypto";

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

  test("ключ от агента: блоки RSA-OAEP-SHA256 через точку", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ANALYTICS_REPLICA_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString()
      .replace(/\n/g, "\\n");
    const { decryptFromAgent, replicaPublicKeyPem } = await import("./secrets.server");
    expect(replicaPublicKeyPem()).toContain("BEGIN PUBLIC KEY");
    const plain = Buffer.from("я".repeat(150), "utf8"); // 300 байт — два блока
    const blocks = [plain.subarray(0, 190), plain.subarray(190)].map((part) =>
      publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        part,
      ).toString("base64"),
    );
    expect(decryptFromAgent(blocks.join("."))).toBe("я".repeat(150));
    delete process.env.ANALYTICS_REPLICA_PRIVATE_KEY;
  });
});
