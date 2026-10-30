import { X } from "lucide-react";

import { SearchableCombobox } from "@/components/searchable-combobox";
import { Badge } from "@/components/ui/badge";
import { pyCompare } from "@/lib/analytics/onec/rules";

/**
 * Разрешённые города партнёра — их city-picker: выбранные города плашками с
 * крестиком, новый — поиском по списку городов 1С.
 */
export function CityPicker({
  cities,
  value,
  onChange,
  disabled,
  id,
}: {
  cities: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const options = cities
    .filter((c) => !value.includes(c))
    .map((c) => ({ value: c, label: c, searchText: c }));
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...value].sort(pyCompare).map((city) => (
            <Badge key={city} variant="secondary" className="gap-1 pr-1">
              {city}
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none"
                aria-label={`Удалить ${city}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((c) => c !== city))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <SearchableCombobox
        id={id}
        value=""
        onChange={(city) => city && onChange([...value, city])}
        options={options}
        placeholder="Начните вводить город"
        searchPlaceholder="Город"
        emptyText="Город не найден"
        disabled={disabled}
      />
    </div>
  );
}
