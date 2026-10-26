import { useEffect, useState } from "react";

/**
 * Активная студия админки — выбор в шапке (StudioSwitcher), хранится в
 * localStorage. Все запросы страниц фильтруются по ней; серверным функциям и
 * API-роутам она уходит заголовком ACTIVE_STUDIO_HEADER (сервер сверяет его
 * с ролями сотрудника — staff-auth.server.ts).
 */

export const ACTIVE_STUDIO_HEADER = "X-Studio-Id";

const STORAGE_KEY = "base40.activeStudioId";
// Ключ переименован с club40.* на base40.*; читаем старый как запасной, чтобы
// у уже работающих админов не сбросился выбор студии. Убрать через пару месяцев.
const LEGACY_STORAGE_KEY = "club40.activeStudioId";

export function getActiveStudioId(): string | null {
  if (typeof window === "undefined") return null;
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) return current;
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    window.localStorage.setItem(STORAGE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
  return legacy;
}

/** Заголовок с активной студией для запросов к серверу админки. */
export function activeStudioHeaders(): Record<string, string> {
  const id = getActiveStudioId();
  return id ? { [ACTIVE_STUDIO_HEADER]: id } : {};
}

export function setActiveStudioId(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(new CustomEvent("base40:studio-changed", { detail: id }));
}

export function useActiveStudioId(): string | null {
  const [id, setId] = useState<string | null>(() => getActiveStudioId());
  useEffect(() => {
    const handler = (e: Event) => setId((e as CustomEvent<string>).detail);
    window.addEventListener("base40:studio-changed", handler);
    return () => window.removeEventListener("base40:studio-changed", handler);
  }, []);
  return id;
}
