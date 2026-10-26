/** Переключатель периода для статистики: готовые отрезки и календарь. */
import { format, parseISO } from "date-fns";

import { DateRangeFilter } from "@/components/date-range-filter";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { activePreset, daysAgo, PERIOD_PRESETS, type Period } from "@/lib/scripts/period";

const toISO = (d: Date | undefined) => (d ? format(d, "yyyy-MM-dd") : "");

export function PeriodFilter({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <>
      {/* Даты заданы руками — ни один отрезок не подсвечен. */}
      <SegmentedControl
        aria-label="Период"
        value={activePreset(value)}
        onChange={(key) => {
          const p = PERIOD_PRESETS.find((x) => x.key === key);
          if (p) onChange({ from: p.from(), to: daysAgo(0) });
        }}
        options={PERIOD_PRESETS.map((p) => ({ value: p.key as string, label: p.label }))}
        className="toolbar-full"
      />
      <DateRangeFilter
        placeholder="Даты"
        value={
          value.from || value.to
            ? {
                from: value.from ? parseISO(value.from) : undefined,
                to: value.to ? parseISO(value.to) : undefined,
              }
            : undefined
        }
        onChange={(r) => onChange({ from: toISO(r?.from), to: toISO(r?.to ?? r?.from) })}
      />
    </>
  );
}
