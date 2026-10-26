import * as React from "react";

import { cn } from "@/lib/utils";

/* Единый вид полей ввода приложения (решение владельца 2026-10-12, по
   образцу iOS-форм): без рамки и тени, фон чуть серее белого (`bg-field`),
   в фокусе — на тон темнее; высота 56px — легко попасть пальцем, скругление
   18px. Подсказка светло-серая, введённый текст — тёмный. Шрифт 16px: с
   меньшим iOS увеличивает страницу при фокусе. Цвета — токены `--field*`
   в src/styles.css. Этот же класс берут Textarea и поля с плавающей
   подписью (floating-input.tsx). */
export const fieldClass =
  "w-full rounded-2xl border-0 bg-field px-4 text-base text-foreground shadow-none outline-none transition-colors placeholder:text-field-placeholder focus:bg-field-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-14",
          fieldClass,
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
