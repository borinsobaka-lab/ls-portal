/*
 * Service worker клиентского приложения (регистрируется в __root.tsx, у обоих
 * приложений). Две задачи — пуш-уведомления (внизу файла) и быстрый
 * повторный запуск:
 *
 * - /assets/* (JS, CSS, шрифты, картинки сборки; имена с хэшем, не меняются)
 *   — из кэша, без сети. Новая сборка — новые имена, старые со временем
 *   вытесняются (держим последние MAX_ASSETS файлов).
 * - Страница (HTML) — из сети, как раньше: после деплоя сразу новая версия.
 *   Если сети нет или она не ответила за NAV_TIMEOUT_MS — последняя
 *   сохранённая копия этой же страницы.
 * - Иконки, манифест и прочие файлы из public/ — из кэша с обновлением фоном.
 *
 * Запросы к Supabase (другой домен) и не-GET не трогаем.
 */
const VERSION = "v1";
const ASSETS_CACHE = `base40-assets-${VERSION}`;
const PAGES_CACHE = `base40-pages-${VERSION}`;
const STATIC_CACHE = `base40-static-${VERSION}`;
const KEEP = [ASSETS_CACHE, PAGES_CACHE, STATIC_CACHE];
const MAX_ASSETS = 300;
const NAV_TIMEOUT_MS = 3000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("base40-") && !KEEP.includes(n))
          .map((n) => caches.delete(n)),
      );
      // Запрос страницы стартует параллельно с запуском service worker.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(event));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
    return;
  }
  if (/\.(png|ico|svg|webp|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSETS_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trimAssets(cache);
  }
  return response;
}

async function trimAssets(cache) {
  const keys = await cache.keys();
  // keys() — в порядке добавления: удаляем самые старые.
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

function pageKey(request) {
  const url = new URL(request.url);
  url.hash = "";
  return url.toString();
}

function networkFirstPage(event) {
  const { request } = event;
  const network = (async () => {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(request));
    const type = response.headers.get("content-type") || "";
    if (response.ok && type.includes("text/html")) {
      const cache = await caches.open(PAGES_CACHE);
      await cache.put(pageKey(request), response.clone());
    }
    return response;
  })();
  // Сохранение свежей копии не прерываем, даже если отдали сохранённую.
  event.waitUntil(network.catch(() => {}));
  return pageResponse(request, network);
}

async function pageResponse(request, network) {
  const cached = caches.open(PAGES_CACHE).then((cache) => cache.match(pageKey(request)));
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Сеть не ответила вовремя — сохранённая копия, если есть.
    return (await cached) || (await network);
  } catch (error) {
    const fallback = await cached;
    if (fallback) return fallback;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (hit) return hit;
  return (await update) || fetch(request);
}

/*
 * Пуш-уведомления (решение владельца 2026-10-15). Пуш шлёт сервер админки
 * (apps/admin/src/lib/push/payload.ts — поля ниже), служба доставки браузера
 * будит этот service worker. Пуш всегда показывается: iOS отписывает
 * приложение, которое получает пуши молча.
 *
 *   t — заголовок, b — текст (уже на языке приложения на этом телефоне),
 *   u — куда ведёт нажатие (раздел /schedule или https://…),
 *   n — id уведомления (tag: повтор не дублирует), d — id доставки,
 *   i — иконка приложения (Android).
 *
 * Показ и нажатие подтверждаются (/api/push-ack → счётчики «Доставлено» и
 * «Прочитано» в админке); открытое приложение обновляет ленту уведомлений.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { b: event.data ? event.data.text() : "" };
  }
  const title = data.t || "";
  const options = {
    body: data.b || "",
    tag: data.n || undefined,
    icon: data.i || "/icon-192.png",
    data: { u: data.u || null, n: data.n || null, d: data.d || null },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      ackPush(data.d, "delivered"),
      postToClients({ type: "push-received" }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = pushTarget(data.u, data.n);
  event.waitUntil(Promise.all([ackPush(data.d, "clicked"), openTarget(target)]));
});

// Браузер сменил подписку сам — оформляем новую тем же ключом сервера; в базу
// её запишет приложение при следующем запуске (usePushSync).
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription && event.oldSubscription.options;
  if (!options || !options.applicationServerKey) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
      .catch(() => {}),
  );
});

function ackPush(deliveryId, kind) {
  if (!deliveryId) return Promise.resolve();
  return fetch("/api/push-ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ d: deliveryId, e: kind }),
  }).catch(() => {});
}

async function postToClients(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

/** Куда ведёт пуш: раздел приложения, внешняя ссылка или лента уведомлений. */
function pushTarget(url, notificationId) {
  const value = (url || "").trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value) return new URL("/" + value.replace(/^\/+/, ""), self.location.origin).href;
  const inbox = new URL("/notifications", self.location.origin);
  if (notificationId) inbox.searchParams.set("n", notificationId);
  return inbox.href;
}

/**
 * Окно отвечает на push-open, только если в нём запущено приложение
 * (usePushSync в AppShell): вкладка браузера с инструкцией по установке
 * молчит. Нет ответа за ACK_TIMEOUT_MS — false.
 */
const ACK_TIMEOUT_MS = 700;

function askWindow(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      client.postMessage({ type: "push-open", url: path }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/*
 * Отложенный переход (src/lib/push-open.ts — те же имена): iOS открывает
 * приложение по openWindow не всегда на нужном адресе, а уснувшее в фоне
 * окно отвечает на push-open с опозданием. Приложение при запуске и при
 * возвращении на экран забирает раздел отсюда и, если оно не там, переходит.
 * Кэш не «base40-…» — его не чистит смена VERSION.
 */
const PUSH_STATE_CACHE = "push-state-v1";
const PUSH_PENDING_KEY = "/__push-pending";

async function savePendingPath(path) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      PUSH_PENDING_KEY,
      new Response(JSON.stringify({ path, at: Date.now() }), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    // без отложенного перехода — как раньше
  }
}

async function openTarget(href) {
  const url = new URL(href);
  if (url.origin === self.location.origin) {
    const path = url.pathname + url.search;
    // Приложение открыто — переходим внутри него, без перезагрузки, и выводим
    // вперёд то окно, что ответило (приложение, а не вкладку браузера).
    const [windows] = await Promise.all([
      self.clients.matchAll({ type: "window", includeUncontrolled: true }),
      savePendingPath(path),
    ]);
    const answered = await Promise.all(
      windows
        .filter((c) => new URL(c.url).origin === self.location.origin)
        .map((c) => askWindow(c, path).then((ok) => (ok ? c : null))),
    );
    const client = answered.find(Boolean);
    if (client) {
      try {
        await client.focus();
        return;
      } catch {
        // окно не вывести вперёд — открываем адрес, как будто приложение закрыто
      }
    }
  }
  // Приложение закрыто или спит — открываем адрес: Android откроет его в
  // установленном приложении (адрес в его scope), iOS — приложение с экрана
  // «Домой»; не на том разделе — догонит отложенный переход.
  try {
    await self.clients.openWindow(href);
  } catch {
    // iOS без разрешения окна — приложение откроет сама система по нажатию
  }
}
