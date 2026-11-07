import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCheck, Loader2, Settings } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { NotificationsPageSkeleton } from "@/components/page-skeletons";
import { NotifRow } from "@/components/notifications/notif-row";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PORTAL_NAME } from "@/lib/brand";
import {
  useMarkNotifRead,
  useNotifFeed,
  useNotifUnread,
  type NotifItem,
} from "@/lib/notifications/data";
import { NOTIFICATIONS_SETTINGS_URL, NOTIFICATIONS_URL } from "@/lib/nav-sections";

/**
 * Все уведомления человека (TASKS_CHATS_PLAN.md, «Уведомления»): лента за 90
 * дней, «Непрочитанные», «Прочитать все». Строка — прочитано и переход.
 */
export const Route = createFileRoute("/_authenticated/notifications/")({
  head: () => ({ meta: [{ title: `Уведомления — ${PORTAL_NAME}` }] }),
  pendingComponent: NotificationsPageSkeleton,
  component: NotificationsPage,
});

type Filter = "all" | "unread";

function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const feed = useNotifFeed(filter === "unread");
  const unread = useNotifUnread();
  const markRead = useMarkNotifRead();
  const navigate = useNavigate();
  const items = feed.data?.pages.flat() ?? [];

  const openItem = (item: NotifItem) => {
    if (!item.read_at) void markRead([item.id]);
    if (item.url && item.url !== NOTIFICATIONS_URL) void navigate({ to: item.url });
  };

  return (
    <AdminShell title="Уведомления">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label="Какие уведомления показать"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "Все" },
              { value: "unread", label: unread ? `Непрочитанные · ${unread}` : "Непрочитанные" },
            ]}
          />
          <div className="ml-auto flex items-center gap-2">
            {unread > 0 && (
              <Button variant="outline" onClick={() => void markRead()}>
                <CheckCheck /> Прочитать все
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={NOTIFICATIONS_SETTINGS_URL}>
                <Settings /> Настройки
              </Link>
            </Button>
          </div>
        </div>

        <div className="rounded-xl border bg-background p-1.5">
          {feed.isLoading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Загружаем…
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {filter === "unread"
                ? "Непрочитанных нет."
                : "Пока уведомлений нет. Здесь появятся упоминания, личные сообщения и задачи."}
            </div>
          ) : (
            <div className="divide-y">
              {items.map((item) => (
                <NotifRow key={item.id} item={item} onOpen={openItem} />
              ))}
            </div>
          )}
        </div>

        {feed.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              disabled={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage && <Loader2 className="animate-spin" />} Показать ещё
            </Button>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
