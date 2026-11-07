/**
 * Колокольчик в шапке (TASKS_CHATS_PLAN.md, «Уведомления»): счётчик
 * непрочитанного, по нажатию — последние уведомления, «Прочитать все»,
 * переход ко всем и к настройкам. Один на весь портал — задачи, упоминания,
 * база знаний, Академия. Сообщения чатов сюда не идут: у них свой счётчик.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck, Loader2, Settings } from "lucide-react";

import { NotifRow } from "@/components/notifications/notif-row";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CountBadge } from "@/components/ui/status-chip";
import {
  useMarkNotifRead,
  useNotifFeed,
  useNotifUnread,
  type NotifItem,
} from "@/lib/notifications/data";
import { NOTIFICATIONS_SETTINGS_URL, NOTIFICATIONS_URL } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";

export function NotifBell({ variant = "ghost" }: { variant?: "ghost" | "outline" }) {
  const [open, setOpen] = useState(false);
  const unread = useNotifUnread();
  const feed = useNotifFeed(false, open);
  const markRead = useMarkNotifRead();
  const navigate = useNavigate();
  const items = (feed.data?.pages.flat() ?? []).slice(0, 12);

  const openItem = (item: NotifItem) => {
    setOpen(false);
    if (!item.read_at) void markRead([item.id]);
    void navigate({ to: item.url ?? NOTIFICATIONS_URL });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          size="icon"
          className="relative shrink-0"
          aria-label={unread ? `Уведомления, новых: ${unread}` : "Уведомления"}
          title="Уведомления"
        >
          <Bell className={variant === "ghost" ? "h-5 w-5" : "size-4"} />
          {unread > 0 && (
            <CountBadge
              count={unread}
              aria-hidden
              className="absolute -top-1 -right-1 min-w-4 px-1 text-[10px] leading-4 ring-2 ring-background"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h2 className="flex-1 text-base font-semibold">Уведомления</h2>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => void markRead()}>
              <CheckCheck className="size-4" /> Прочитать все
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" asChild>
            <Link
              to={NOTIFICATIONS_SETTINGS_URL}
              aria-label="Настройки уведомлений"
              title="Настройки уведомлений"
              onClick={() => setOpen(false)}
            >
              <Settings className="size-4" />
            </Link>
          </Button>
        </div>
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto p-1.5">
          {feed.isLoading ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Загружаем…
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Пока уведомлений нет. Здесь появятся упоминания, задачи и ответы.
            </div>
          ) : (
            items.map((item) => <NotifRow key={item.id} item={item} onOpen={openItem} compact />)
          )}
        </div>
        <div className="border-t p-1.5">
          <Link
            to={NOTIFICATIONS_URL}
            onClick={() => setOpen(false)}
            className={cn(
              "block rounded-md px-3 py-2 text-center text-sm font-medium hover:bg-muted",
            )}
          >
            Все уведомления
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
