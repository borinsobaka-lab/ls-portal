import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * Пароли входа по логину Platrum (db/migrations/2026-11-01_zz_portal_logins.sql).
 * Хэш — scrypt (node:crypto, без библиотек): `scrypt$N$r$p$соль$хэш`,
 * соль и хэш — base64. Сам пароль нигде не хранится и не логируется.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(
      password.normalize("NFC"),
      salt,
      KEY_LEN,
      { N: n, r, p, maxmem: 256 * n * r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20) return false;
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length !== KEY_LEN) return false;
  const key = await derive(password, Buffer.from(parts[4], "base64"), n, r, p);
  return timingSafeEqual(key, expected);
}

/**
 * Ограничитель попыток входа по логину с одного адреса (в памяти процесса,
 * в дополнение к закрытию логина после 10 неверных паролей в базе): перебор
 * паролей по разным логинам. Не больше `limit` попыток за `windowMs`.
 */
export function createAttemptLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    /** true — попытку можно делать (и она засчитана). */
    take(key: string, now = Date.now()): boolean {
      const fresh = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (fresh.length >= limit) {
        hits.set(key, fresh);
        return false;
      }
      fresh.push(now);
      hits.set(key, fresh);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}
