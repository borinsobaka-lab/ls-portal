import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ADMIN_VERSION } from "@/lib/app-version";
import { isNewerVersion, isStaleChunkError } from "@/lib/update-check";

const CHECK_EVERY_MS = 5 * 60_000;
/** Сам перезагружаем страницу не чаще раза в минуту — иначе на сбое сети был бы цикл. */
const AUTO_RELOAD_KEY = "portal_auto_reload_at";

/**
 * Плашка «Вышла новая версия — обновить» (замечание тестирования 2026-10-27:
 * после выкатки открытая страница теряла стили или грузилась бесконечно —
 * просила у сервера файлы прежней сборки). Версию сервера спрашиваем раз в
 * 5 минут и при возврате во вкладку (/api/version). Не загрузился кусок
 * сборки — перезагружаемся сами (раз в минуту), иначе — та же плашка.
 */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { version?: unknown };
        if (!cancelled && isNewerVersion(ADMIN_VERSION, body.version)) setStale(true);
      } catch {
        // Нет сети — спросим в следующий раз.
      }
    };
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    const onStale = (event: Event) => {
      const error = "payload" in event ? (event as Event & { payload: unknown }).payload : null;
      if (event.type === "unhandledrejection") {
        const reason = (event as PromiseRejectionEvent).reason;
        if (!isStaleChunkError(reason)) return;
      } else if (error && !isStaleChunkError(error)) {
        return;
      }
      setStale(true);
      try {
        const last = Number(window.sessionStorage.getItem(AUTO_RELOAD_KEY) ?? 0);
        if (Date.now() - last > 60_000) {
          window.sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
          event.preventDefault();
          window.location.reload();
        }
      } catch {
        // Хранилище закрыто — остаётся плашка.
      }
    };
    window.addEventListener("vite:preloadError", onStale);
    window.addEventListener("unhandledrejection", onStale);
    return () => {
      window.removeEventListener("vite:preloadError", onStale);
      window.removeEventListener("unhandledrejection", onStale);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-[#1a2027] px-4 py-2 text-sm text-white shadow-md"
    >
      <span>Вышла новая версия портала — обновите страницу, чтобы всё работало.</span>
      <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
        <RefreshCw /> Обновить
      </Button>
    </div>
  );
}
