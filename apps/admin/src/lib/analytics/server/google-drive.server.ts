/**
 * Google Drive — их google_drive.py: вход владельца таблиц через OAuth
 * (постоянный доступ — refresh token) и создание Google-таблицы в папке.
 * OAuth-клиент (JSON из Google Cloud) и постоянный доступ — an_secrets
 * (kind 'google', ref 'drive'); их загружает и подключает администратор на
 * странице «Сбор лид-форм». Тексты ошибок — их.
 */
import { readSecret } from "./secrets.server";

export const DRIVE_CLIENT_SECRET = { kind: "google", ref: "drive", name: "oauth_client" };
export const DRIVE_TOKEN_SECRET = { kind: "google", ref: "drive", name: "refresh_token" };
const SCOPE =
  "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets";

/** Другой адрес Google — только для тестового стенда (как у Sheets). */
const testOrigin = () => process.env.ANALYTICS_GOOGLE_ORIGIN?.replace(/\/+$/, "") || null;
const tokenUrl = () => `${testOrigin() ?? "https://oauth2.googleapis.com"}/token`;
const authUrl = () => `${testOrigin() ?? "https://accounts.google.com"}/o/oauth2/v2/auth`;
const driveUrl = (path: string) => `${testOrigin() ?? "https://www.googleapis.com"}${path}`;

/** Адрес возврата после входа Google: страница «Сбор лид-форм» портала. */
export function driveRedirectUri(): string {
  const base = process.env.ADMIN_APP_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("На сервере не задан ADMIN_APP_URL.");
  return `${base}/analytics/vk/lead-forms`;
}

export type DriveClient = { client_id: string; client_secret: string };

/** Их client_config: JSON OAuth-клиента (ключ «web» или верхний уровень). */
export function parseDriveClient(json: string): DriveClient {
  let item: Record<string, unknown>;
  try {
    const payload = JSON.parse(json) as Record<string, unknown>;
    item = (payload.web ?? payload) as Record<string, unknown>;
    if (!item || typeof item !== "object" || !("client_id" in item) || !("client_secret" in item)) {
      throw new Error();
    }
  } catch {
    throw new Error("OAuth-файл Google Drive не установлен на сервере.");
  }
  const id = String(item.client_id ?? "");
  const secret = String(item.client_secret ?? "");
  if (!id || !secret) throw new Error("OAuth-файл Google Drive повреждён.");
  return { client_id: id, client_secret: secret };
}

async function clientConfig(): Promise<DriveClient> {
  const json = await readSecret(DRIVE_CLIENT_SECRET);
  if (!json) throw new Error("OAuth-файл Google Drive не установлен на сервере.");
  return parseDriveClient(json);
}

export async function driveAuthorizationUrl(state: string): Promise<string> {
  const c = await clientConfig();
  return `${authUrl()}?${new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: driveRedirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString()}`;
}

async function tokenRequest(values: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error("Не удалось подключиться к Google Drive.");
  }
  if (!res.ok) throw new Error("Google отклонил подключение к Drive. Повторите вход.");
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error("Не удалось подключиться к Google Drive.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Google Drive вернул некорректный ответ.");
  }
  return payload as Record<string, unknown>;
}

/** Их exchange_code: код входа → постоянный доступ. */
export async function driveExchangeCode(code: string): Promise<string> {
  const c = await clientConfig();
  const p = await tokenRequest({
    code,
    redirect_uri: driveRedirectUri(),
    grant_type: "authorization_code",
    ...c,
  });
  if (typeof p.refresh_token !== "string" || !p.refresh_token) {
    throw new Error(
      "Google не выдал постоянный доступ. Нажмите «Подключить Google Drive» ещё раз.",
    );
  }
  return p.refresh_token;
}

async function accessToken(refreshToken: string): Promise<string> {
  const c = await clientConfig();
  const p = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token", ...c });
  if (typeof p.access_token !== "string" || !p.access_token) {
    throw new Error("Не удалось обновить доступ к Google Drive. Подключите его заново.");
  }
  return p.access_token;
}

/** Постоянный доступ Drive (их google_drive_refresh_token). */
export async function driveRefreshToken(): Promise<string> {
  let token: string | null;
  try {
    token = await readSecret(DRIVE_TOKEN_SECRET);
  } catch {
    throw new Error(
      "Сохранённое подключение Google Drive не удалось расшифровать. Нажмите «Переподключить Google Drive», войдите в Google и повторите создание таблиц. Существующие таблицы сохраняются.",
    );
  }
  if (!token) throw new Error("Сначала подключите Google Drive.");
  return token;
}

/** Их create_spreadsheet: новая Google-таблица в папке; ID таблицы. */
export async function driveCreateSpreadsheet(
  refreshToken: string,
  folderId: string,
  title: string,
): Promise<string> {
  const access = await accessToken(refreshToken);
  let res: Response;
  try {
    res = await fetch(driveUrl("/drive/v3/files?fields=id"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [folderId],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Не удалось создать Google Таблицу.");
  }
  if (!res.ok) throw new Error(`Google Drive вернул HTTP ${res.status}.`);
  let payload: { id?: unknown };
  try {
    payload = (await res.json()) as { id?: unknown };
  } catch {
    throw new Error("Не удалось создать Google Таблицу.");
  }
  const id = String(payload.id ?? "");
  if (!id) throw new Error("Google Drive не вернул ID созданной таблицы.");
  return id;
}
