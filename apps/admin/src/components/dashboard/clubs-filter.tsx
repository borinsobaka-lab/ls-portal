import { Building2, ChevronDown } from "lucide-react";

import { CheckboxOption } from "@/components/ui/form-field";
import { fieldTriggerClass } from "@/components/ui/field-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Studio } from "@/hooks/use-studios";
import { clubsLabel, toggleClub, toggleFormat } from "@/lib/dashboard-clubs";
import { STUDIO_FORMATS, type StudioFormat } from "@/lib/studio-formats";
import { cn } from "@/lib/utils";

/** «Все клубы формата» — пункт списка и подпись поля, когда отмечены все. */
const ALL_LABEL: Record<StudioFormat, { option: string; short: string }> = {
  subscription: { option: "Все клубы с подписочной моделью", short: "Все подписочные" },
  packages: { option: "Все клубы с пакетами тренировок", short: "Все пакетные" },
};

/**
 * Фильтр «Клубы» дашборда: поле со списком клубов по форматам. Отметить
 * можно несколько клубов одного формата или «Все клубы формата»; клуб
 * другого формата заменяет выбор (логика — lib/dashboard-clubs.ts).
 */
export function ClubsFilter({
  clubs,
  selected,
  activeId,
  onChange,
}: {
  /** Клубы, где сотруднику открыт дашборд. */
  clubs: Studio[];
  selected: string[];
  /** Клуб из шапки — остаётся, когда снимают «Все клубы формата». */
  activeId: string | null;
  onChange: (ids: string[]) => void;
}) {
  const first = clubs.find((c) => c.id === selected[0]);
  const label = clubsLabel(clubs, selected, first ? ALL_LABEL[first.format].short : "");
  const groups = STUDIO_FORMATS.map((format) => ({
    format,
    clubs: clubs.filter((c) => c.format === format),
  })).filter((g) => g.clubs.length > 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field=""
          aria-label={`Клубы: ${label}`}
          title={label}
          className={cn(fieldTriggerClass, "w-full")}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected.length === 1 && first ? (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: first.brand_color }}
              />
            ) : (
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{label}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50 max-sm:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="space-y-2">
          {groups.map((g) => {
            const all = g.clubs.every((c) => selected.includes(c.id));
            return (
              <div key={g.format} className="space-y-0.5">
                {/* Один клуб формата — «все» не нужны: это он сам. */}
                {g.clubs.length > 1 && (
                  <CheckboxOption
                    checked={all}
                    onCheckedChange={() =>
                      onChange(toggleFormat(clubs, selected, g.format, activeId))
                    }
                    className="rounded-md px-2 py-1.5 font-medium hover:bg-accent"
                  >
                    {ALL_LABEL[g.format].option}
                  </CheckboxOption>
                )}
                {g.clubs.map((club) => (
                  <CheckboxOption
                    key={club.id}
                    checked={selected.includes(club.id)}
                    onCheckedChange={() => onChange(toggleClub(clubs, selected, club.id))}
                    className={cn(
                      "rounded-md px-2 py-1.5 hover:bg-accent",
                      g.clubs.length > 1 && "pl-6",
                    )}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: club.brand_color }}
                      />
                      <span className="truncate">{club.name}</span>
                    </span>
                  </CheckboxOption>
                ))}
              </div>
            );
          })}
          {groups.length > 1 && (
            <p className="border-t px-2 pt-2 text-xs text-muted-foreground">
              Клубы разных форматов вместе не считаются: отметка клуба другого формата заменит
              выбор.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
