/**
 * Сколько уже отправлено у загрузки в блок статьи (0…1) — по id блока.
 * Загрузку запускает редактор (`uploadFile` BlockNote не знает о
 * прогрессе), а полосу рисует панель файла или «Картинки в ряд»: они
 * подписываются на свой блок.
 */
import { useSyncExternalStore } from "react";

const progress = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setUploadProgress(blockId: string, share: number | null) {
  if (share === null) progress.delete(blockId);
  else progress.set(blockId, Math.max(0, Math.min(1, share)));
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Доля отправленного у загрузки в блок; null — загрузки нет. */
export function useUploadProgress(blockId: string | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (blockId ? (progress.get(blockId) ?? null) : null),
    () => null,
  );
}
