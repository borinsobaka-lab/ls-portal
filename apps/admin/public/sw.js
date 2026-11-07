/*
 * Service worker портала — ради установки как приложения (PWA), страницы
 * «нет сети» и пушей сотрудникам. Приложение он НЕ кэширует: скрипты, стили
 * и запросы к Supabase идут в сеть как обычно, поэтому после выкладки сразу
 * открывается свежая версия. Перехватываются только переходы по страницам:
 * нет сети — отдаём offline.html из кэша. Меняя offline.html, подними VERSION.
 *
 * Пуш (src/lib/notifications/push-payload.ts): { t: заголовок, b: текст,
 * u: путь в портале, g: метка группы, n: id уведомления, c: непрочитанных }.
 * Уведомления одной группы (одного чата) заменяют друг друга. По нажатию —
 * открытое окно портала переходит по ссылке (или открывается новое), а
 * уведомление в ленте отмечается прочитанным (параметр ?notif= — его
 * снимает страница, src/components/notifications/notif-url-reader.tsx).
 */
const VERSION = "v3";
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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { t: event.data ? event.data.text() : "" };
  }
  const title = data.t || "Портал";
  const show = self.registration.showNotification(title, {
    body: data.b || "",
    tag: data.g || undefined,
    // Новое сообщение в той же группе — снова со звуком, а не молча.
    renotify: Boolean(data.g),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { u: data.u || "/notifications", n: data.n || null },
  });
  const badge =
    typeof data.c === "number" && "setAppBadge" in self.navigator
      ? (data.c > 0 ? self.navigator.setAppBadge(data.c) : self.navigator.clearAppBadge()).catch(
          () => {},
        )
      : Promise.resolve();
  event.waitUntil(Promise.all([show, badge]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { u, n } = event.notification.data || {};
  const path =
    typeof u === "string" && u.startsWith("/") && !u.startsWith("//") ? u : "/notifications";
  const target = new URL(path, self.location.origin);
  if (n) target.searchParams.set("notif", n);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const same = windows.filter((w) => new URL(w.url).origin === self.location.origin);
      const win = same.find((w) => w.focused) || same[0];
      if (win) {
        await win.focus();
        // Окно само переходит по ссылке (без перезагрузки портала).
        win.postMessage({
          type: "portal-open",
          url: target.pathname + target.search + target.hash,
        });
        return;
      }
      await self.clients.openWindow(target.href);
    }),
  );
});
