/**
 * «Ждут ответа»: приглашения на предстоящие встречи без моего ответа —
 * «Приду» / «Не приду» прямо в списке, по строке — карточка встречи.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Repeat } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { calInvitesQuery, respondEvent } from "@/lib/calendar/data";
import { calErrorText, eventWhen, rruleText } from "@/lib/calendar/logic";
import { usePeople } from "@/lib/chats/people";
import { useTaskClock } from "@/lib/tasks/data";
import { localDay, localTime } from "@/lib/tasks/logic";

export function InvitesDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (eventId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>Ждут ответа</DialogTitle>
          <DialogDescription>
            Приглашения на встречи, на которые вы ещё не ответили.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>{open && <InvitesList onOpen={onOpen} />}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function InvitesList({ onOpen }: { onOpen: (eventId: string) => void }) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { name } = usePeople();
  const { data, isPending } = useQuery(calInvitesQuery);
  const [busy, setBusy] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (!data?.length) return <InfoNote variant="empty">Все приглашения отвечены.</InfoNote>;

  const answer = async (id: string, r: "accepted" | "declined") => {
    setBusy(id);
    try {
      await respondEvent(qc, id, r);
    } catch (e) {
      toast.error(calErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="divide-y rounded-lg border">
      {data.map((i) => {
        return (
          <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(i.id)}>
              <span className="block truncate font-medium">{i.title}</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {i.recurring && <Repeat className="size-3.5 shrink-0" />}
                <span className="truncate">
                  {/* Повторяющаяся — правилом и временем, а не датой начала серии. */}
                  {i.rrule
                    ? `${rruleText(i.rrule, localDay(new Date(i.starts_at), i.tz))}${
                        i.all_day ? "" : ` · ${localTime(new Date(i.starts_at), tz)}`
                      }`
                    : eventWhen(
                        {
                          start: i.starts_at,
                          end: i.ends_at,
                          all_day: i.all_day,
                          day_from: localDay(new Date(i.starts_at), i.tz),
                          day_to: localDay(new Date(new Date(i.ends_at).getTime() - 60_000), i.tz),
                        },
                        tz,
                      )}
                  {i.organizer_id && ` · ${name(i.organizer_id)}`}
                </span>
              </span>
            </button>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={busy === i.id}
                onClick={() => void answer(i.id, "accepted")}
              >
                Приду
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === i.id}
                onClick={() => void answer(i.id, "declined")}
              >
                Не приду
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
