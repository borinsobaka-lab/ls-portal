/**
 * Срок задачи в одном окне (TASKS_CHATS_PLAN.md, 4.4, боли № 6, 7):
 * быстрые сроки по рабочим дням и концу рабочего дня, календарь (выходные и
 * праздники производственного календаря — красным) и время. Всё — в поясе
 * человека; в базу уходит момент времени.
 *
 * Быстрый срок применяется сразу. День и время из календаря применяются при
 * закрытии окна — «Готово» или нажатием мимо: выбранное не теряется
 * (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 4.5). Без права менять срок — не
 * поле, а текст с пояснением, кто его меняет.
 */
import { useMemo, useState } from "react";
import { ru } from "date-fns/locale";
import { CalendarClock, Lock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { TimeField } from "@/components/ui/date-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fieldClass } from "@/components/ui/field-styles";
import {
  formatDeadline,
  hhmm,
  localDay,
  localTime,
  quickDeadlines,
  zoned,
  type WorkCalendar,
} from "@/lib/tasks/logic";
import { dayKind, isoDay } from "@/lib/tasks/work-calendar";
import { cn } from "@/lib/utils";

const toLocalDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function DeadlinePicker({
  value,
  onChange,
  tz,
  workdayEnd,
  calendar,
  allowClear = true,
  disabled = false,
  disabledHint = "Срок меняет постановщик",
  id,
  className,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  tz: string;
  workdayEnd: string;
  calendar: WorkCalendar;
  allowClear?: boolean;
  disabled?: boolean;
  /** Почему срок не меняется (виден под текстом срока). */
  disabledHint?: string;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const end = hhmm(workdayEnd);
  const now = new Date();
  const [day, setDay] = useState<string>(() =>
    value ? localDay(new Date(value), tz) : localDay(now, tz),
  );
  const [time, setTime] = useState<string>(() => (value ? localTime(new Date(value), tz) : end));
  const quick = useMemo(
    () => (open ? quickDeadlines(new Date(), tz, workdayEnd, calendar) : []),
    [open, tz, workdayEnd, calendar],
  );
  const [dirty, setDirty] = useState(false);
  const common = useMemo(() => [...new Set(["09:00", "12:00", "15:00", end])].sort(), [end]);
  const notes = useMemo(() => ({ [end]: "конец дня" }), [end]);

  const commit = () => {
    const iso = zoned(day, time, tz).toISOString();
    if (!value || new Date(value).getTime() !== new Date(iso).getTime()) onChange(iso);
  };
  const reset = (o: boolean) => {
    if (o) {
      setDay(value ? localDay(new Date(value), tz) : localDay(new Date(), tz));
      setTime(value ? localTime(new Date(value), tz) : end);
      setDirty(false);
    } else if (dirty) commit();
    setOpen(o);
  };
  const pick = (iso: string | null) => {
    setDirty(false);
    onChange(iso);
    setOpen(false);
  };

  if (disabled)
    return (
      <div className={cn("space-y-0.5", className)}>
        <div className="flex items-center gap-2 text-sm">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn(!value && "text-muted-foreground")}>
            {value ? formatDeadline(value, tz) : "Без срока"}
          </span>
        </div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="size-3" /> {disabledHint}
        </p>
      </div>
    );

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className={cn(fieldClass, "flex items-center gap-2 text-left", className)}
        >
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
            {value ? formatDeadline(value, tz) : "Без срока"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-1rem)] p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row flex-wrap gap-1 border-b p-2 sm:w-44 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0">
            {quick.map((q) => (
              <button
                key={q.key}
                type="button"
                onClick={() => pick(q.date.toISOString())}
                className="rounded-md px-2.5 py-1.5 text-left hover:bg-muted"
              >
                <span className="block text-sm font-medium">{q.label}</span>
                <span className="block text-xs text-muted-foreground">{q.hint}</span>
              </button>
            ))}
            {allowClear && (
              <button
                type="button"
                onClick={() => pick(null)}
                className="rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                <X className="mr-1 inline size-3.5" />
                Без срока
              </button>
            )}
          </div>
          <div>
            <Calendar
              mode="single"
              locale={ru}
              weekStartsOn={1}
              selected={toLocalDate(day)}
              defaultMonth={toLocalDate(day)}
              onSelect={(d) => {
                if (!d) return;
                setDay(isoDay(d));
                setDirty(true);
              }}
              modifiers={{ off: (d: Date) => dayKind(isoDay(d), calendar) === "off" }}
              modifiersClassNames={{ off: "text-destructive" }}
            />
            <div className="flex items-center gap-2 border-t p-3">
              <TimeField
                value={time}
                onChange={(t) => {
                  setTime(t);
                  setDirty(true);
                }}
                common={common}
                notes={notes}
                className="w-40"
              />
              <Button className="ml-auto" onClick={() => pick(zoned(day, time, tz).toISOString())}>
                Готово
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
