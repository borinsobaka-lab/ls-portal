import { useState } from "react";

import {
  nextSort,
  sortKeyString,
  sortRows,
  type SortGetters,
  type TableSort,
} from "@/lib/table-sort";

/**
 * Состояние сортировки таблицы (lib/table-sort.ts). Заголовок колонки:
 * `<TableHead {...sort.head("registration_date")}>Регистрация</TableHead>`.
 *
 * - Серверная таблица: `sort.key` — в queryKey `useServerTable` (смена
 *   сортировки сама вернёт на 1-ю страницу), `orderBy(query, sort.sort, …)`
 *   — в запросе.
 * - Клиентская: `usePagination(sort.apply(filtered), undefined, sort.key)`
 *   — строки сортируются после фильтров.
 */
export function useTableSort<T = never>(getters?: SortGetters<T>) {
  const [sort, setSort] = useState<TableSort>(null);
  return {
    sort,
    setSort,
    /** Строка для queryKey / сброса страницы: "" — без сортировки. */
    key: sortKeyString(sort),
    toggle: (key: string) => setSort((cur) => nextSort(cur, key)),
    /** Пропсы заголовка колонки TableHead. */
    head: (key: string) => ({
      sortDir: sort?.key === key ? sort.dir : null,
      onSort: () => setSort((cur) => nextSort(cur, key)),
    }),
    apply: (rows: readonly T[]) => sortRows(rows, sort, getters ?? {}),
  };
}

export type TableSortState = ReturnType<typeof useTableSort>;
