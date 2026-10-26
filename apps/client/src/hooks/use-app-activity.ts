import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";

import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/i18n";
import { countScreen, sendAppPing } from "@/lib/app-activity";
import { screenKey } from "@/lib/device-info";
import { usePushPermission } from "@/lib/push";

/** Пока приложение открыто — пинг раз в 5 минут («последний раз в приложении»). */
const HEARTBEAT_MS = 5 * 60_000;

/**
 * Устройство и активность клиента — в базу (lib/app-activity.ts; вкладка
 * «Приложение» в карточке клиента админки). В каркасе приложения
 * (AppShell, __root.tsx), только у вошедшего:
 *
 * - открыл раздел — просмотр копится на телефоне;
 * - запуск, вход, смена языка или разрешения на уведомления, возвращение в
 *   приложение и уход из него, раз в 5 минут, пока открыто, — пинг
 *   (частые вызовы sendAppPing пропускает сам).
 */
export function useAppActivity() {
  const { user } = useAuth();
  const { locale } = useI18n();
  const permission = usePushPermission();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const userId = user?.id ?? null;

  // Раньше пинга: первый экран уходит вместе с ним.
  useEffect(() => {
    if (!userId) return;
    const key = screenKey(pathname);
    if (key) countScreen(userId, key);
  }, [userId, pathname]);

  useEffect(() => {
    if (!userId) return;
    const ping = () => {
      void sendAppPing(userId, locale);
    };
    ping();
    // Вернулись — новое открытие (база решит сама); ушли — отдаём накопленное.
    document.addEventListener("visibilitychange", ping);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") ping();
    }, HEARTBEAT_MS);
    return () => {
      document.removeEventListener("visibilitychange", ping);
      window.clearInterval(timer);
    };
  }, [userId, locale, permission]);
}
