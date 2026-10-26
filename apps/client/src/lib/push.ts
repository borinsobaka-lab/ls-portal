import { useSyncExternalStore } from "react";

import { APP_FORMAT } from "@/lib/app-format";
import { untypedDb } from "@/lib/untyped-db";
import type { Locale } from "@/i18n";

/**
 * Пуш-уведомления на телефоне (решение владельца 2026-10-15). Стандарт Web
 * Push: работает в установленном приложении — Android (Chrome) и iOS 16.4+
 * («На экран „Домой“»; во вкладке Safari пушей нет). Сторонних сервисов
 * нет: подписку выдаёт браузер (служба доставки Google или Apple), её адрес и
 * ключи — в базе (push_subscriptions, RPC register_push_subscription), пуши
 * шлёт сервер админки. Схема — db/migrations/2026-10-15_push_delivery.sql.
 *
 * - Разрешение спрашиваем только по нажатию (плашка на главной, «Включить» в
 *   профиле): iOS иначе не покажет окно, а отказ браузеры запоминают
 *   навсегда — повторно включить можно только в настройках телефона.
 * - Подписка привязана к вошедшему и к языку приложения на телефоне (на нём
 *   придёт пуш): usePushSync в __root.tsx обновляет её при запуске, входе и
 *   смене языка; при выходе устройство отвязывается (unregisterPushDevice).
 * - Приём и нажатие — public/sw.js.
 */

export type PushPermission = "unsupported" | NotificationPermission;

/** Есть ли пуши в этом браузере (iOS ниже 16.4 и вкладка Safari — нет). */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function readPushPermission(): PushPermission {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

export type PushDevice = "subscribed" | "not-subscribed" | "no-worker" | "unsupported";

/**
 * Есть ли у телефона подписка на пуши и работает ли service worker («О
 * приложении» в профиле, устройство в базе — lib/app-activity.ts).
 */
export async function readPushDevice(): Promise<PushDevice> {
  if (!("serviceWorker" in navigator)) return "unsupported";
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active) return "no-worker";
    if (!("pushManager" in registration)) return "unsupported";
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "subscribed" : "not-subscribed";
  } catch {
    return "unsupported";
  }
}

// ---- Состояние разрешения для React -----------------------------------------

const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

function notifyPermission() {
  for (const listener of listeners) listener();
}

function attachPermissionWatch() {
  // Вернулись из настроек телефона — разрешение могло поменяться.
  const onVisible = () => {
    if (document.visibilityState === "visible") notifyPermission();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", notifyPermission);
  let status: PermissionStatus | null = null;
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((s) => {
      status = s;
      s.addEventListener("change", notifyPermission);
    })
    .catch(() => {});
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", notifyPermission);
    status?.removeEventListener("change", notifyPermission);
  };
}

function subscribePermission(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) detach = attachPermissionWatch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
    }
  };
}

/** Разрешение на уведомления; null — на сервере и при гидратации. */
export function usePushPermission(): PushPermission | null {
  return useSyncExternalStore(subscribePermission, readPushPermission, () => null);
}

// ---- Ключ сервера и подписка ------------------------------------------------

const KEY_STORAGE = "base40.pushKey";
const SYNC_STORAGE = "base40.pushSync";

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

let keyPromise: Promise<string | null> | null = null;

/**
 * Открытый ключ VAPID сервера (RPC push_public_key) — заранее, чтобы по
 * нажатию «Включить» подписка не ждала сети. Помним на телефоне. Ключа на
 * сервере ещё нет (сервер рассылки не запускался) — не запоминаем: спросим
 * снова при следующей попытке.
 */
export function prefetchPushKey(): Promise<string | null> {
  keyPromise ??= (async () => {
    const { data, error } = await untypedDb.rpc("push_public_key");
    if (error) throw error;
    const key = typeof data === "string" && data ? data : null;
    if (key) storageSet(KEY_STORAGE, key);
    else keyPromise = null;
    return key;
  })().catch(() => {
    keyPromise = null;
    return storageGet(KEY_STORAGE);
  });
  return keyPromise;
}

function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array) {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** Service worker приложения (регистрирует __root.tsx; в дев-сервере его нет). */
async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  // Ещё не зарегистрирован (первый запуск: эффекты каркаса идут раньше
  // регистрации в корне) или только запускается — ждём, но не вечно.
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 10_000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Подписка устройства в базе — для вошедшего и на языке приложения. Без
 * разрешения ничего не спрашивает и ничего не делает. В базу пишет раз в
 * сутки (или сразу — force, смена языка, другой человек, новая подписка).
 * Возвращает, подписано ли устройство.
 */
export async function syncPushDevice(
  userId: string,
  locale: Locale,
  force = false,
): Promise<boolean> {
  if (readPushPermission() !== "granted") return false;
  const registration = await getRegistration();
  if (!registration) return false;
  const key = await prefetchPushKey();
  if (!key) return false;
  const serverKey = b64urlToBytes(key);

  let subscription = await registration.pushManager.getSubscription();
  // Подписка на прежний ключ сервера пушей не получит — оформляем заново.
  if (subscription && !sameKey(subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });

  const stamp = [userId, subscription.endpoint, locale, today()].join("|");
  if (!force && storageGet(SYNC_STORAGE) === stamp) return true;
  const keys = subscription.toJSON().keys ?? {};
  const { error } = await untypedDb.rpc("register_push_subscription", {
    p_endpoint: subscription.endpoint,
    p_p256dh: keys.p256dh ?? "",
    p_auth: keys.auth ?? "",
    p_locale: locale,
    p_app_format: APP_FORMAT,
    p_user_agent: navigator.userAgent,
  });
  if (error) throw error;
  storageSet(SYNC_STORAGE, stamp);
  return true;
}

/**
 * Окно разрешения — вызывать прямо в обработчике нажатия (iOS без жеста окно
 * не покажет). Разрешили — сразу подписываем устройство.
 */
export async function enablePush(
  userId: string,
  locale: Locale,
): Promise<{ permission: PushPermission; subscribed: boolean }> {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  // Ключ — заранее, параллельно с окном разрешения.
  void prefetchPushKey();
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    // Старый Safari: только колбэк.
    permission = await new Promise<NotificationPermission>((resolve) =>
      Notification.requestPermission(resolve),
    );
  }
  notifyPermission();
  if (permission !== "granted") return { permission, subscribed: false };
  const subscribed = await syncPushDevice(userId, locale, true).catch(() => false);
  return { permission, subscribed };
}

/**
 * Выход из приложения: устройство больше не получает пуши этого человека.
 * Подписку браузера не снимаем — следующий вошедший на этом телефоне получит
 * её себе без нового окна разрешения. Не дольше 3 секунд: выход не ждёт сеть.
 */
export async function unregisterPushDevice(): Promise<void> {
  storageSet(SYNC_STORAGE, null);
  if (!pushSupported()) return;
  const work = (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await untypedDb.rpc("unregister_push_subscription", { p_endpoint: subscription.endpoint });
    }
  })().catch(() => {});
  await Promise.race([work, new Promise((resolve) => window.setTimeout(resolve, 3000))]);
}
