/**
 * Ключи интеграций «Аналитики» (токены VK Ads, amoCRM, Авито, FitBase,
 * сообществ VK, Telegram, Google) — таблица an_secrets, только сервер
 * (service_role, ни грантов, ни политик для браузера). Шифр — AES-256-GCM,
 * ключ — ANALYTICS_SECRETS_KEY (Coolify): 32 байта в base64 или любая строка
 * от 32 символов (тогда ключ — её SHA-256). Хранение:
 * base64(iv 12 ‖ шифртекст ‖ тег 16). Ключи вводят в «Аналитике» заново —
 * со старым порталом новый не связан (ANALYTICS_PLAN.md, §3).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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

/** Двоичные данные (кэш выгрузок): iv 12 ‖ шифртекст ‖ тег 16. */
export function encryptBytes(plain: Buffer): Buffer {
  const key = secretsKey();
  if (!key) throw new Error("На сервере не задан ANALYTICS_SECRETS_KEY (от 32 символов).");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function decryptBytes(raw: Buffer): Buffer {
  const key = secretsKey();
  if (!key) throw new Error("На сервере не задан ANALYTICS_SECRETS_KEY (от 32 символов).");
  if (raw.length < 28) throw new Error("Зашифрованные данные повреждены.");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
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
