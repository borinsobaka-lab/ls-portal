import * as React from "react";

import { ActiveIndicator } from "@/components/ui/active-indicator";
import { useActiveIndicator } from "@/hooks/use-active-indicator";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Иконка; с `iconOnly` подпись уходит в aria-label и title. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Всплывающая подпись (полное название при короткой подписи). */
  title?: string;
  /**
   * Точка-отметка после подписи (язык, на котором уже есть перевод); строка —
   * её смысл для скринридера.
   */
  dot?: string;
};

/**
 * Выбор одного из нескольких коротких вариантов, применяется сразу: язык,
 * клуб, период, вид графика, «Вычет / Надбавка». Выглядит как табы (та же
 * плашка-пилюля и переезжающий тёмный сегмент), но это radiogroup, а не
 * навигация: табы переключают содержимое под собой, сегмент — значение.
 * Стрелки ←/→ двигают выбор. Значение может не совпасть ни с одним
 * вариантом — тогда ничего не подсвечено.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  iconOnly,
  fullWidth,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  iconOnly?: boolean;
  /** Сегменты делят ширину поровну (поле формы). */
  fullWidth?: boolean;
  className?: string;
  "aria-label": string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const indicator = useActiveIndicator(
    listRef,
    '[role="radio"]',
    '[role="radio"][aria-checked="true"]',
    "aria-checked",
  );
  // Ни один вариант не выбран (даты периода заданы руками) — в группу
  // попадаем Tab-ом на первый.
  const selectedIndex = options.findIndex((o) => o.value === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (Math.max(selectedIndex, 0) + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "relative h-10 items-center rounded-full bg-muted p-1 text-muted-foreground",
        fullWidth ? "grid auto-cols-fr grid-flow-col" : "inline-flex",
        className,
      )}
    >
      <ActiveIndicator indicator={indicator} />
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? o.label : undefined}
            title={o.title ?? (iconOnly ? o.label : undefined)}
            tabIndex={checked || (selectedIndex < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              // relative z-10 — поверх плашки; фон рисует ActiveIndicator.
              "relative z-10 inline-flex h-full cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-4 [&_svg]:shrink-0",
              iconOnly ? "aspect-square" : "px-3.5",
              checked ? "text-selected-foreground" : "hover:text-foreground",
            )}
          >
            {o.icon && <o.icon />}
            {!iconOnly && o.label}
            {o.dot && (
              <span className="size-1.5 shrink-0 rounded-full bg-brand">
                <span className="sr-only">{o.dot}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
