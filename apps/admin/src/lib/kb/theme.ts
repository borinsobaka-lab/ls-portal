/**
 * Тёмная тема раздела «База знаний» (решение владельца 2026-10-25): кнопка
 * справа от поиска в шапке базы. Тема — классом `dark kb-dark` на <html>
 * (токены — html.dark.kb-dark в styles.css), пока открыта база: так темнеют
 * и окна, и всплывающие меню в порталах. Ставит класс StudioBranding, до
 * гидратации — скрипт KB_THEME_BOOT в __root.tsx (без светлой вспышки при
 * перезагрузке). Выбор — в localStorage этого браузера.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY = "kb_theme";

/** Фон страницы в тёмной теме (= --background в html.dark.kb-dark). */
export const KB_DARK_BG = "#15191e";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "dark";
  } catch {
    return false;
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Другая вкладка переключила — и эта следом.
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function useKbDarkTheme(): [boolean, () => void] {
  const dark = useSyncExternalStore(subscribe, read, () => false);
  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(KEY, read() ? "light" : "dark");
    } catch {
      // приватный режим — тема не запомнится
    }
    listeners.forEach((fn) => fn());
  }, []);
  return [dark, toggle];
}

/** Класс темы на <html>: тёмная только в базе знаний. */
export function setKbThemeRoot(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("kb-dark", dark);
}

/**
 * Скрипт в <head> до отрисовки: в базе знаний с выбранной тёмной темой класс
 * встаёт сразу, иначе страница мигала бы светлой до гидратации.
 */
export const KB_THEME_BOOT = `try{if(/^\\/kb(\\/|$)/.test(location.pathname)&&localStorage.getItem("${KEY}")==="dark")document.documentElement.classList.add("dark","kb-dark")}catch(e){}`;
