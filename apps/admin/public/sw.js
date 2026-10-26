/*
 * Service worker админки — ради установки как приложения (PWA) и страницы
 * «нет сети». Приложение он НЕ кэширует: скрипты, стили и запросы к Supabase
 * идут в сеть как обычно, поэтому после выкладки сразу открывается свежая
 * версия. Перехватываются только переходы по страницам: нет сети — отдаём
 * offline.html из кэша. Меняя offline.html, подними VERSION.
 */
const VERSION = "v2";
const CACHE = `offline-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
    ),
  );
});
