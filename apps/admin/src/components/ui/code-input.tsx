import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Код из письма ячейками под цифры. Под ячейками — одно настоящее поле
 * (прозрачное, на всю ширину): вставка из письма целиком («123 456»,
 * «Код: 123456»), автоподстановка кода из почты на телефоне
 * (`one-time-code`), стирание и стрелки работают как в обычном поле.
 */
export function CodeInput({
  value,
  onChange,
  length,
  onComplete,
  autoFocus,
  disabled,
  invalid,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  length: number;
  /** Все цифры набраны или вставлены. */
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  const [focused, setFocused] = React.useState(false);
  const active = Math.min(value.length, length - 1);
  return (
    <div className="relative">
      <div className="flex justify-between gap-2" aria-hidden>
        {Array.from({ length }, (_, i) => (
          <div
            key={i}
            className={cn(
              "flex h-12 min-w-0 flex-1 items-center justify-center rounded-md border bg-background text-xl font-semibold tabular-nums transition-colors",
              invalid && "border-destructive",
              focused && i === active && !invalid && "border-primary ring-2 ring-primary/20",
            )}
          >
            {value[i] ?? ""}
          </div>
        ))}
      </div>
      <input
        id={id}
        // type="text", а не number: у number браузер теряет ведущие нули.
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none selection:bg-transparent"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, "").slice(0, length);
          onChange(next);
          if (next.length === length && value.length !== length) onComplete?.(next);
        }}
      />
    </div>
  );
}
