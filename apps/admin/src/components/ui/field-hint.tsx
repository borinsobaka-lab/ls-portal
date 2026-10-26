import * as React from "react";
import { HelpCircle } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Значок «?» рядом с подписью поля: подсказка по наведению, на тач-экране —
 * по нажатию. В формах — проп `tip` у FormField/SwitchRow, в таблицах — у
 * TableHead (тот же текст у поля и у колонки). Свой TooltipProvider — чтобы
 * работать и вне SidebarProvider.
 */
export function FieldHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            // Вне Tab-порядка: иначе диалог при открытии ставит фокус на первый
            // «?» вместо поля и подсказка всплывает сама, а Tab между полями
            // спотыкается о каждый значок.
            tabIndex={-1}
            aria-label="Подсказка"
            className={cn(
              "inline-flex shrink-0 rounded-full text-muted-foreground/50 transition-colors hover:text-muted-foreground",
              className,
            )}
            // Radix закрывает подсказку по клику, а на тач-экране наведения нет:
            // клик всегда открывает, закрывается она касанием мимо или Esc.
            // preventDefault ещё и не даёт <label> переводить фокус на поле.
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 text-left font-normal leading-snug">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
