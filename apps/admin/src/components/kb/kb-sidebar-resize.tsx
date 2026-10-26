import { useState, type PointerEvent as ReactPointerEvent } from "react";

import { KB_SIDEBAR_WIDTH } from "@/components/kb/use-kb-sidebar-width";

const { DEFAULT, MIN, MAX } = KB_SIDEBAR_WIDTH;

/**
 * Ручка на правом крае меню базы: тянуть мышью, двойной щелчок — обычная
 * ширина, стрелки ←/→ с клавиатуры. По центру стыка с рабочей областью —
 * видимая полоска-«хваталка» (решение владельца 2026-10-25: подсказывает,
 * что край тянется); при наведении и пока тянут — длиннее и цвета клуба (базы), вдоль
 * всего края — тонкая линия.
 */
export function KbSidebarResize({
  width,
  setWidth,
}: {
  width: number;
  setWidth: (w: number, persist: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let last = start;
    setDragging(true);
    // Пока тянут, у панели нет анимации ширины — иначе она отстаёт от мыши.
    document.body.dataset.sidebarResizing = "";
    const move = (ev: PointerEvent) => {
      last = start + ev.clientX - startX;
      setWidth(last, false);
    };
    const up = () => {
      setDragging(false);
      delete document.body.dataset.sidebarResizing;
      setWidth(last, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина меню базы знаний"
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      title="Потяните, чтобы изменить ширину меню. Двойной щелчок — обычная ширина"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(DEFAULT, true)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          setWidth(width + (e.key === "ArrowLeft" ? -16 : 16), true);
        }
      }}
      data-dragging={dragging || undefined}
      className="group/resize absolute inset-y-0 -right-2 z-20 w-4 cursor-col-resize outline-none after:absolute after:inset-y-0 after:right-[7px] after:w-0.5 after:rounded-full after:bg-white/0 after:transition-colors hover:after:bg-white/30 focus-visible:after:bg-white/50 data-dragging:after:bg-white/40"
    >
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 z-10 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-400 shadow-sm ring-2 ring-black/10 transition-[height,background-color] duration-150 group-hover/resize:h-14 group-hover/resize:bg-brand group-focus-visible/resize:h-14 group-focus-visible/resize:bg-brand group-data-dragging/resize:h-14 group-data-dragging/resize:bg-brand"
      />
    </div>
  );
}
