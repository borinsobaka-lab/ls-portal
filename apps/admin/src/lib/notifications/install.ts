/**
 * Установка портала как приложения (PWA). Chrome и Edge присылают
 * `beforeinstallprompt` один раз при загрузке страницы — ловим его сразу при
 * загрузке модуля (его импортирует каркас, components/notifications/
 * portal-background.tsx), а кнопка «Установить» в настройках уведомлений
 * показывает окно установки позже. Safari и iPhone этого события не знают —
 * там инструкция «Поделиться → На экран „Домой“».
 */
import { useSyncExternalStore } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

/** Можно показать окно установки (Chrome / Edge на компьютере и Android). */
export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => deferred !== null,
    () => false,
  );
}

/** Окно установки; true — согласились. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  await event.prompt();
  const { outcome } = await event.userChoice;
  deferred = null;
  emit();
  return outcome === "accepted";
}
