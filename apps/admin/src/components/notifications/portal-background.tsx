/**
 * Фоновые дела открытой вкладки портала (монтируется один раз в каркасе,
 * routes/_authenticated/route.tsx):
 *
 * - пульс «в сети» (portal_ping): раз в минуту, при возврате во вкладку и при
 *   уходе из неё. «Активна» — вкладка видна и в фокусе: тогда пуши не нужны,
 *   человек и так видит счётчик «Уведомлений» в рейке (notif_send);
 * - подписка этого браузера на пуши в базе — если разрешение уже дано
 *   (syncPushDevice раз в сутки);
 * - нажатие на пуш при открытом портале: service worker присылает
 *   `portal-open` — переходим без перезагрузки;
 * - `?notif=<id>` в адресе (пуш открыл новое окно) — уведомление прочитано,
 *   параметр убираем;
 * - значок с числом на иконке установленного приложения.
 */
import { useEffect } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { useMarkNotifRead, useNotifUnread } from "@/lib/notifications/data";
import { readPushPermission, setAppBadge, syncPushDevice } from "@/lib/notifications/push-client";
// Ловит beforeinstallprompt с загрузки страницы — для «Установить приложение».
import "@/lib/notifications/install";

const PING_MS = 60_000;

function isActive() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function PortalBackground() {
  const router = useRouter();
  const { data: profile } = useStaffProfile();
  const userId = profile?.id ?? null;
  const unread = useNotifUnread();
  const markRead = useMarkNotifRead();
  const search = useRouterState({ select: (s) => s.location.searchStr });

  // «В сети».
  useEffect(() => {
    if (!userId) return;
    let last = 0;
    let lastActive = false;
    const ping = (force = false) => {
      const active = isActive();
      // Не чаще раза в 10 секунд, если состояние не поменялось.
      if (!force && active === lastActive && Date.now() - last < 10_000) return;
      last = Date.now();
      lastActive = active;
      void supabase.rpc("portal_ping", { p_active: active }).then(
        () => {},
        () => {},
      );
    };
    ping(true);
    const timer = window.setInterval(() => ping(true), PING_MS);
    const onChange = () => ping();
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
    };
  }, [userId]);

  // Подписка этого браузера — у вошедшего, если пуши уже разрешены.
  useEffect(() => {
    if (!userId || readPushPermission() !== "granted") return;
    void syncPushDevice(userId).catch(() => {});
  }, [userId]);

  // Нажатие на пуш при открытом портале.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "portal-open" || typeof data.url !== "string") return;
      if (!data.url.startsWith("/") || data.url.startsWith("//")) return;
      router.history.push(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  // ?notif=<id> — прочитано, параметр убираем.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const id = params.get("notif");
    if (!id) return;
    params.delete("notif");
    void markRead([id]).catch(() => {});
    const rest = params.toString();
    router.history.replace(
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
  }, [search, markRead, router]);

  // Значок на иконке приложения.
  useEffect(() => {
    setAppBadge(unread);
  }, [unread]);

  return null;
}
