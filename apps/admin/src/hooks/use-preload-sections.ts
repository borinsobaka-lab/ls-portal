import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import { useAdminAccess } from "@/hooks/use-admin-access";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { canOpenPath } from "@/lib/nav-sections";

/** Пауза после входа: сначала открытая страница получает свои данные. */
const START_DELAY_MS = 1500;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};
type SaveDataNavigator = Navigator & { connection?: { saveData?: boolean } };

function whenIdle(): Promise<void> {
  const w = window as IdleWindow;
  return new Promise((resolve) => {
    if (w.requestIdleCallback) w.requestIdleCallback(() => resolve(), { timeout: 2000 });
    else window.setTimeout(resolve, 50);
  });
}

/**
 * Код разделов — заранее, в простое браузера: каждый раздел — свой чанк, и
 * без этого первый клик по пункту меню ждал его загрузку (скелетон на месте
 * страницы). Грузим по одному, только открытые сотруднику разделы и не при
 * «экономии трафика». Наведение на ссылку грузит чанк и само
 * (defaultPreload: "intent" в router.tsx) — это запас для тач-экранов и
 * первого клика.
 */
export function usePreloadSections() {
  const router = useRouter();
  const access = useAdminAccess();
  const studioId = useActiveStudioId();
  // useAdminAccess отдаёт новый объект на каждый рендер — в эффект берём
  // снимок через ref, а запускаем его один раз, когда права загрузились.
  const latest = useRef({ access, studioId });
  latest.current = { access, studioId };
  const ready = access !== null;

  useEffect(() => {
    if (!ready || (navigator as SaveDataNavigator).connection?.saveData) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { access, studioId } = latest.current;
      if (!access) return;
      const routes = Object.values(router.looseRoutesById).filter(
        (route) =>
          route.id.startsWith("/_authenticated/") && canOpenPath(access, studioId, route.fullPath),
      );
      for (const route of routes) {
        await whenIdle();
        if (cancelled) return;
        // Сбой загрузки чанка не страшен: при клике роутер попробует снова.
        await router.loadRouteChunk(route)?.catch(() => {});
      }
    }, START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready, router]);
}
