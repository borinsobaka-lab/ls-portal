import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo } from "react";
import { CheckCheck, Loader2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { TableToolbar } from "@/components/table-toolbar";
import { NotificationsFeedSkeleton, NotificationsPageSkeleton } from "@/components/page-skeletons";
import { DndMenu } from "@/components/notifications/dnd-menu";
import { NotifRow } from "@/components/notifications/notif-row";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PORTAL_NAME } from "@/lib/brand";
import {
  useMarkNotifRead,
  useMarkNotifUnread,
  useNotifFeed,
  useNotifUnread,
  type NotifItem,
} from "@/lib/notifications/data";
import { groupNotifs, NOTIF_DAY_GROUP_LABEL } from "@/lib/notifications/feed-logic";
import { NOTIFICATIONS_URL } from "@/lib/nav-sections";
import { useTaskClock } from "@/lib/tasks/data";

type Filter = "all" | "unread";

/**
 * Все уведомления человека (TASKS_CHATS_PLAN.md, «Уведомления»): лента за 90
 * дней по дням («Сегодня», «Вчера», «На этой неделе», «Раньше»),
 * «Непрочитанные» (`?filter=unread`), «Прочитать все», «Не беспокоить ▾».
 * Строка — прочитано и переход, точка — прочитано без перехода. Настройки —
 * пунктом меню раздела.
 */
export const Route = createFileRoute("/_authenticated/notifications/")({
  head: () => ({ meta: [{ title: `Уведомления — ${PORTAL_NAME}` }] }),
  validateSearch: (raw: Record<string, unknown>): { filter?: "unread" } =>
    raw.filter === "unread" ? { filter: "unread" } : {},
  pendingComponent: NotificationsPageSkeleton,
  component: NotificationsPage,
});

function NotificationsPage() {
  const search = Route.useSearch();
  const navigateSearch = Route.useNavigate();
  const filter: Filter = search.filter === "unread" ? "unread" : "all";
  const setFilter = (f: Filter) =>
    void navigateSearch({ search: f === "unread" ? { filter: "unread" } : {}, replace: true });
  const feed = useNotifFeed(filter === "unread");
  const unread = useNotifUnread();
  const markRead = useMarkNotifRead();
  const markUnread = useMarkNotifUnread();
  const navigate = useNavigate();
  const { tz } = useTaskClock();
  const items = useMemo(() => feed.data?.pages.flat() ?? [], [feed.data]);
  const groups = useMemo(() => groupNotifs(items, tz), [items, tz]);

  const openItem = (item: NotifItem) => {
    if (!item.read_at) void markRead([item.id]);
    if (item.url && item.url !== NOTIFICATIONS_URL) void navigate({ to: item.url });
  };

  return (
    <AdminShell title="Уведомления">
      <div className="mx-auto max-w-3xl space-y-4">
        <TableToolbar
          tabs={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                aria-label="Какие уведомления показать"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "Все" },
                  {
                    value: "unread",
                    label: unread ? `Непрочитанные · ${unread}` : "Непрочитанные",
                  },
                ]}
              />
              <div className="ml-auto flex items-center gap-2">
                {unread > 0 && (
                  <Button variant="outline" onClick={() => void markRead()}>
                    <CheckCheck /> <span className="max-sm:hidden">Прочитать все</span>
                    <span className="sm:hidden">Все</span>
                  </Button>
                )}
                <DndMenu />
              </div>
            </div>
          }
        />

        {feed.isLoading ? (
          <NotificationsFeedSkeleton />
        ) : items.length === 0 ? (
          <div className="rounded-xl border bg-background px-6 py-12 text-center text-sm text-muted-foreground">
            {filter === "unread"
              ? "Непрочитанных нет."
              : "Пока уведомлений нет. Здесь появятся упоминания, личные сообщения и задачи."}
          </div>
        ) : (
          <div className="rounded-xl border bg-background p-1.5">
            {groups.map((g, gi) => (
              <Fragment key={`${g.group}-${gi}`}>
                <h2 className="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                  {NOTIF_DAY_GROUP_LABEL[g.group]}
                </h2>
                <div className="divide-y">
                  {g.items.map((item) => (
                    <NotifRow
                      key={item.id}
                      item={item}
                      onOpen={openItem}
                      onMarkRead={(i) => void markRead([i.id])}
                      onMarkUnread={(i) => void markUnread([i.id])}
                    />
                  ))}
                </div>
              </Fragment>
            ))}
          </div>
        )}

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
