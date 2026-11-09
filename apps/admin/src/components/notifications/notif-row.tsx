/**
 * Строка уведомления на странице «Уведомления». Нажатие — прочитано и
 * переход по ссылке; точка справа (как в Gmail) — отметить прочитанным, не
 * открывая. У аватарки — значок вида: чат, задача, календарь, «Компания».
 */
import { formatDistanceToNowStrict, isToday, format } from "date-fns";
import { ru } from "date-fns/locale";
import { Bell, Building2, CalendarDays, CheckSquare, MessageCircle } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import type { NotifItem } from "@/lib/notifications/data";
import {
  NOTIF_CATEGORY_LABEL,
  notifCategory,
  type NotifCategory,
} from "@/lib/notifications/feed-logic";
import { cn } from "@/lib/utils";

const CATEGORY_ICON: Record<NotifCategory, typeof Bell> = {
  chat: MessageCircle,
  task: CheckSquare,
  calendar: CalendarDays,
  company: Building2,
  other: Bell,
};

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
  onMarkRead,
  onMarkUnread,
  compact = false,
}: {
  item: NotifItem;
  onOpen: (item: NotifItem) => void;
  /** Точка «не прочитано» — отметить прочитанным без перехода. */
  onMarkRead?: (item: NotifItem) => void;
  /** Вернуть в непрочитанные (пустой кружок у прочитанной строки). */
  onMarkUnread?: (item: NotifItem) => void;
  compact?: boolean;
}) {
  const unread = !item.read_at;
  const category = notifCategory(item.kind);
  const KindIcon = CATEGORY_ICON[category];
  return (
    <div
      className={cn(
        "relative flex items-start rounded-lg transition-colors hover:bg-muted",
        unread && "bg-brand/5",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg py-3 pr-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact && "py-2.5",
        )}
      >
        <span className="relative shrink-0">
          {item.actor_id ? (
            <StaffAvatar
              value={item.actor_avatar}
              name={item.actor_name ?? item.title}
              className="size-9 text-xs"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <KindIcon className="size-4" />
            </span>
          )}
          {item.actor_id && (
            <span
              className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border"
              title={NOTIF_CATEGORY_LABEL[category]}
            >
              <KindIcon className="size-3" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread && "font-semibold")}>
              <span className="sr-only">{NOTIF_CATEGORY_LABEL[category]}: </span>
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
      </button>
      {unread && onMarkRead ? (
        <button
          type="button"
          aria-label="Отметить прочитанным"
          title="Отметить прочитанным"
          className="group/dot mt-2 mr-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onMarkRead(item)}
        >
          <span className="size-2.5 rounded-full bg-destructive group-hover/dot:ring-4 group-hover/dot:ring-destructive/20" />
        </button>
      ) : !unread && onMarkUnread ? (
        <button
          type="button"
          aria-label="Отметить непрочитанным"
          title="Отметить непрочитанным"
          className="group/dot mt-2 mr-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onMarkUnread(item)}
        >
          <span className="size-2.5 rounded-full border border-muted-foreground/40 opacity-0 group-hover/dot:opacity-100 group-focus-visible/dot:opacity-100 pointer-coarse:opacity-100" />
        </button>
      ) : (
        <span aria-hidden className="mt-2 mr-1 size-8 shrink-0" />
      )}
    </div>
  );
}
