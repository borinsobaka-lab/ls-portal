import * as React from "react";

import { cn } from "@/lib/utils";

const DAYS = [
  { short: "пн", long: "Понедельник" },
  { short: "вт", long: "Вторник" },
  { short: "ср", long: "Среда" },
  { short: "чт", long: "Четверг" },
  { short: "пт", long: "Пятница" },
  { short: "сб", long: "Суббота" },
  { short: "вс", long: "Воскресенье" },
];

/**
 * Дни недели — выбор нескольких (повтор события, расписание): семь кружков
 * 40px, выбранный — тёмный. Значение — номера ISO, 1 — понедельник … 7 —
 * воскресенье. Это группа переключателей (`aria-pressed`), а не
 * `SegmentedControl`: выбирают несколько.
 */
export function WeekdayToggle({
  value,
  onChange,
  disabled,
  invalid,
  id,
  className,
  "aria-label": ariaLabel = "Дни недели",
}: {
  value: number[];
  onChange: (value: number[]) => void;
  disabled?: boolean;
  /** Красная рамка у кружков — ошибка поля («Выберите дни недели»). */
  invalid?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {DAYS.map((d, i) => {
        const day = i + 1;
        const on = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={d.long}
            title={d.long}
            className={cn(
              "size-10 cursor-pointer rounded-full border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background hover:bg-muted",
              invalid && !on && "border-destructive",
            )}
            onClick={() =>
              onChange(on ? value.filter((x) => x !== day) : [...value, day].sort((a, b) => a - b))
            }
          >
            {d.short}
          </button>
        );
      })}
    </div>
  );
}
