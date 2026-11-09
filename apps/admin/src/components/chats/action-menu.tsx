/**
 * Меню действий чатов одним набором в двух видах (UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 1.3, 2.1): видимая кнопка «⋯» (на десктопе — при наведении на строку, на
 * сенсорном экране — всегда) и тот же набор по правой кнопке / долгому
 * нажатию (`ContextMenu` — ускоритель). Строка чата, папка, участник, тема,
 * шапка чата.
 *
 * Подменю («Без звука ▸», «В папку ▸») в контекстном меню — обычным
 * подменю, в «⋯» — вторым экраном того же окна со строкой «‹ Назад».
 */
import { useState, type ComponentType, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ChatMenuItem = {
  label: string;
  /** Пояснение второй строкой (только в «⋯»). */
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect?: () => void;
  destructive?: boolean;
  /** Отметка «выбрано» (папка, вариант). */
  checked?: boolean;
  /** Подменю. */
  items?: ChatMenuItem[];
  /** Черта над пунктом. */
  separatorBefore?: boolean;
};

function ContextItems({ items }: { items: ChatMenuItem[] }) {
  return (
    <>
      {items.map((it) => (
        <div key={it.label}>
          {it.separatorBefore && <ContextMenuSeparator />}
          {it.items ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2">
                {it.icon && <it.icon className="size-4" />}
                {it.label}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-52">
                <ContextItems items={it.items} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : (
            <ContextMenuItem
              onSelect={it.onSelect}
              className={cn("gap-2", it.destructive && "text-destructive focus:text-destructive")}
            >
              {it.checked !== undefined ? (
                <span className="flex w-4 justify-center">
                  {it.checked && <Check className="size-4" />}
                </span>
              ) : (
                it.icon && <it.icon className="size-4" />
              )}
              {it.label}
            </ContextMenuItem>
          )}
        </div>
      ))}
    </>
  );
}

/** Правая кнопка / долгое нажатие по `children` — меню из `items`. */
export function ChatContextMenu({
  items,
  children,
  className = "w-56",
}: {
  items: ChatMenuItem[];
  children: ReactNode;
  className?: string;
}) {
  if (items.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={className}>
        <ContextItems items={items} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Кнопка «⋯» с тем же набором. `reveal="row"` — на десктопе видна при
 * наведении на строку с классом `group/row` (и когда меню открыто), на
 * сенсорном экране — всегда.
 */
export function ChatMoreMenu({
  items,
  label,
  reveal,
  align = "end",
  className,
  triggerClassName,
  icon: Icon = MoreHorizontal,
}: {
  items: ChatMenuItem[];
  /** Подпись кнопки для скринридера и подсказки: «Действия с чатом». */
  label: string;
  reveal?: "row";
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
  icon?: ComponentType<{ className?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<ChatMenuItem | null>(null);
  if (items.length === 0) return null;
  const list = sub?.items ?? items;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSub(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            reveal === "row" &&
              "pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            triggerClassName,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Icon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("w-60 p-1", className)}
        onClick={(e) => e.stopPropagation()}
      >
        {sub && (
          <ListItemButton
            className="mb-1 border-b font-medium text-muted-foreground"
            onClick={() => setSub(null)}
          >
            <ChevronLeft /> {sub.label}
          </ListItemButton>
        )}
        {list.map((it) => (
          <div key={it.label}>
            {it.separatorBefore && <div className="-mx-1 my-1 h-px bg-border" />}
            <ListItemButton
              className={cn(it.destructive && "text-destructive hover:text-destructive")}
              onClick={() => {
                if (it.items) {
                  setSub(it);
                  return;
                }
                setOpen(false);
                setSub(null);
                it.onSelect?.();
              }}
            >
              {it.checked !== undefined ? (
                <span className="flex w-4 shrink-0 justify-center">{it.checked && <Check />}</span>
              ) : (
                it.icon && <it.icon />
              )}
              <span className="min-w-0 flex-1">
                <span className="block">{it.label}</span>
                {it.hint && (
                  <span className="block text-xs font-normal text-muted-foreground">{it.hint}</span>
                )}
              </span>
              {it.items && <ChevronRight className="text-muted-foreground" />}
            </ListItemButton>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
