import { useCallback, useSyncExternalStore } from "react";
import { endOfMonth, startOfMonth } from "date-fns";
import type { DateRange } from "react-day-picker";

/**
 * Фильтры дашборда — период и клубы — общие для всех его подразделов:
 * настроили в «Общих показателях», перешли в «Клиенты» — фильтры те же.
 * Живут в памяти вкладки. По умолчанию — текущий месяц и клуб из шапки
 * (`clubIds: null` — «как в шапке»: сменили клуб в шапке — дашборд за ним).
 */

export type DashboardFilters = {
  range: DateRange | undefined;
  /** Выбранные клубы; null — клуб из шапки. */
  clubIds: string[] | null;
};

export function currentMonth(): DateRange {
  const today = new Date();
  return { from: startOfMonth(today), to: endOfMonth(today) };
}

const defaults = (): DashboardFilters => ({ range: currentMonth(), clubIds: null });

let state: DashboardFilters = defaults();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// На сервере — одно и то же умолчание (стабильный объект на время рендера).
const serverState = defaults();

function set(next: DashboardFilters) {
  state = next;
  listeners.forEach((l) => l());
}

/** Период — текущий месяц (тот же день, что и умолчание)? */
export function isCurrentMonth(range: DateRange | undefined) {
  const month = currentMonth();
  return (
    range?.from?.getTime() === month.from!.getTime() && range?.to?.getTime() === month.to!.getTime()
  );
}

export function useDashboardFilters() {
  const filters = useSyncExternalStore(
    subscribe,
    () => state,
    () => serverState,
  );
  const setRange = useCallback((range: DateRange | undefined) => set({ ...state, range }), []);
  const setClubIds = useCallback((clubIds: string[]) => set({ ...state, clubIds }), []);
  const reset = useCallback(() => set(defaults()), []);
  return { filters, setRange, setClubIds, reset };
}
