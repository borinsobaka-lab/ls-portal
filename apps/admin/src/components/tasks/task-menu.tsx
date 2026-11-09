/**
 * Меню «⋯» в «Задачах» — один вид у карточки задачи, колонки и карточки
 * досок, плитки файла, пункта чек-листа, сохранённого фильтра
 * (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 1.3, 2.1). Кнопка видна при наведении на
 * строку (`reveal` — родитель с классом `group`) и всегда — на сенсорном
 * экране. Пункты — `ListItemButton`, разрушающий — красный под линией.
 *
 * Общего `DropdownMenu` в наборе портала нет (`components/ui`), поэтому меню
 * собрано на `Popover` — так же, как «⋯» тем в чатах.
 */
import { useState, type ComponentType, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type TaskMenuItem = {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  danger?: boolean;
  disabled?: boolean;
  /** Пояснение второй строкой (почему недоступно). */
  hint?: string;
  run: () => void;
};

export type TaskMenuEntry = TaskMenuItem | { heading: string } | "separator";

export function TaskMenu({
  label,
  items,
  reveal = false,
  className,
  trigger,
}: {
  /** Подпись кнопки для скринридера и всплывающая. */
  label: string;
  items: TaskMenuEntry[];
  /** Кнопка — только при наведении на родителя `group` (на сенсорном — всегда). */
  reveal?: boolean;
  className?: string;
  /** Своя кнопка вместо «⋯». */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!items.some((i) => typeof i === "object" && "run" in i)) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            className={cn(
              "shrink-0 text-muted-foreground hover:text-foreground",
              reveal &&
                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
              className,
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 p-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={`s${i}`} className="-mx-1 my-1 h-px bg-border" />
          ) : "heading" in it ? (
            <p key={`h${i}`} className="px-3 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
              {it.heading}
            </p>
          ) : (
            <ListItemButton
              key={`${it.label}${i}`}
              disabled={it.disabled}
              className={cn(it.danger && "text-destructive hover:text-destructive")}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.icon && <it.icon className="size-4" />}
              <span className="min-w-0 flex-1">
                <span className="block">{it.label}</span>
                {it.hint && (
                  <span className="block text-xs font-normal text-muted-foreground">{it.hint}</span>
                )}
              </span>
            </ListItemButton>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
}
