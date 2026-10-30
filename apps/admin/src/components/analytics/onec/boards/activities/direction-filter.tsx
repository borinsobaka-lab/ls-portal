import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { CheckboxOption } from "@/components/ui/form-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import {
  FILTER_LABELS,
  directionCount,
  directionLabel,
  matchesQuery,
} from "@/lib/analytics/onec-reports/activities";
import { cn } from "@/lib/utils";

/**
 * Фильтр «Направление» доски «Занятия» — их direction-picker: поле с
 * подписью «Все направления» / название / «Направлений выбрано: N», по
 * нажатию — поиск «Найти направление» (курсор сразу в нём), «Сбросить
 * выбор», «Выбрано: N» и список с отметками. Строка поиска живёт на доске:
 * у них она не стиралась при закрытии списка.
 */
export function DirectionFilter({
  options,
  selected,
  search,
  onSearchChange,
  onToggle,
  onClear,
}: {
  options: string[];
  selected: string[];
  search: string;
  onSearchChange: (value: string) => void;
  onToggle: (direction: string, checked: boolean) => void;
  onClear: () => void;
}) {
  const label = directionLabel(selected);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={`${FILTER_LABELS.direction}: ${label}`}
          title={label}
          className={cn(fieldTriggerClass, "w-48")}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <SearchInput
          value={search}
          onChange={onSearchChange}
          placeholder="Найти направление"
          aria-label="Найти направление"
        />
        <div className="flex min-h-8 items-center justify-between gap-2 px-2">
          <Button variant="link" size="inline" onClick={onClear}>
            Сбросить выбор
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {directionCount(selected)}
          </span>
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {options
            .filter((direction) => matchesQuery(direction, search))
            .map((direction) => (
              <CheckboxOption
                key={direction}
                checked={selected.includes(direction)}
                onCheckedChange={(checked) => onToggle(direction, checked)}
                className="rounded-md px-2 py-1.5 hover:bg-accent"
              >
                {direction}
              </CheckboxOption>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
