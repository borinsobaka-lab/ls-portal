import { ChevronDown } from "lucide-react";

import { Input } from "@/components/ui/input";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { rangeBound, type NumberRange } from "@/lib/number-range";
import { cn } from "@/lib/utils";

/** Подпись в поле: «2–5», «от 2», «до 5», одно число — если границы равны. */
function formatNumberRange({ min, max }: NumberRange): string | null {
  const lo = rangeBound(min);
  const hi = rangeBound(max);
  if (lo != null && hi != null) return lo === hi ? String(lo) : `${lo}–${hi}`;
  if (lo != null) return `от ${lo}`;
  if (hi != null) return `до ${hi}`;
  return null;
}

/**
 * Фильтр по числовому промежутку («Абонементы»: остаток баланса). Выглядит
 * как поле (field-styles), как DateRangeFilter; по нажатию — два поля «от» и
 * «до», любое можно оставить пустым. Пустое значение — `placeholder` серым.
 * Ширину задаёт место: в плашке фильтров — `w-40`.
 */
export function NumberRangeFilter({
  value,
  onChange,
  placeholder,
  title,
  className,
}: {
  value: NumberRange;
  onChange: (value: NumberRange) => void;
  placeholder: string;
  /** Всплывающая подсказка: что именно фильтрует промежуток. */
  title?: string;
  className?: string;
}) {
  const text = formatNumberRange(value);
  const field = (key: keyof NumberRange, label: string) => (
    <label className="flex-1 space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        aria-label={`${placeholder}: ${label}`}
      />
    </label>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={text ? `${placeholder}: ${text}` : placeholder}
          title={title}
          className={cn(fieldTriggerClass, "w-40 tabular-nums", className)}
        >
          <span className={cn("truncate", !text && "text-muted-foreground")}>
            {text ? `${placeholder}: ${text}` : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50 max-sm:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="flex gap-2">
          {field("min", "от")}
          {field("max", "до")}
        </div>
      </PopoverContent>
    </Popover>
  );
}
