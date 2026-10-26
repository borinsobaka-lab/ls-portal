import { useCallback, useState } from "react";

const KEY = "kb_sidebar_width";
/** Ширина меню базы без рейки, px: обычное меню — 192 (12rem). */
const DEFAULT = 288;
const MIN = 224;
const MAX = 480;

export const KB_SIDEBAR_WIDTH = {
  DEFAULT,
  MIN,
  MAX,
  clamp: (w: number) => Math.round(Math.min(MAX, Math.max(MIN, w))),
};
const { clamp } = KB_SIDEBAR_WIDTH;

/**
 * Ширина меню базы знаний: шире обычного (дерево с вложенностью), край
 * тянется мышью, ширина запоминается в браузере.
 */
export function useKbSidebarWidth() {
  const [width, setWidthState] = useState(() => {
    if (typeof window === "undefined") return DEFAULT;
    try {
      const saved = Number(window.localStorage.getItem(KEY));
      return saved ? clamp(saved) : DEFAULT;
    } catch {
      return DEFAULT;
    }
  });
  const setWidth = useCallback((w: number, persist: boolean) => {
    const next = clamp(w);
    setWidthState(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(KEY, String(next));
    } catch {
      // приватный режим — ширина вернётся к обычной при перезагрузке
    }
  }, []);
  return { width, setWidth, cssWidth: `calc(var(--rail-width) + ${width}px)` };
}
