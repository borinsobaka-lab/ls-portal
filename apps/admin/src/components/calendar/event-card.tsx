/**
 * Карточка события календаря: когда, где, участники и их ответы, мой ответ
 * «Приду / Возможно / Не приду», мои напоминания, «Подключиться» к
 * видеовстрече и «Обсуждение» (чат встречи), правка и удаление (повторение
 * или вся серия).
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clock,
  HelpCircle,
  Loader2,
  MapPin,
  MessageSquareText,
  Pencil,
  Repeat,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ReminderPicker, type EventDraft } from "@/components/calendar/event-form";
import { useConfirm } from "@/components/confirm-dialog";
import { PersonButton } from "@/components/people/person-card";
import { PersonLine } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  calEventQuery,
  deleteEvent,
  openEventChat,
  respondEvent,
  saveMyReminders,
} from "@/lib/calendar/data";
import {
  calColor,
  calErrorText,
  canJoinVideo,
  eventWhen,
  RESPONSE_LABEL,
  rruleText,
} from "@/lib/calendar/logic";
import type { CalEvent, Response } from "@/lib/calendar/types";
import { startCall } from "@/lib/chats/calls";
import { callErrorText } from "@/lib/chats/call-logic";
import { safeHref, URL_RE } from "@/lib/chats/content";
import { useTaskClock } from "@/lib/tasks/data";
import { cn } from "@/lib/utils";

const RESPONSE_ICON: Record<Response, ReactNode> = {
  accepted: <Check className="size-3.5 text-emerald-600" />,
  declined: <X className="size-3.5 text-red-600" />,
  maybe: <HelpCircle className="size-3.5 text-amber-600" />,
  pending: <Clock className="size-3.5 text-muted-foreground" />,
};

export function EventCardDialog({
  target,
  onClose,
  onEdit,
}: {
  target: { id: string; occ: string | null } | null;
  onClose: () => void;
  onEdit: (draft: EventDraft) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-lg">
        {target && (
          <EventCardBody
            key={`${target.id}:${target.occ}`}
            id={target.id}
            occ={target.occ}
            onClose={onClose}
            onEdit={onEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EventCardBody({
  id,
  occ,
  onClose,
  onEdit,
}: {
  id: string;
  occ: string | null;
  onClose: () => void;
  onEdit: (draft: EventDraft) => void;
}) {
  const { data: e, isPending, error } = useQuery(calEventQuery(id, occ));
  if (isPending) {
    return (
      <>
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle className="sr-only">Событие</DialogTitle>
          <DialogDescription className="sr-only">Загрузка</DialogDescription>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </DialogBody>
      </>
    );
  }
  if (error || !e) {
    return (
      <>
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>Событие недоступно</DialogTitle>
          <DialogDescription>{calErrorText(error)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </>
    );
  }
  return <EventCardView e={e} onClose={onClose} onEdit={onEdit} />;
}

function EventCardView({
  e,
  onClose,
  onEdit,
}: {
  e: CalEvent;
  onClose: () => void;
  onEdit: (draft: EventDraft) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { tz } = useTaskClock();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [scopeFor, setScopeFor] = useState<"edit" | "delete" | null>(null);
  const attendee = e.my_response !== null;
  const series = !!e.rrule;
  const when = eventWhen(
    {
      start: e.occ_start,
      end: e.occ_end,
      all_day: e.all_day,
      day_from: e.day_from,
      day_to: e.day_to,
    },
    tz,
  );
  const counts = e.attendees.reduce<Record<Response, number>>(
    (acc, a) => ({ ...acc, [a.response]: acc[a.response] + 1 }),
    { accepted: 0, declined: 0, maybe: 0, pending: 0 },
  );
  const joinable = canJoinVideo(e.occ_start, e.occ_end);

  const run = async (key: string, fn: () => Promise<unknown>, errorText = calErrorText) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const join = () =>
    run(
      "join",
      async () => {
        const chatId = e.chat_id ?? (await openEventChat(qc, e.id));
        await startCall(qc, chatId);
        onClose();
      },
      (err) =>
        err instanceof Error && err.message.startsWith("cal_")
          ? calErrorText(err)
          : callErrorText(err),
    );

  const discuss = () =>
    run("chat", async () => {
      const chatId = e.chat_id ?? (await openEventChat(qc, e.id));
      onClose();
      void navigate({ to: "/chats/$chatId", params: { chatId } });
    });

  const remove = async (scope: "one" | "all" | "single") => {
    if (scope === "single") {
      const ok = await confirm({
        title: `Удалить «${e.title}»?`,
        description:
          e.attendees.length > 1 ? "Участники получат уведомление об отмене." : undefined,
        confirmLabel: "Удалить",
      });
      if (!ok) return;
    }
    await run("delete", async () => {
      await deleteEvent(qc, e.id, scope === "one" ? e.occ_start : null);
      toast.success(scope === "one" ? "Это повторение отменено" : "Удалено");
      onClose();
    });
  };

  return (
    <>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: calColor(e.calendar.color) }}
          />
          <span className="truncate">{e.calendar.visible ? e.calendar.name : "Приглашение"}</span>
        </div>
        <DialogTitle className="text-lg leading-snug break-words">{e.title}</DialogTitle>
        <DialogDescription className="text-sm text-foreground">{when}</DialogDescription>
        {series && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Repeat className="size-4 shrink-0" />
            {rruleText(e.rrule, e.day_from)}
          </p>
        )}
        {e.series_id && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Repeat className="size-4 shrink-0" /> Изменённое повторение серии
          </p>
        )}
      </DialogHeader>
      <DialogBody className="space-y-4">
        {(e.location || e.video) && (
          <div className="space-y-2">
            {e.location && (
              <p className="flex items-start gap-2 text-sm">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words">
                  <Linkified text={e.location} />
                </span>
              </p>
            )}
            {e.video && (
              <div className="flex flex-wrap items-center gap-2">
                <Video className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm">Видеовстреча</span>
                {attendee && (
                  <Button
                    size="sm"
                    className="ml-auto bg-emerald-600 text-white hover:bg-emerald-700"
                    disabled={!joinable || busy === "join"}
                    title={
                      joinable
                        ? "Подключиться к видеовстрече"
                        : "Кнопка заработает за 15 минут до начала"
                    }
                    onClick={() => void join()}
                  >
                    {busy === "join" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Video className="size-4" />
                    )}
                    Подключиться
                  </Button>
                )}
              </div>
            )}
            {e.video && attendee && !joinable && (
              <p className="text-xs text-muted-foreground">
                «Подключиться» заработает за 15 минут до начала.
              </p>
            )}
          </div>
        )}

        {e.description && (
          <p className="text-sm break-words whitespace-pre-wrap">
            <Linkified text={e.description} />
          </p>
        )}

        {attendee && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Ваш ответ</h3>
            <div className="flex flex-wrap gap-2">
              {(["accepted", "maybe", "declined"] as const).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={e.my_response === r ? "default" : "outline"}
                  disabled={busy === "respond"}
                  onClick={() => void run("respond", () => respondEvent(qc, e.id, r))}
                >
                  {r === "accepted" ? "Приду" : r === "maybe" ? "Возможно" : "Не приду"}
                </Button>
              ))}
            </div>
            {e.rrule && (
              <p className="text-xs text-muted-foreground">Ответ — для всех повторений.</p>
            )}
          </section>
        )}

        {e.attendees.length > 1 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              Участники · {e.attendees.length}
              <span className="ml-2 font-normal text-muted-foreground">
                {[
                  counts.accepted && `придут ${counts.accepted}`,
                  counts.maybe && `возможно ${counts.maybe}`,
                  counts.declined && `не придут ${counts.declined}`,
                  counts.pending && `не ответили ${counts.pending}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </h3>
            <ul className="space-y-1.5">
              {e.attendees.map((a) => (
                <li key={a.user_id} className="flex items-center gap-2 text-sm">
                  <PersonButton userId={a.user_id} className="min-w-0 flex-1 text-left">
                    <PersonLine id={a.user_id} size="xs" />
                  </PersonButton>
                  {a.user_id === e.organizer_id && (
                    <span className="text-xs text-muted-foreground">организатор</span>
                  )}
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    title={RESPONSE_LABEL[a.response]}
                  >
                    {RESPONSE_ICON[a.response]}
                    <span className="max-sm:sr-only">{RESPONSE_LABEL[a.response]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {e.attendees.length <= 1 && e.organizer_id && (
          <p className="text-sm text-muted-foreground">
            Создал(а):{" "}
            <PersonButton userId={e.organizer_id}>
              <PersonLine id={e.organizer_id} size="xs" />
            </PersonButton>
          </p>
        )}

        {attendee && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Мне напомнить</h3>
            <ReminderPicker
              value={e.my_reminders ?? []}
              allDay={e.all_day}
              disabled={busy === "reminders"}
              onChange={(v) => void run("reminders", () => saveMyReminders(qc, e.id, v))}
            />
          </section>
        )}
      </DialogBody>
      <DialogFooter className="flex-row flex-wrap gap-2 sm:justify-between">
        <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
          {attendee && e.attendees.length > 1 && (
            <Button variant="outline" disabled={busy === "chat"} onClick={() => void discuss()}>
              {busy === "chat" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageSquareText className="size-4" />
              )}
              Обсуждение
            </Button>
          )}
        </div>
        {e.can_edit && (
          <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
            <Button
              variant="outline"
              disabled={busy === "delete"}
              onClick={() => (series ? setScopeFor("delete") : void remove("single"))}
            >
              <Trash2 className="size-4" /> Удалить
            </Button>
            <Button
              onClick={() =>
                series ? setScopeFor("edit") : onEdit({ mode: "edit", event: e, scope: "all" })
              }
            >
              <Pencil className="size-4" /> Изменить
            </Button>
          </div>
        )}
      </DialogFooter>
      <ScopeDialog
        action={scopeFor}
        onClose={() => setScopeFor(null)}
        onPick={(scope) => {
          const action = scopeFor;
          setScopeFor(null);
          if (action === "edit") onEdit({ mode: "edit", event: e, scope });
          else void remove(scope);
        }}
      />
      {confirmDialog}
    </>
  );
}

/** «Только это событие» или «Все события серии». */
function ScopeDialog({
  action,
  onClose,
  onPick,
}: {
  action: "edit" | "delete" | null;
  onClose: () => void;
  onPick: (scope: "one" | "all") => void;
}) {
  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {action === "delete"
              ? "Удалить повторяющееся событие"
              : "Изменить повторяющееся событие"}
          </DialogTitle>
          <DialogDescription>
            Это событие повторяется. Что {action === "delete" ? "удалить" : "изменить"}?
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Button variant="outline" onClick={() => onPick("one")}>
            Только это событие
          </Button>
          <Button
            variant={action === "delete" ? "destructive" : "default"}
            onClick={() => onPick("all")}
          >
            Все события серии
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Текст со ссылками (https://…) — без HTML. */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const href = safeHref(m[0]);
    parts.push(
      href ? (
        <a
          key={start}
          href={href}
          target="_blank"
          rel="noreferrer"
          className={cn("break-all text-brand-on-light underline underline-offset-2")}
        >
          {m[0]}
        </a>
      ) : (
        m[0]
      ),
    );
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
