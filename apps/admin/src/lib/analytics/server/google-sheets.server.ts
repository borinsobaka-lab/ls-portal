/**
 * Google Sheets — их google_sheets.py: сервисный аккаунт (JSON-ключ), токен
 * по JWT RS256, метаданные таблицы и чтение значений (FORMATTED_VALUE).
 * Ключ — an_secrets (kind 'google', ref 'sheets', name 'service_account'),
 * его загружают на странице «Источники СС»; наружу он не отдаётся и в
 * журнал не пишется. Тексты ошибок — их.
 */
import { createPrivateKey, sign } from "node:crypto";

import { pyQuoteRange, ssCheckId } from "../vk/ss";
import { readSecret } from "./secrets.server";

export const GOOGLE_SA_SECRET = { kind: "google", ref: "sheets", name: "service_account" };
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Другой адрес Google (токен и таблицы) — только для тестового стенда. */
const testOrigin = () => process.env.ANALYTICS_GOOGLE_ORIGIN?.replace(/\/+$/, "") || null;
const tokenUrl = () => `${testOrigin() ?? "https://oauth2.googleapis.com"}/token`;
const sheetsUrl = (path: string) => `${testOrigin() ?? "https://sheets.googleapis.com"}${path}`;

export type GoogleServiceAccount = { client_email: string; private_key: string };

/** Их _credentials: client_email и private_key — непустые строки. */
export function parseServiceAccount(json: string): GoogleServiceAccount {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("Ключ Google Sheets повреждён: нужен JSON-файл сервисного аккаунта.");
  }
  const p = payload as Record<string, unknown> | null;
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.client_email !== "string" ||
    !p.client_email ||
    typeof p.private_key !== "string" ||
    !p.private_key
  ) {
    throw new Error("Ключ Google Sheets не содержит обязательных полей.");
  }
  try {
    createPrivateKey(p.private_key);
  } catch {
    throw new Error("Не удалось подписать запрос к Google Sheets.");
  }
  return { client_email: p.client_email, private_key: p.private_key };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Заявка на токен: JWT RS256 (iss, scope, aud, iat, exp — на час). */
export function serviceAccountAssertion(sa: GoogleServiceAccount, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUrl(), iat, exp: iat + 3600 }),
  );
  const unsigned = `${header}.${claims}`;
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), sa.private_key);
  } catch {
    throw new Error("Не удалось подписать запрос к Google Sheets.");
  }
  return `${unsigned}.${b64url(signature)}`;
}

/** Клиент таблиц одного запуска: токен берётся один раз. */
export type SheetsClient = {
  metadata: (id: string) => Promise<{ title: string; sheets: string[] }>;
  values: (id: string, range: string) => Promise<string[][]>;
};

export async function sheetsClient(): Promise<SheetsClient> {
  const json = await readSecret(GOOGLE_SA_SECRET);
  if (!json) {
    throw new Error("Ключ Google Sheets не задан: добавьте его на странице «Источники СС».");
  }
  let sa: GoogleServiceAccount;
  try {
    sa = parseServiceAccount(json);
  } catch (e) {
    const m = (e as Error).message;
    throw new Error(
      m.includes("обязательных полей")
        ? m
        : "Ключ Google Sheets на сервере не найден или повреждён.",
    );
  }
  let token: string | null = null;
  const accessToken = async () => {
    if (token) return token;
    let payload: { access_token?: unknown };
    try {
      const res = await fetch(tokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
          encodeURIComponent(serviceAccountAssertion(sa)),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      payload = (await res.json()) as { access_token?: unknown };
    } catch {
      throw new Error("Не удалось получить доступ к Google Sheets.");
    }
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error("Google Sheets не выдал токен доступа.");
    }
    token = payload.access_token;
    return token;
  };
  const get = async (url: string, timeoutMs: number) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async metadata(rawId) {
      const id = ssCheckId(rawId);
      const url = sheetsUrl(`/v4/spreadsheets/${id}?includeGridData=false`);
      await accessToken();
      let res: Response;
      let payload: { properties?: { title?: unknown }; sheets?: unknown };
      try {
        res = await get(url, 20_000);
      } catch {
        throw new Error("Не удалось подключиться к Google Sheets.");
      }
      if (res.status === 404) {
        throw new Error(
          "Таблица не найдена: проверьте, что сервисный аккаунт добавлен редактором.",
        );
      }
      if (res.status === 403) throw new Error("У сервисного аккаунта нет доступа к таблице.");
      if (!res.ok) throw new Error(`Google Sheets вернул HTTP ${res.status}.`);
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        throw new Error("Не удалось подключиться к Google Sheets.");
      }
      const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
      return {
        title: String(payload.properties?.title ?? ""),
        sheets: sheets.map((s) =>
          String((s as { properties?: { title?: unknown } })?.properties?.title ?? ""),
        ),
      };
    },
    async values(rawId, range) {
      const id = ssCheckId(rawId);
      const url = sheetsUrl(
        `/v4/spreadsheets/${id}/values/${pyQuoteRange(range)}?valueRenderOption=FORMATTED_VALUE`,
      );
      await accessToken();
      let res: Response;
      let payload: { values?: unknown };
      try {
        res = await get(url, 45_000);
      } catch {
        throw new Error("Не удалось прочитать данные Google Таблицы.");
      }
      if (!res.ok) throw new Error(`Google Sheets вернул HTTP ${res.status} при чтении таблицы.`);
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        throw new Error("Не удалось прочитать данные Google Таблицы.");
      }
      if (!Array.isArray(payload.values)) return [];
      return payload.values
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map((cell) => String(cell)));
    },
  };
}
