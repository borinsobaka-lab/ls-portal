/**
 * Ключи интеграций «Аналитики» (токены VK Ads, amoCRM, Авито, FitBase,
 * сообществ VK, Telegram, Google) — таблица an_secrets, только сервер
 * (service_role, ни грантов, ни политик для браузера). Шифр — AES-256-GCM,
 * ключ — ANALYTICS_SECRETS_KEY (Coolify): 32 байта в base64 или любая строка
 * от 32 символов (тогда ключ — её SHA-256). Хранение:
 * base64(iv 12 ‖ шифртекст ‖ тег 16).
 *
 * Ключи от старого портала агент синхронизации присылает зашифрованными
 * открытым ключом портала (ANALYTICS_REPLICA_PRIVATE_KEY, RSA-OAEP-SHA256,
 * блоками) — их расшифровывает decryptFromAgent и сразу шифрует своим ключом.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { constants, createPrivateKey, createPublicKey } from "node:crypto";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";

function secretsKey(): Buffer | null {
  const raw = process.env.ANALYTICS_SECRETS_KEY?.trim();
  if (!raw) return null;
  const decoded = /^[A-Za-z0-9+/=]+$/.test(raw) ? Buffer.from(raw, "base64") : null;
  if (decoded && decoded.length === 32) return decoded;
  if (raw.length < 32) return null;
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Задан ли ключ шифрования (иначе ключи интеграций не сохранить). */
export function secretsReady(): boolean {
  return secretsKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = secretsKey();
  if (!key) throw new Error("На сервере не задан ANALYTICS_SECRETS_KEY (от 32 символов).");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const key = secretsKey();
  if (!key) throw new Error("На сервере не задан ANALYTICS_SECRETS_KEY (от 32 символов).");
  const raw = Buffer.from(stored, "base64");
  if (raw.length < 29) throw new Error("Зашифрованный ключ повреждён.");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([
    decipher.update(raw.subarray(12, raw.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

export type SecretRef = { kind: string; ref: string; name: string };

export async function saveSecret(s: SecretRef, plain: string, userId: string | null = null) {
  const { error } = await getSupabaseAdmin()
    .from("an_secrets")
    .upsert(
      {
        kind: s.kind,
        ref: s.ref,
        name: s.name,
        ciphertext: encryptSecret(plain),
        updated_at: new Date().toISOString(),
        updated_by: userId,
      },
      { onConflict: "kind,ref,name" },
    );
  if (error) throw new Error(error.message);
}

export async function readSecret(s: SecretRef): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("an_secrets")
    .select("ciphertext")
    .eq("kind", s.kind)
    .eq("ref", s.ref)
    .eq("name", s.name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? decryptSecret(data.ciphertext as string) : null;
}

// --- Ключи от агента синхронизации ------------------------------------------------

function replicaPrivateKey() {
  const pem = process.env.ANALYTICS_REPLICA_PRIVATE_KEY?.trim();
  if (!pem) return null;
  // В Coolify перевод строки в значении иногда приходит как \n.
  return createPrivateKey(pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem);
}

/** Открытый ключ для установки агента (PEM) или null, если не задан закрытый. */
export function replicaPublicKeyPem(): string | null {
  const key = replicaPrivateKey();
  if (!key) return null;
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

/**
 * Расшифровать ключ от агента: блоки RSA-OAEP-SHA256 в base64 через «.»
 * (`openssl pkeyutl -encrypt -pkeyopt rsa_padding_mode:oaep
 * -pkeyopt rsa_oaep_md:sha256` по 190 байт).
 */
export function decryptFromAgent(blocks: string): string {
  const key = replicaPrivateKey();
  if (!key) throw new Error("На сервере не задан ANALYTICS_REPLICA_PRIVATE_KEY.");
  const parts = blocks.split(".").filter(Boolean);
  if (parts.length === 0 || parts.length > 64) throw new Error("Неверный формат ключа от агента.");
  return Buffer.concat(
    parts.map((p) =>
      privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(p, "base64"),
      ),
    ),
  ).toString("utf8");
}
