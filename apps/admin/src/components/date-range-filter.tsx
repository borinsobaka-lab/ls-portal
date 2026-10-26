import { format } from "date-fns";
import { ru } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, ChevronDown } from "lucide-react";

import { Calendar } from "@/components/ui/calendar";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export type { DateRange };

const short = (d: Date) => format(d, "dd.MM.yy", { locale: ru });

/**
 * Компактная подпись периода: плашка фильтров должна оставаться одной
 * строкой, а на телефоне фильтр — в полстроки. Год один — пишем его раз:
 * «01.10–31.10.26».
 */
function formatDateRange(value: DateRange | undefined): string | null {
  if (value?.from && value.to) {
    // Выбран один день («Абонементы»: платежи за число) — одна дата.
    if (value.from.toDateString() === value.to.toDateString()) return short(value.from);
    const sameYear = value.from.getFullYear() === value.to.getFullYear();
    const from = sameYear ? format(value.from, "dd.MM", { locale: ru }) : short(value.from);
    return `${from}–${short(value.to)}`;
  }
  if (value?.from) return `с ${short(value.from)}`;
  if (value?.to) return `по ${short(value.to)}`;
  return null;
}

/**
 * Фильтр по периоду — одно поле на всю админку («Клиенты», «Дашборд»,
 * статистика «Скриптов»). Выглядит как поле (field-styles), а не как кнопка:
 * это фильтр. По нажатию — календарь диапазона (на телефоне один месяц).
 * Пустое значение — подпись `placeholder` серым («Регистрация»).
 * Ширину задаёт место: в плашке фильтров — `w-48`.
 */
export function DateRangeFilter({
  value,
  onChange,
  placeholder,
  title,
  className,
  showLabel = true,
}: {
  value: DateRange | undefined;
  onChange: (value: DateRange | undefined) => void;
  placeholder: string;
  /**
   * Подпись перед выбранными датами («Регистрация: 01.10–31.10.26»), как у
   * NumberRangeFilter: в плашке с двумя фильтрами дат иначе не понять, какой
   * какой. false — когда подпись уже есть над полем (дашборд).
   */
  showLabel?: boolean;
  /** Всплывающая подсказка: что именно фильтрует период. */
  title?: string;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const text = formatDateRange(value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={text ? `${placeholder}: ${text}` : placeholder}
          title={title}
          className={cn(fieldTriggerClass, "w-48 tabular-nums", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* С подписью место отдаём ей: значок — только у пустого поля. */}
            {!(text && showLabel) && (
              <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            {text ? (
              <span className="flex min-w-0 items-baseline gap-1">
                {/* Сжимается подпись, даты — нет. */}
                {showLabel && (
                  <span className="truncate text-muted-foreground">{placeholder}:</span>
                )}
                <span className="shrink-0">{text}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )}
          </span>
          {/* На телефоне фильтр в полстроки — место отдаём датам. */}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50 max-sm:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={onChange}
          numberOfMonths={isMobile ? 1 : 2}
          defaultMonth={value?.from ?? value?.to}
          locale={ru}
          className="p-3"
        />
      </PopoverContent>
    </Popover>
  );
}
