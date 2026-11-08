/**
 * Срок задачи в одном окне (TASKS_CHATS_PLAN.md, 4.4, боли № 6, 7):
 * быстрые сроки по рабочим дням и концу рабочего дня, календарь (выходные и
 * праздники производственного календаря — красным) и время. Всё — в поясе
 * человека; в базу уходит момент времени.
 */
import { useMemo, useState } from "react";
import { ru } from "date-fns/locale";
import { CalendarClock, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

function timeOptions(extra: string[]): string[] {
  const set = new Set<string>(extra);
  for (let h = 0; h < 24; h++) {
    set.add(`${String(h).padStart(2, "0")}:00`);
    set.add(`${String(h).padStart(2, "0")}:30`);
  }
  set.add("23:59");
  return [...set].sort();
}

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
  const times = useMemo(() => timeOptions([end, time]), [end, time]);

  const reset = (o: boolean) => {
    if (o) {
      setDay(value ? localDay(new Date(value), tz) : localDay(new Date(), tz));
      setTime(value ? localTime(new Date(value), tz) : end);
    }
    setOpen(o);
  };
  const pick = (iso: string | null) => {
    onChange(iso);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            fieldClass,
            "flex items-center gap-2 text-left disabled:cursor-default disabled:opacity-100",
            className,
          )}
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
              onSelect={(d) => d && setDay(isoDay(d))}
              modifiers={{ off: (d: Date) => dayKind(isoDay(d), calendar) === "off" }}
              modifiersClassNames={{ off: "text-destructive" }}
            />
            <div className="flex items-center gap-2 border-t p-3">
              <Select value={time} onValueChange={setTime}>
                <SelectTrigger className="w-40" aria-label="Время">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {times.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                      {t === end ? " · конец дня" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
