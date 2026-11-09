/**
 * Мини-месяц «Календаря» (как в Google): над списком календарей в меню и
 * по нажатию на заголовок периода. Нажатие на день — сетка переходит к
 * нему (из меню — через адрес `?date=`).
 */
import { ru } from "date-fns/locale";

import { Calendar } from "@/components/ui/calendar";
import { dateOf, isoOf } from "@/lib/day-format";
import { cn } from "@/lib/utils";

export function MiniMonth({
  selected,
  onSelect,
  className,
}: {
  /** День, который сейчас на сетке (YYYY-MM-DD). */
  selected?: string;
  onSelect: (day: string) => void;
  className?: string;
}) {
  return (
    <Calendar
      mode="single"
      required
      locale={ru}
      weekStartsOn={1}
      selected={selected ? dateOf(selected) : undefined}
      defaultMonth={selected ? dateOf(selected) : undefined}
      onSelect={(d) => d && onSelect(isoOf(d))}
      className={cn("[--cell-size:1.875rem]", className)}
    />
  );
}
