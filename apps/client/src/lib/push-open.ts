/**
 * Переход в раздел по нажатию на пуш — запасной путь для iOS (и любого
 * случая, когда окно приложения не ответило service worker).
 *
 * Обычный путь (public/sw.js, notificationclick): открытое приложение
 * получает push-open и переходит само; не ответило — clients.openWindow(адрес
 * раздела). Но iOS открывает приложение «с экрана „Домой“» не всегда по этому
 * адресу (в части версий — на стартовой странице), а приложение, уснувшее в
 * фоне, отвечает с опозданием. Поэтому service worker перед открытием
 * кладёт раздел в Cache Storage (PUSH_STATE_CACHE / PUSH_PENDING_KEY), а
 * приложение при запуске и при возвращении на экран забирает его и, если оно
 * не там, переходит (usePushSync). Запись живёт PUSH_PENDING_TTL_MS: старое
 * нажатие не перебросит клиента через час.
 *
 * Имена — те же, что в public/sw.js. Кэш назван не «base40-…»: такие
 * service worker чистит при смене версии.
 */
export const PUSH_STATE_CACHE = "push-state-v1";
export const PUSH_PENDING_KEY = "/__push-pending";
export const PUSH_PENDING_TTL_MS = 5 * 60_000;

/**
 * Раздел из записи service worker: только путь внутри приложения
 * («/schedule?x=1»), свежий. Иначе — null.
 */
export function pendingPushPath(raw: unknown, now: number): string | null {
  if (!raw || typeof raw !== "object") return null;
  const { path, at } = raw as { path?: unknown; at?: unknown };
  if (typeof path !== "string" || typeof at !== "number") return null;
  // «//host» — уже чужой сайт, «/\host» браузер понимает так же.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (now - at > PUSH_PENDING_TTL_MS || at - now > 60_000) return null;
  return path;
}

async function openStateCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(PUSH_STATE_CACHE);
  } catch {
    return null;
  }
}

/** Забрать отложенный переход (запись удаляется). */
export async function takePendingPushPath(): Promise<string | null> {
  const cache = await openStateCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(PUSH_PENDING_KEY);
    if (!hit) return null;
    await cache.delete(PUSH_PENDING_KEY);
    return pendingPushPath(await hit.json(), Date.now());
  } catch {
    return null;
  }
}

/** Переход уже сделан по push-open — запасной не нужен. */
export async function clearPendingPushPath(): Promise<void> {
  const cache = await openStateCache();
  await cache?.delete(PUSH_PENDING_KEY).catch(() => false);
}
