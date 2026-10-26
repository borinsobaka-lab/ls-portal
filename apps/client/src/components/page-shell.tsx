import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import { IS_PACKAGES } from "@/lib/terms";

function seededRandom(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h >>> 0) / 4294967296;
  };
}

const GRID_COLS = 4;
const GRID_ROWS = 3; // 12 cells, drop 4 -> 8 evenly distributed blobs
const BLOB_COUNT = GRID_COLS * GRID_ROWS - 4;

// Позиции огоньков — одни на всё приложение (раньше зависели от адреса
// страницы, и при каждом переходе огоньки перескакивали и анимация
// начиналась заново).
const BLOB_STYLES = (() => {
  const rand = seededRandom("base40:blobs");
  const cells: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) cells.push({ row: r, col: c });
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const cellW = 100 / GRID_COLS;
  const cellH = 100 / GRID_ROWS;
  return cells.slice(0, BLOB_COUNT).map(({ row, col }) => {
    const jitterX = (rand() - 0.5) * cellW * 0.7;
    const jitterY = (rand() - 0.5) * cellH * 0.7;
    return {
      top: `${(cellH * (row + 0.5) + jitterY).toFixed(2)}%`,
      left: `${(cellW * (col + 0.5) + jitterX).toFixed(2)}%`,
    };
  });
})();

/**
 * Тёмная подложка шапки с огоньками — ОДНА на приложение: её рисует каркас
 * (__root.tsx) за страницами, а PageShell прозрачный. Страница при переходе
 * пересоздаётся (main с key={pathname}), подложка — нет, поэтому огоньки
 * не дёргаются.
 */
export function HeaderBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 bg-[#2A2B2F]" aria-hidden="true">
      {/* Высота — под самую высокую шапку: у главной пакетного приложения под
          быстрыми кнопками ещё плашка студии, и на 320px огоньки резались
          прямой линией по кнопкам. Низ слоя гаснет плавно (.backdrop-fade). */}
      <div
        className={`backdrop-fade absolute inset-x-0 top-0 ${IS_PACKAGES ? "h-[440px]" : "h-[320px]"}`}
      >
        <GlowBlobs />
      </div>
    </div>
  );
}

/**
 * Сами огоньки — слой на весь родитель (position: relative/absolute).
 * Отдельно от подложки — для экранов со своим порядком слоёв (DarkFrame в
 * formats/packages/dark-frame.tsx и «Пригласи подругу»: огоньки поверх
 * иллюстрации).
 */
export function GlowBlobs({
  className = "",
  positions = BLOB_STYLES,
}: {
  className?: string;
  /** Свои места огоньков (левый верхний угол, %) — например, кольцом вокруг картинки. */
  positions?: { top: string; left: string }[];
}) {
  return (
    <div className={`gradient-blobs ${className}`}>
      {positions.map((style, i) => (
        <span key={i} style={style} />
      ))}
    </div>
  );
}

interface PageShellProps {
  header: ReactNode;
  children: ReactNode;
  scrollKey?: string | number;
}

export function PageShell({ header, children, scrollKey }: PageShellProps) {
  const { pathname } = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollIdentity = `${pathname}:${scrollKey ?? "page"}`;

  useLayoutEffect(() => {
    const resetScroll = () => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) return;
      scrollNode.scrollTop = 0;
      scrollNode.scrollLeft = 0;
    };

    resetScroll();
    const frameId = window.requestAnimationFrame(resetScroll);
    const timeoutId = window.setTimeout(resetScroll, 0);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [scrollIdentity]);

  // Фон и огоньки — HeaderBackdrop в каркасе, здесь прозрачно.
  return (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden">
      <div
        key={scrollIdentity}
        ref={scrollRef}
        data-page-scroll
        data-scroll-restoration-id="page-shell"
        className="no-scrollbar relative z-10 h-full overflow-y-auto overscroll-contain"
      >
        <div className="sticky top-0 z-0 text-white">
          <div className="relative z-10">{header}</div>
        </div>
        <div className="relative z-10 -mt-4 min-h-full rounded-t-3xl bg-background pb-24 shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.08)]">
          {children}
        </div>
      </div>
    </div>
  );
}
