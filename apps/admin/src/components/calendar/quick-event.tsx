/**
 * Быстрое создание события (как в Google Календаре; UI_REVIEW, 5.3.1): по
 * выделению на сетке или нажатию на день — название, строка времени,
 * «Пригласить» и «Сохранить». «Ещё параметры» открывает полную форму с уже
 * введённым.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { EventPick } from "@/components/calendar/event-form";
import { PeopleField } from "@/components/tasks/task-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { calendarsQuery, saveEvent } from "@/lib/calendar/data";
import {
  calErrorText,
  defaultCalendarId,
  formErrors,
  formPayload,
  newEventForm,
  shortWhen,
  type EventForm,
} from "@/lib/calendar/logic";
import { timezoneLabel } from "@/lib/notifications/settings-logic";
import { useTaskClock } from "@/lib/tasks/data";

export function QuickEventDialog({
  pick,
  onClose,
  onMore,
  onSaved,
}: {
  pick: EventPick | null;
  onClose: () => void;
  /** «Ещё параметры» — полная форма с введённым. */
  onMore: (form: EventForm) => void;
  onSaved?: (calendarId: string) => void;
}) {
  return (
    <Dialog open={!!pick} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        {pick && (
          <QuickEventBody
            key={JSON.stringify(pick)}
            pick={pick}
            onClose={onClose}
            onMore={onMore}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function QuickEventBody({
  pick,
  onClose,
  onMore,
  onSaved,
}: {
  pick: EventPick;
  onClose: () => void;
  onMore: (form: EventForm) => void;
  onSaved?: (calendarId: string) => void;
}) {
  const qc = useQueryClient();
  const { tz } = useTaskClock();
  const { data: calendars = [] } = useQuery(calendarsQuery);
  const [f, setF] = useState<EventForm>(() =>
    newEventForm(defaultCalendarId(calendars), tz, new Date(), pick),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problems = formErrors(f, tz);
    if (problems.title || problems.time) {
      setError(problems.title ?? problems.time ?? null);
      document.getElementById("quick-title")?.focus();
      return;
    }
    setBusy(true);
    try {
      await saveEvent(qc, null, formPayload(f, tz));
      toast.success(
        f.attendees.length ? "Встреча создана, приглашения отправлены" : "Событие создано",
      );
      onSaved?.(f.calendarId);
      onClose();
    } catch (e) {
      toast.error(calErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogForm onSubmit={submit}>
      <DialogHeader className="border-b px-4 py-4 sm:px-6">
        <DialogTitle>Новое событие</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5 text-foreground">
          <Clock className="size-4 shrink-0 text-muted-foreground" />
          <span>
            {shortWhen(f)}
            {!f.allDay && <span className="text-muted-foreground"> · {timezoneLabel(tz)}</span>}
          </span>
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Название" required htmlFor="quick-title" error={error}>
          <Input
            id="quick-title"
            autoFocus
            maxLength={200}
            value={f.title}
            placeholder="Например: Встреча с отделом продаж"
            onChange={(e) => {
              setF({ ...f, title: e.target.value });
              setError(null);
            }}
          />
        </FormField>
        <FormField label="Участники" optional htmlFor={null}>
          <PeopleField
            value={f.attendees}
            onChange={(attendees) => setF({ ...f, attendees })}
            addLabel="Пригласить"
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => onMore(f)}>
          Ещё параметры <ArrowRight />
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
