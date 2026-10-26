import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Строка списка, на которую нажимают: пункт всплывающего меню («⋯» у
 * раздела скриптов), блок в списке этапов звонка, выбор скрипта для ссылки.
 * Это не кнопка-действие, а строка: прямоугольник rounded-md во всю ширину,
 * текст влево, высота по содержимому (название бывает в две строки). Вид как
 * у пунктов контекстного меню.
 *
 * `active` — текущий пункт (выбранный блок, шаг звонка), `variant="outline"`
 * — строка в рамке (этапы звонка).
 */
const ListItemButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    active?: boolean;
    variant?: "ghost" | "outline";
  }
>(({ className, active, variant = "ghost", type, ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    aria-current={active ? "true" : undefined}
    className={cn(
      "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      variant === "outline" && "border border-input bg-background",
      // Текущий пункт темнее наведения (bg-accent = bg-muted): иначе их
      // различал только вес шрифта.
      active && "bg-foreground/[0.07] font-semibold hover:bg-foreground/[0.07]",
      className,
    )}
    {...props}
  />
));
ListItemButton.displayName = "ListItemButton";

export { ListItemButton };
