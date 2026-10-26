import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { DEFAULT_PAGE_SIZE } from "@/components/data-pagination";
import { unwrapPage } from "@/lib/query";

type Range = { from: number; to: number };

/**
 * Таблица с серверной пагинацией: страница данных и общее число строк
 * приходят из БД (select(..., { count: "exact" }) + range).
 *
 * `queryKey` — имя таблицы и все фильтры. Смена фильтра сразу (в том же
 * рендере) возвращает на первую страницу, поэтому запроса «новый фильтр +
 * старая страница» не бывает, а ответы устаревших запросов React Query
 * отбрасывает сам.
 *
 * <DataPagination {...table.pagination} /> — подвал таблицы.
 */
export function useServerTable<T>(opts: {
  queryKey: readonly unknown[];
  queryFn: (range: Range) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
    count: number | null;
  }>;
  enabled?: boolean;
  errorMessage: string;
  defaultPageSize?: number;
}) {
  const filterKey = JSON.stringify(opts.queryKey);
  const [pageState, setPageState] = useState({ filterKey, page: 1 });
  const [pageSize, setPageSizeState] = useState(opts.defaultPageSize ?? DEFAULT_PAGE_SIZE);
  const page = pageState.filterKey === filterKey ? pageState.page : 1;
  const setPage = (p: number) => setPageState({ filterKey, page: p });

  // Границы для supabase .range(from, to) — обе включительно.
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const query = useQuery({
    queryKey: [...opts.queryKey, { from, to }],
    queryFn: () => unwrapPage<T>(opts.queryFn({ from, to })),
    enabled: opts.enabled,
    placeholderData: keepPreviousData,
    meta: { errorMessage: opts.errorMessage },
  });

  const total = query.data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // После удаления строк страниц может стать меньше — не оставляем пустую.
  // Если строк стало меньше смещения, PostgREST вообще отвечает ошибкой 416
  // (range not satisfiable) — тогда возвращаемся на первую страницу.
  const overflow = query.data !== undefined && !query.isPlaceholderData && page > pageCount;
  const rangeError = query.isError && page > 1;
  useEffect(() => {
    if (overflow) setPageState({ filterKey, page: pageCount });
    else if (rangeError) setPageState({ filterKey, page: 1 });
  }, [overflow, rangeError, filterKey, pageCount]);

  return {
    rows: query.data?.rows ?? [],
    /** Первая загрузка (данных ещё нет) — показываем скелетон. */
    loading: query.isLoading,
    refetch: query.refetch,
    pagination: {
      page,
      setPage,
      pageSize,
      setPageSize: (s: number) => {
        setPageSizeState(s);
        setPage(1);
      },
      pageCount,
      total,
      loading: query.isLoading,
    },
  };
}
