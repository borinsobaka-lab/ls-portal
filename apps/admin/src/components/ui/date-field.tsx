/**
 * Дата и время — одним видом во всём портале (срок задачи, шаблоны и
 * регулярные задачи, событие календаря, отложенное сообщение): поле-кнопка
 * с календарём портала и список времени с частыми значениями сверху.
 * Нативные `type="date"` / `type="time"` выглядят в каждом браузере
 * по-своему — в формах портала их не ставим.
 */
import { useMemo, useState } from "react";
import { ru } from "date-fns/locale";
import { CalendarDays, X } from "lucide-react";

import { Calendar } from "@/components/ui/calendar";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMMON_TIMES, dateOf, dayLabel, isoOf, timeSlots } from "@/lib/day-format";
import { cn } from "@/lib/utils";

export function DateField({
  value,
  onChange,
  placeholder = "Выберите дату",
  allowClear = false,
  min,
  offDay,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  /** YYYY-MM-DD или пусто. */
  value: string;
  onChange: (day: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  /** Раньше этого дня выбрать нельзя. */
  min?: string;
  /** Выходной (красным в календаре). */
  offDay?: (day: string) => boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative", className)}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              fieldTriggerClass,
              "w-full gap-2 text-left",
              allowClear && value && "pr-9",
            )}
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
              {value ? dayLabel(value) : placeholder}
            </span>
          </button>
        </PopoverTrigger>
        {allowClear && value && !disabled && (
          <button
            type="button"
            aria-label="Очистить дату"
            title="Очистить"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onChange("")}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={ru}
          weekStartsOn={1}
          selected={value ? dateOf(value) : undefined}
          defaultMonth={value ? dateOf(value) : min ? dateOf(min) : undefined}
          disabled={min ? { before: dateOf(min) } : undefined}
          onSelect={(d) => {
            if (!d) return;
            onChange(isoOf(d));
            setOpen(false);
          }}
          modifiers={offDay ? { off: (d: Date) => offDay(isoOf(d)) } : undefined}
          modifiersClassNames={offDay ? { off: "text-destructive" } : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TimeField({
  value,
  onChange,
  step = 30,
  common = COMMON_TIMES,
  notes = {},
  placeholder = "Время",
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel = "Время",
}: {
  /** HH:MM или пусто. */
  value: string;
  onChange: (time: string) => void;
  step?: 15 | 30;
  /** Частые значения — отдельной группой сверху. */
  common?: string[];
  /** Подписи к значениям: `{ "18:00": "конец дня" }`. */
  notes?: Record<string, string>;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const all = useMemo(
    () => timeSlots(step, [value, ...common, ...Object.keys(notes)]),
    [step, value, common, notes],
  );
  const label = (t: string) => (notes[t] ? `${t} · ${notes[t]}` : t);
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => onChange(v.startsWith("c|") ? v.slice(2) : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-32", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {common.length > 0 && (
          <>
            <SelectGroup>
              <SelectLabel>Часто</SelectLabel>
              {common.map((t) => (
                <SelectItem key={`c-${t}`} value={`c|${t}`}>
                  {label(t)}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
          </>
        )}
        {all.map((t) => (
          <SelectItem key={t} value={t}>
            {label(t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
