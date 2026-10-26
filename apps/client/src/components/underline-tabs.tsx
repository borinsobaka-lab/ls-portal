import { useLayoutEffect, useRef, useState } from "react";

/**
 * Табы с подчёркиванием, которое «перетекает» от таба к табу (решение
 * владельца 2026-10-11): одна полоска под строкой, её положение и ширина
 * анимируются. Ряд прокручивается по горизонтали, активный таб — в видимую
 * область.
 */
export function UnderlineTabs<K extends string>({
  tabs,
  value,
  onChange,
  className = "",
  gapClass = "gap-6",
}: {
  tabs: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  gapClass?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<K, HTMLButtonElement>());
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  // Первое положение ставим без анимации — иначе полоска выезжает из угла.
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const btn = btnRefs.current.get(value);
      if (!btn) return;
      setBar({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    const btn = btnRefs.current.get(value);
    btn?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && rowRef.current) ro.observe(rowRef.current);
    return () => ro?.disconnect();
  }, [value, tabs]);

  useLayoutEffect(() => {
    if (!bar || animate) return;
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [bar, animate]);

  return (
    <div
      ref={rowRef}
      role="tablist"
      className={`relative flex overflow-x-auto no-scrollbar ${gapClass} ${className}`}
    >
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              if (el) btnRefs.current.set(t.key, el);
              else btnRefs.current.delete(t.key);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`relative shrink-0 pt-3 pb-1 text-base font-semibold transition-colors duration-300 ${
              active ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {t.label}
          </button>
        );
      })}
      {bar && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-0 h-1 rounded-full bg-primary ${
            animate ? "transition-[left,width] duration-300 ease-out" : ""
          }`}
          style={{ left: bar.left, width: bar.width }}
        />
      )}
    </div>
  );
}
