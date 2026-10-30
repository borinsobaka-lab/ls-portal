import { monthDays } from "./payload";

/**
 * Параметры отчёта 1С в адресе: период и фильтры доски — их
 * /1c?report=…&start=&end=&city=&studio=&status= (фильтры переживают смену
 * периода, как у них в server-controls.js).
 */
export type OnecSearch = {
  start?: string;
  end?: string;
  city?: string;
  studio?: string;
  status?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : undefined);

/** validateSearch маршрутов отчётов 1С. */
export function parseOnecSearch(search: Record<string, unknown>): OnecSearch {
  const day = (v: unknown) => (typeof v === "string" && DAY.test(v) ? v : undefined);
  return {
    start: day(search.start),
    end: day(search.end),
    city: text(search.city) || undefined,
    studio: text(search.studio) || undefined,
    status: text(search.status) || undefined,
  };
}

/** Последний день месяца «ГГГГ-ММ» (их onecChangeMonth). */
export const lastDayOf = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(monthDays(y, m)).padStart(2, "0")}`;
};
