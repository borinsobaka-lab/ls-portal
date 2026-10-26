import { useCallback, useSyncExternalStore } from "react";
import type { DateRange } from "react-day-picker";

import { currentMonth } from "@/hooks/use-dashboard-filters";
import type { StatusFilter } from "@/lib/analytics/logic";

/**
 * Фильтры «Аналитики» — общие для всех её отчётов (настроили город в «Моём
 * городе», перешли в «Выручку» — город тот же). Живут в памяти вкладки. По
 * умолчанию — текущий месяц, все клубы.
 */
export type AnalyticsFilters = {
  range: DateRange | undefined;
  brandId: string | null;
  city: string | null;
  clubId: string | null;
  status: StatusFilter;
};

const defaults = (): AnalyticsFilters => ({
  range: currentMonth(),
  brandId: null,
  city: null,
  clubId: null,
  status: "all",
});

let state: AnalyticsFilters = defaults();
const listeners = new Set<() => void>();
const serverState = defaults();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(next: Partial<AnalyticsFilters>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useAnalyticsFilters() {
  const filters = useSyncExternalStore(
    subscribe,
    () => state,
    () => serverState,
  );
  const update = useCallback((next: Partial<AnalyticsFilters>) => set(next), []);
  const reset = useCallback(() => set(defaults()), []);
  return { filters, update, reset };
}
