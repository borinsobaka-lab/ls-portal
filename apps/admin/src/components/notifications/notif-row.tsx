/**
 * Строка уведомления — в выпадающем списке колокольчика и на странице
 * «Уведомления». Нажатие — прочитано и переход по ссылке.
 */
import { formatDistanceToNowStrict, isToday, format } from "date-fns";
import { ru } from "date-fns/locale";
import { Bell } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import type { NotifItem } from "@/lib/notifications/data";
import { cn } from "@/lib/utils";

function notifWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (now.getTime() - d.getTime() < 60_000) return "только что";
  if (isToday(d)) return formatDistanceToNowStrict(d, { locale: ru, addSuffix: true });
  return format(d, now.getFullYear() === d.getFullYear() ? "d MMM, HH:mm" : "d MMM yyyy", {
    locale: ru,
  });
}

export function NotifRow({
  item,
  onOpen,
  compact = false,
}: {
  item: NotifItem;
  onOpen: (item: NotifItem) => void;
  compact?: boolean;
}) {
  const unread = !item.read_at;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "py-2.5" : "py-3",
        unread && "bg-brand/5",
      )}
    >
      {item.actor_id ? (
        <StaffAvatar
          value={item.actor_avatar}
          name={item.actor_name ?? item.title}
          className="size-9 shrink-0 text-xs"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bell className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread && "font-semibold")}>
            {item.title}
            {item.count > 1 && (
              <span className="ml-1 font-normal text-muted-foreground">· {item.count}</span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {notifWhen(item.updated_at)}
          </span>
        </span>
        {item.body && (
          <span
            className={cn(
              "mt-0.5 block text-sm text-muted-foreground",
              compact ? "line-clamp-2" : "line-clamp-3",
            )}
          >
            {item.body}
          </span>
        )}
      </span>
      <span
        aria-label={unread ? "Не прочитано" : undefined}
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-destructive" : "bg-transparent",
        )}
      />
    </button>
  );
}
