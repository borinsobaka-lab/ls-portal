import { useSyncExternalStore } from "react";

import { STANDALONE_DISPLAY_QUERY, isAndroidChrome, isInstalledDisplay } from "@/lib/pwa-install";

/**
 * Открыто ли приложение установленным. null — пока неизвестно: на сервере и
 * при гидратации (сервер не знает, вкладка это или приложение), тогда
 * страница рисуется как раньше.
 */
export function useInstalledDisplay(): boolean | null {
  return useSyncExternalStore(subscribeDisplayMode, isInstalledDisplay, () => null);
}

function subscribeDisplayMode(onChange: () => void) {
  const query = window.matchMedia?.(STANDALONE_DISPLAY_QUERY);
  query?.addEventListener?.("change", onChange);
  return () => query?.removeEventListener?.("change", onChange);
}

/**
 * Установка в одно нажатие — только в настоящем Chrome на Android
 * (isAndroidChrome, lib/pwa-install.ts): браузер присылает
 * beforeinstallprompt, когда приложение можно установить, — по нему кнопка
 * «Установить приложение» открывает системное окно установки. Событие
 * приходит рано, ещё до экрана инструкции, поэтому слушаем с загрузки модуля.
 * Нужен service worker с fetch (public/sw.js, у обоих приложений); без события —
 * только инструкция. В других браузерах событие не трогаем: их собственные
 * значок и окно установки остаются как есть.
 *
 * Этапы (phase): «Установить» → окно Chrome (prompting) → согласие →
 * installing: после согласия Chrome ещё несколько секунд скачивает и ставит
 * приложение, поэтому сначала крутилка, а «Готово» — через INSTALL_SECONDS
 * (решение владельца 2026-10-15: раньше «установлено» появлялось сразу,
 * когда установка ещё шла).
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" } | undefined>;
};

export const INSTALL_SECONDS = 10;

export type InstallPhase = "idle" | "prompting" | "installing" | "installed" | "failed";

type PromptState = { event: BeforeInstallPromptEvent | null; phase: InstallPhase };

let promptState: PromptState = { event: null, phase: "idle" };
const promptListeners = new Set<() => void>();

function setPromptState(next: Partial<PromptState>) {
  promptState = { ...promptState, ...next };
  for (const listener of promptListeners) listener();
}

/** Идёт установка: через INSTALL_SECONDS — «Готово». */
function startInstalling() {
  if (promptState.phase === "installing" || promptState.phase === "installed") return;
  setPromptState({ event: null, phase: "installing" });
  window.setTimeout(() => setPromptState({ phase: "installed" }), INSTALL_SECONDS * 1000);
}

if (typeof window !== "undefined" && isAndroidChrome(window.navigator.userAgent)) {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Своя кнопка вместо мини-панели Chrome.
    e.preventDefault();
    setPromptState({ event: e as BeforeInstallPromptEvent });
  });
  // Установили и из меню Chrome, не кнопкой, — тоже показываем ход установки.
  window.addEventListener("appinstalled", startInstalling);
}

const SERVER_PROMPT_STATE: PromptState = { event: null, phase: "idle" };

function subscribePrompt(onChange: () => void) {
  promptListeners.add(onChange);
  return () => {
    promptListeners.delete(onChange);
  };
}

export function useInstallPrompt() {
  const state = useSyncExternalStore(
    subscribePrompt,
    () => promptState,
    () => SERVER_PROMPT_STATE,
  );

  const install = async () => {
    const event = state.event;
    if (!event || state.phase === "prompting") return;
    // Окно установки открывается одним событием один раз.
    setPromptState({ event: null, phase: "prompting" });
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice?.outcome === "accepted") startInstalling();
      // Отказались — кнопка пропадает (Chrome пришлёт событие снова позже),
      // остаётся инструкция.
      else if (choice?.outcome === "dismissed") setPromptState({ phase: "idle" });
      else setPromptState({ phase: "failed" });
    } catch {
      setPromptState({ phase: "failed" });
    }
  };

  return {
    canInstall: !!state.event && (state.phase === "idle" || state.phase === "failed"),
    phase: state.phase,
    install,
  };
}
