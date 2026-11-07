/**
 * Пуши сотруднику в этом браузере (TASKS_CHATS_PLAN.md, веха 1). Стандарт
 * Web Push: компьютер (Chrome, Edge, Firefox, Safari), Android (Chrome) и
 * iPhone 16.4+ — только у портала, установленного «На экран „Домой“» (во
 * вкладке Safari пушей нет). Подписку выдаёт браузер, её адрес и ключи —
 * в базе (portal_push_subscriptions, RPC portal_push_register), шлёт сервер
 * портала (lib/notifications/portal-push-worker.server.ts), показывает
 * public/sw.js. Так же устроено клиентское приложение (apps/client/src/lib/push.ts).
 *
 * - Разрешение — только по нажатию (iOS иначе не покажет окно, а отказ
 *   браузер запоминает навсегда).
 * - Подписка привязана к вошедшему: useStaffPushSync при запуске и раз в
 *   сутки обновляет её в базе; при выходе устройство отвязывается.
 * - Service worker регистрируется только в прод-сборке (__root.tsx): в
 *   дев-сервере пушей нет.
 */
import { useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";

export type PushPermission = "unsupported" | NotificationPermission;

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

// ---- Разрешение для React ---------------------------------------------------

const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

export function notifyPushPermission() {
  for (const l of listeners) l();
}

function attach() {
  const onVisible = () => {
    if (document.visibilityState === "visible") notifyPushPermission();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", notifyPushPermission);
  let status: PermissionStatus | null = null;
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((s) => {
      status = s;
      s.addEventListener("change", notifyPushPermission);
    })
    .catch(() => {});
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", notifyPushPermission);
    status?.removeEventListener("change", notifyPushPermission);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
    }
  };
}

/** Разрешение на уведомления; null — на сервере. */
export function usePushPermission(): PushPermission | null {
  return useSyncExternalStore(subscribe, readPushPermission, () => null);
}

// ---- Установлен ли портал как приложение -------------------------------------

/** Открыт как установленное приложение (с экрана «Домой» или из меню компьютера). */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches
  );
}

/** iPhone или iPad (iPad с iOS 13 представляется компьютером Mac с тачем). */
export function isIos(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return (
    /Macintosh/.test(ua) && typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 1
  );
}

// ---- Ключ сервера и подписка ---------------------------------------------------

const SYNC_STORAGE = "portal.pushSync";

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

/** Открытый ключ VAPID (общий с клиентскими приложениями). */
export function prefetchPushKey(): Promise<string | null> {
  keyPromise ??= (async () => {
    const { data, error } = await supabase.rpc("push_public_key");
    if (error) throw error;
    const key = typeof data === "string" && data ? data : null;
    if (!key) keyPromise = null;
    return key;
  })().catch(() => {
    keyPromise = null;
    return null;
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

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 10_000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export type PushSetupError = "no-worker" | "no-key" | "failed";

/**
 * Подписка этого браузера в базе — для вошедшего. Без разрешения ничего не
 * делает. В базу пишет раз в сутки (или сразу — force, другой человек, новая
 * подписка). Возвращает, подписан ли браузер.
 */
export async function syncPushDevice(userId: string, force = false): Promise<boolean> {
  if (readPushPermission() !== "granted") return false;
  const registration = await getRegistration();
  if (!registration) throw new PushError("no-worker");
  const key = await prefetchPushKey();
  if (!key) throw new PushError("no-key");
  const serverKey = b64urlToBytes(key);

  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });

  const stamp = [userId, subscription.endpoint, new Date().toISOString().slice(0, 10)].join("|");
  if (!force && storageGet(SYNC_STORAGE) === stamp) return true;
  const keys = subscription.toJSON().keys ?? {};
  const { error } = await supabase.rpc("portal_push_register", {
    p_endpoint: subscription.endpoint,
    p_p256dh: keys.p256dh ?? "",
    p_auth: keys.auth ?? "",
    p_user_agent: navigator.userAgent,
  });
  if (error) throw error;
  storageSet(SYNC_STORAGE, stamp);
  return true;
}

export class PushError extends Error {
  constructor(public code: PushSetupError) {
    super(code);
  }
}

/** Окно разрешения — прямо в обработчике нажатия. Разрешили — подписываем. */
export async function enablePush(
  userId: string,
): Promise<{ permission: PushPermission; subscribed: boolean; error?: PushSetupError }> {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  void prefetchPushKey();
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    permission = await new Promise<NotificationPermission>((resolve) =>
      Notification.requestPermission(resolve),
    );
  }
  notifyPushPermission();
  if (permission !== "granted") return { permission, subscribed: false };
  try {
    const subscribed = await syncPushDevice(userId, true);
    return { permission, subscribed };
  } catch (e) {
    return {
      permission,
      subscribed: false,
      error: e instanceof PushError ? e.code : "failed",
    };
  }
}

/** Есть ли у этого браузера подписка. */
export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Выход: этот браузер больше не получает пуши этого человека. Подписку
 * браузера не снимаем — следующему вошедшему не нужно новое разрешение. Не
 * дольше 3 секунд.
 */
export async function unregisterPushDevice(): Promise<void> {
  storageSet(SYNC_STORAGE, null);
  if (!pushSupported()) return;
  const work = (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await supabase.rpc("portal_push_unregister", { p_endpoint: subscription.endpoint });
    }
  })().catch(() => {});
  await Promise.race([work, new Promise((resolve) => window.setTimeout(resolve, 3000))]);
}

/** Значок с числом на иконке установленного приложения. */
export function setAppBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (!nav.setAppBadge) return;
  (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
}
