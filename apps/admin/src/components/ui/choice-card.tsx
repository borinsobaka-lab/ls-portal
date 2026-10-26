import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Вариант выбора карточкой: «Какая продажа?», «Что добавить в расписание?»,
 * ответ клиента в звонке, подсказка Kate. Это не кнопка-действие, а один из
 * нескольких вариантов, часто с описанием в несколько строк, — поэтому
 * прямоугольник rounded-lg, а не пилюля, и высота по содержимому.
 *
 * `media` — плашка с иконкой слева (сверху при `stacked` с sm), `title` +
 * `description` — подписи. Без них — свободное содержимое в `children`.
 */
const ChoiceCard = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    media?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
    /** С sm — плашка над подписью (плитки в ряд по три). */
    stacked?: boolean;
    /** Компактная строка: подсказки, ответы в звонке. */
    compact?: boolean;
  }
>(({ className, media, title, description, stacked, compact, children, type, ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    className={cn(
      "group flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-background text-left text-sm transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-background [&_svg]:shrink-0",
      compact ? "min-h-10 px-3 py-2" : "p-3 sm:p-4",
      stacked && "sm:flex-col sm:items-start",
      className,
    )}
    {...props}
  >
    {media}
    {title !== undefined || description !== undefined ? (
      <span className="min-w-0 space-y-1">
        {title !== undefined && <span className="block text-sm font-semibold">{title}</span>}
        {description !== undefined && (
          <span className="block text-xs text-muted-foreground">{description}</span>
        )}
      </span>
    ) : (
      children
    )}
  </button>
));
ChoiceCard.displayName = "ChoiceCard";

export { ChoiceCard };
