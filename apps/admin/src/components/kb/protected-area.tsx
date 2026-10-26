import { useEffect, useMemo, useRef } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";

import { useStaffProfile } from "@/hooks/use-staff-profile";
import { formatDateTime } from "@/lib/format";
import { KbProtectContext } from "@/lib/kb/protect-context";
import { cn } from "@/lib/utils";

/** Водяной знак: повторяющаяся надпись под углом (SVG фоном, без сети). */
function watermarkUrl(text: string): string {
  const safe = text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="190">` +
    `<text x="190" y="95" text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-24 190 95)" font-family="Roboto, Arial, sans-serif" font-size="14" ` +
    `fill="rgba(15, 23, 42, 0.11)">${safe}</text></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/**
 * Защита содержимого статьи (№52–54): водяной знак с почтой читателя и
 * временем открытия поверх текста и картинок; читателю (`canCopy` — нет) —
 * без выделения, копирования, сохранения картинок, печати (styles.css,
 * `.kb-no-copy`). Это помеха, а не замок: снимок экрана не запретить —
 * водяной знак показывает, чей он. Картинки и своё видео при защите не
 * скачать никому, и редактору тоже: нет «Скачать» в плеере и в окне
 * картинки, меню по правой кнопке и перетаскивания (решение владельца
 * 2026-10-27; файлы-вложения скачиваются как прежде).
 */
export function KbProtectedArea({
  enabled,
  canCopy,
  className,
  children,
}: {
  enabled: boolean;
  canCopy: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { data: me } = useStaffProfile();
  const ref = useRef<HTMLDivElement>(null);
  const opened = useMemo(() => formatDateTime(new Date().toISOString()), []);
  const lock = enabled && !canCopy;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || lock || !el) return;
    const stop = (e: Event) => {
      if ((e.target as Element | null)?.closest?.("img, video")) e.preventDefault();
    };
    el.addEventListener("contextmenu", stop);
    el.addEventListener("dragstart", stop);
    return () => {
      el.removeEventListener("contextmenu", stop);
      el.removeEventListener("dragstart", stop);
    };
  }, [enabled, lock]);

  useEffect(() => {
    const el = ref.current;
    if (!lock || !el) return;
    const stop = (e: Event) => e.preventDefault();
    const events = ["copy", "cut", "contextmenu", "dragstart", "selectstart"] as const;
    for (const ev of events) el.addEventListener(ev, stop);
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (key === "p" || key === "s" || key === "з" || key === "ы")) {
        e.preventDefault();
        toast.info("Печать и сохранение этой статьи закрыты");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
      window.removeEventListener("keydown", onKey);
    };
  }, [lock]);

  return (
    <>
      <div
        ref={ref}
        className={cn("relative", enabled && "kb-protected", lock && "kb-no-copy", className)}
      >
        <KbProtectContext.Provider value={enabled}>{children}</KbProtectContext.Provider>
        {enabled && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[inherit]"
            style={{ backgroundImage: watermarkUrl(`${me?.email ?? ""} · ${opened}`) }}
          />
        )}
      </div>
      {lock && (
        <div className="kb-print-blocked hidden">
          <Lock /> Печать этой статьи закрыта.
        </div>
      )}
    </>
  );
}
