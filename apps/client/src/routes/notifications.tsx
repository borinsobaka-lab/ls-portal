import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { APP_BRAND } from "@/lib/terms";

import { PageShell } from "@/components/page-shell";
import { PushBanner } from "@/components/push-prompt";
import { Card } from "@/components/ui/card";
import { actionTarget, useNotifications, type InboxNotification } from "@/lib/notifications";
import { getTranslator, useLocalize, useT, type Translator } from "@/i18n";

/**
 * Лента уведомлений: пуши из админки этому клиенту (lib/notifications.ts).
 * ?n=<id> — открыто нажатием на пуш (public/sw.js): уведомление прочитано и
 * подсвечено.
 */
export const Route = createFileRoute("/notifications")({
  validateSearch: (search: Record<string, unknown>): { n?: string } =>
    typeof search.n === "string" ? { n: search.n } : {},
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Уведомления — {brand}", { brand: APP_BRAND }) },
        { name: "description", content: t("Уведомления {brand}.", { brand: APP_BRAND }) },
      ],
    };
  },
  component: NotificationsPage,
});

function formatReceivedAt(iso: string, t: Translator) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("только что");
  if (diffMin < 60) return t("{n} мин назад", { n: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("{n} ч назад", { n: diffH });
  return t.date(d, {
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function NotificationsPage() {
  const t = useT();
  const loc = useLocalize();
  const router = useRouter();
  const { n: openedId } = Route.useSearch();
  const { items, loading, error, unread, markRead, markAllRead } = useNotifications();
  const openedRef = useRef<HTMLLIElement | null>(null);
  const handledRef = useRef<string | null>(null);

  // Открыто нажатием на пуш — отмечаем прочитанным и показываем его (один
  // раз, когда уведомление появилось в ленте).
  useEffect(() => {
    if (!openedId || handledRef.current === openedId) return;
    const item = items.find((i) => i.notification_id === openedId);
    if (!item) return;
    handledRef.current = openedId;
    if (!item.read_at) markRead(openedId);
    openedRef.current?.scrollIntoView({ block: "center" });
  }, [openedId, items, markRead]);

  const follow = (n: InboxNotification) => {
    const target = actionTarget(n.action_url);
    if (!n.read_at) markRead(n.notification_id);
    if (!target) return;
    if (target.startsWith("/")) router.history.push(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  };

  return (
    <PageShell
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Уведомления")}</h1>
          <p className="text-sm text-white/70">
            {unread > 0 ? t("Непрочитанных: {n}", { n: unread }) : t("Все уведомления прочитаны")}
          </p>
        </div>
      }
    >
      <div className="p-4 space-y-3">
        <PushBanner />

        <div className="flex justify-end py-2">
          <button
            type="button"
            onClick={markAllRead}
            disabled={unread === 0}
            className="text-xs font-semibold text-foreground bg-muted hover:bg-muted/80 active:bg-muted/70 disabled:opacity-60 disabled:cursor-not-allowed rounded-full px-3 py-2.5 transition-colors"
          >
            {t("Прочитать все")}
          </button>
        </div>

        {loading ? (
          <ul className="space-y-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Card className="p-4 space-y-2">
                  <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-full rounded bg-muted animate-pulse" />
                  <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                </Card>
              </li>
            ))}
          </ul>
        ) : error ? (
          <Card className="p-6 text-center text-sm text-destructive">
            {t("Не удалось загрузить уведомления. Обновите страницу.")}
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {t("Уведомлений пока нет")}
          </Card>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const n = loc(item);
              const read = !!n.read_at;
              const opened = n.notification_id === openedId;
              return (
                <li key={n.notification_id} ref={opened ? openedRef : undefined}>
                  <Card
                    onClick={() => {
                      if (!read) markRead(n.notification_id);
                    }}
                    className={`p-4 transition-colors ${
                      read ? "" : "border-primary bg-primary/5 cursor-pointer active:opacity-80"
                    } ${opened ? "ring-2 ring-primary" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {!read && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold leading-snug break-words">{n.title}</div>
                        {n.message && (
                          <p className="mt-1 text-sm text-foreground/80 whitespace-pre-line break-words">
                            {n.message}
                          </p>
                        )}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="text-xs text-muted-foreground">
                            {formatReceivedAt(n.sent_at, t)}
                          </div>
                          {n.action_url && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                follow(n);
                              }}
                              className="shrink-0 text-xs font-semibold text-primary-foreground bg-primary hover:bg-primary/90 active:bg-primary/80 rounded-full px-3 py-1.5 transition-colors"
                            >
                              {t("Перейти")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PageShell>
  );
}
