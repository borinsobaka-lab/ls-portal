import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useClientStudioId } from "@/hooks/use-client-studio";
import { APP_FORMAT } from "@/lib/app-format";
import { IS_PACKAGES } from "@/lib/terms";
import type { Studio } from "@/hooks/use-studios";
import { useLocalize } from "@/i18n";

/**
 * Студия, которую клиент сейчас смотрит (пакетное приложение, переключатель
 * на главной — решение владельца 2026-10-11). По ней — новости, услуги,
 * контакты, расписание, тренеры и абонементы. По умолчанию — студия из
 * карточки клиента («своя»); выбор помнит браузер. Записаться можно в любой
 * студии формата — пакетные студии одна сеть, абонемент действует во всех
 * (db/migrations/2026-10-14_network_guest_visits.sql). Читать данные чужой
 * студии того же формата разрешает
 * db/migrations/2026-10-11_zzzzzzzzzzz_packages_app_studio.sql.
 *
 * Подписочное приложение переключателя не имеет: там всегда своя студия.
 */

const STORAGE_KEY = "base40.viewedStudioId";
const listeners = new Set<() => void>();
let picked: string | null | undefined;

function readPicked(): string | null {
  if (picked !== undefined) return picked;
  try {
    picked = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
  } catch {
    picked = null;
  }
  return picked;
}

export function setViewedStudioId(id: string | null) {
  picked = id;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // приватный режим — выбор живёт до перезагрузки
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Студии формата приложения — список переключателя (studios читается публично). */
export function useFormatStudios() {
  return useQuery({
    queryKey: ["format-studios", APP_FORMAT],
    queryFn: async (): Promise<Studio[]> => {
      const { data, error } = await supabase
        .from("studios")
        .select("id, name, format, brand_color, logo_url, address, photo_url, translations")
        .eq("format", APP_FORMAT)
        .order("name");
      if (error) throw error;
      return (data as unknown as Studio[] | null) ?? [];
    },
    enabled: IS_PACKAGES,
    staleTime: 5 * 60_000,
  });
}

export type ViewedStudio = {
  /** Смотримая студия; null — студия неизвестна (запросы без фильтра). */
  studioId: string | null;
  studioReady: boolean;
  /** Своя студия клиента (карточка clients). */
  homeStudioId: string | null;
  /** Смотрит свою студию (запись в чужой — гостевая, с того же абонемента). */
  isHome: boolean;
};

export function useViewedStudioId(): ViewedStudio {
  const { studioId: homeStudioId, studioReady } = useClientStudioId();
  const pickedId = useSyncExternalStore(subscribe, readPicked, () => null);
  const { data: studios } = useFormatStudios();
  // Выбранная студия должна существовать и быть того же формата (её могли
  // удалить); пока список не загружен — доверяем выбору.
  const valid = IS_PACKAGES && !!pickedId && (!studios || studios.some((s) => s.id === pickedId));
  const studioId = valid ? pickedId : homeStudioId;
  return {
    studioId,
    studioReady,
    homeStudioId,
    isHome: !homeStudioId || studioId === homeStudioId,
  };
}

/** Название смотримой студии (заголовки «Студии» и подсказки записи) — на языке клиента. */
export function useViewedStudioName(): string | null {
  const loc = useLocalize();
  const { studioId } = useViewedStudioId();
  const { data: studios = [] } = useFormatStudios();
  return loc(studios.find((s) => s.id === studioId))?.name ?? null;
}

/** Название своей студии клиента — на языке клиента. */
export function useHomeStudioName(): string | null {
  const loc = useLocalize();
  const { homeStudioId } = useViewedStudioId();
  const { data: studios = [] } = useFormatStudios();
  return loc(studios.find((s) => s.id === homeStudioId))?.name ?? null;
}
