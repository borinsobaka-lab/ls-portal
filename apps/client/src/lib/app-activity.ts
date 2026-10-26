import { APP_FORMAT } from "@/lib/app-format";
import { APP_VERSION } from "@/lib/app-version";
import {
  deviceModelLabel,
  iphoneModelByScreen,
  mergeClientHints,
  parseUserAgent,
  type ClientHints,
} from "@/lib/device-info";
import { readPushDevice, readPushPermission } from "@/lib/push";
import { isInstalledDisplay } from "@/lib/pwa-install";
import { untypedDb } from "@/lib/untyped-db";
import type { Locale } from "@/i18n";

/**
 * Устройство и активность клиента в приложении (решение владельца
 * 2026-10-15) — вкладка «Приложение» в карточке клиента админки. Приложение
 * само сообщает базе (RPC app_ping, db/migrations/2026-10-15_zzzzz_client_app_activity.sql):
 * что за устройство (lib/device-info.ts), версию приложения, установлено ли
 * оно, разрешены ли уведомления, язык, и какие разделы клиент открывал с
 * прошлого раза. Когда открыли приложение и сколько раз — считает база
 * (новое открытие — после 30 минут без активности). Хук —
 * hooks/use-app-activity.ts в AppShell.
 *
 * - Id устройства — случайный, хранится на телефоне (у установленного
 *   приложения своё хранилище): так база отличает телефоны одного клиента.
 * - Просмотры разделов копятся на телефоне (localStorage) и уходят со
 *   следующим пингом: нет сети или база без миграции — дождутся.
 * - Любая ошибка молча откладывает отправку: это статистика, а не работа
 *   приложения.
 */

const DEVICE_KEY = "base40.deviceId";
const PENDING_KEY = "base40.activity";

/** Больше этого за раз раздел не накапливает (база тоже режет до 1000). */
const MAX_PENDING = 1000;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // приватный режим — обойдёмся без памяти
  }
}

let memoryDeviceId: string | null = null;

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Id этой установки приложения (без хранилища — на время запуска). */
export function appDeviceId(): string {
  const stored = storageGet(DEVICE_KEY);
  if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  memoryDeviceId ??= randomId();
  storageSet(DEVICE_KEY, memoryDeviceId);
  return memoryDeviceId;
}

// ---- Просмотры разделов -----------------------------------------------------

type Pending = { u: string; s: Record<string, number> };

function readPending(userId: string): Record<string, number> {
  try {
    const raw = storageGet(PENDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Pending;
    // Накоплено другим вошедшим на этом телефоне — не его.
    if (parsed?.u !== userId || typeof parsed.s !== "object" || !parsed.s) return {};
    return parsed.s;
  } catch {
    return {};
  }
}

function writePending(userId: string, screens: Record<string, number>) {
  storageSet(
    PENDING_KEY,
    Object.keys(screens).length ? JSON.stringify({ u: userId, s: screens }) : null,
  );
}

function addScreens(target: Record<string, number>, more: Record<string, number>) {
  for (const [key, n] of Object.entries(more)) {
    target[key] = Math.min((target[key] ?? 0) + n, MAX_PENDING);
  }
  return target;
}

function subtractScreens(target: Record<string, number>, sent: Record<string, number>) {
  for (const [key, n] of Object.entries(sent)) {
    const left = (target[key] ?? 0) - n;
    if (left > 0) target[key] = left;
    else delete target[key];
  }
  return target;
}

/** Клиент открыл раздел приложения. */
export function countScreen(userId: string, key: string) {
  writePending(userId, addScreens(readPending(userId), { [key]: 1 }));
}

// ---- Устройство -------------------------------------------------------------

type UserAgentData = {
  getHighEntropyValues?: (hints: string[]) => Promise<ClientHints>;
};

let hintsPromise: Promise<ClientHints | null> | null = null;

/** Настоящие модель и версия Android (Client Hints Chrome) — один раз за запуск. */
function readClientHints(): Promise<ClientHints | null> {
  hintsPromise ??= (async () => {
    const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
    if (!data?.getHighEntropyValues) return null;
    return await data.getHighEntropyValues(["model", "platformVersion"]);
  })().catch(() => null);
  return hintsPromise;
}

async function collectDevice(locale: Locale): Promise<Record<string, unknown>> {
  const ua = navigator.userAgent;
  const parsed = mergeClientHints(
    parseUserAgent(ua, navigator.maxTouchPoints),
    await readClientHints(),
  );
  const { width, height } = window.screen;
  const dpr = window.devicePixelRatio || 1;
  const model =
    parsed.platform === "ios" && parsed.model === "iPhone"
      ? (iphoneModelByScreen(width, height, dpr) ?? "iPhone")
      : deviceModelLabel(parsed);
  const pushDevice = await readPushDevice();
  return {
    platform: parsed.platform,
    os_name: parsed.osName,
    os_version: parsed.osVersion,
    device_model: model,
    browser: parsed.browser,
    browser_version: parsed.browserVersion,
    app_version: APP_VERSION,
    standalone: isInstalledDisplay(),
    push_permission: readPushPermission(),
    push_subscribed: pushDevice === "subscribed",
    locale,
    device_language: navigator.language || null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    screen: `${width}×${height}@${Math.round(dpr * 100) / 100}`,
    dark_mode: window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? null,
    user_agent: ua,
  };
}

// ---- Отправка ---------------------------------------------------------------

let inFlight: Promise<void> | null = null;
let lastSentAt = 0;
let lastSignature = "";

/** Без новостей (разделов, языка, уведомлений) — не чаще раза в минуту. */
const QUIET_INTERVAL_MS = 60_000;
/** С новостями — не чаще раза в 10 секунд. */
const MIN_INTERVAL_MS = 10_000;

/**
 * Пинг в базу: устройство и накопленные просмотры разделов. Вызывать при
 * запуске, возвращении в приложение, уходе из него и по таймеру — частые
 * вызовы сам пропускает.
 */
export function sendAppPing(userId: string, locale: Locale): Promise<void> {
  if (inFlight) return inFlight;
  const now = Date.now();
  const screens = readPending(userId);
  const hasScreens = Object.keys(screens).length > 0;
  const signature = [userId, locale, readPushPermission()].join("|");
  const fresh = signature !== lastSignature;
  const since = now - lastSentAt;
  if (since < MIN_INTERVAL_MS || (!hasScreens && !fresh && since < QUIET_INTERVAL_MS)) {
    return Promise.resolve();
  }

  inFlight = (async () => {
    try {
      const device = await collectDevice(locale);
      const { error } = await untypedDb.rpc("app_ping", {
        p_device_id: appDeviceId(),
        p_app_format: APP_FORMAT,
        p_device: device,
        p_screens: screens,
      });
      if (error) throw error;
      // Отправленное — из копилки; набежавшее за время запроса остаётся.
      // Снимаем только после ответа: iOS может усыпить приложение посреди
      // запроса, тогда просмотры уйдут со следующим пингом.
      writePending(userId, subtractScreens(readPending(userId), screens));
      lastSignature = signature;
    } catch {
      // Нет сети или база без миграции — отправим со следующим пингом.
    } finally {
      lastSentAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}
