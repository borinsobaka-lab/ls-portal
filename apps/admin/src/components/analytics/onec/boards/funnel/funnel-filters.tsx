import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/ui/button";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { CheckboxOption } from "@/components/ui/form-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import {
  FUNNEL_ALL,
  FUNNEL_ALL_CITIES,
  funnelDirectionCount,
  funnelDirectionLabel,
  funnelMatches,
} from "@/lib/analytics/onec-reports/funnel";
import { cn } from "@/lib/utils";

/**
 * Фильтры доски «Воронка пробных»: город — список с поиском «Найти город»
 * (их funnel-reference.js встраивал поиск в меню города), направления —
 * несколько сразу, с поиском, «Сбросить выбор» и «Выбрано: N» (их
 * direction-picker). Списки и подписи — lib/analytics/onec-reports/funnel.ts.
 */

const CITY_FIELD_ID = "funnel-city";

export function FunnelCityFilter({
  cities,
  value,
  onChange,
}: {
  cities: string[];
  value: string;
  onChange: (city: string) => void;
}) {
  // Значения пунктов — номера, не названия: cmdk обрезает пробелы у значений.
  const key = (i: number) => `city-${i}`;
  const options = [
    { value: FUNNEL_ALL, label: FUNNEL_ALL_CITIES, searchText: FUNNEL_ALL_CITIES },
    ...cities.map((city, i) => ({ value: key(i), label: city, searchText: city })),
  ];
  const index = cities.indexOf(value);
  return (
    <div className="w-48" title="Город">
      <label htmlFor={CITY_FIELD_ID} className="sr-only">
        Город
      </label>
      <SearchableCombobox
        id={CITY_FIELD_ID}
        value={index < 0 ? FUNNEL_ALL : key(index)}
        onChange={(v) => onChange(v === FUNNEL_ALL ? FUNNEL_ALL : cities[+v.slice(5)])}
        options={options}
        placeholder={FUNNEL_ALL_CITIES}
        searchPlaceholder="Найти город"
        emptyText="Город не найден"
      />
    </div>
  );
}

export function FunnelDirectionFilter({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: string[];
  selected: string[];
  onToggle: (direction: string, checked: boolean) => void;
  onClear: () => void;
}) {
  // Строка поиска остаётся до следующего открытия, как у них.
  const [query, setQuery] = useState("");
  const label = funnelDirectionLabel(selected);
  const count = funnelDirectionCount(selected);
  const visible = options.filter((d) => funnelMatches(d, query));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={`Направление: ${label}`}
          title={label}
          className={cn(fieldTriggerClass, "w-48")}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1.5rem)] p-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Найти направление"
          aria-label="Найти направление"
        />
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <Button variant="link" size="inline" onClick={onClear}>
            Сбросить выбор
          </Button>
          <span className="text-xs text-muted-foreground">{count}</span>
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {visible.map((d) => (
            <CheckboxOption
              key={d}
              checked={selected.includes(d)}
              onCheckedChange={(checked) => onToggle(d, checked)}
              className="rounded-md px-2 py-1.5 hover:bg-accent"
            >
              {d}
            </CheckboxOption>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
