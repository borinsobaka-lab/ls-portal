/**
 * Порционная подгрузка списка по курсору: первая порция сразу, следующая —
 * когда низ списка доезжает до экрана (или по кнопке «Показать ещё»).
 * Хронология растёт с каждой правкой, и тянуть её всю разом незачем.
 *
 * Курсор — пара (время, id) последней строки: строки с одним временем не
 * теряются и не повторяются на стыке порций (в отличие от offset, который
 * съезжает, пока кто-то дописывает новые записи сверху).
 */
import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, type InfiniteData, type QueryKey } from "@tanstack/react-query";

export const PAGE_SIZE = 20;

export type Cursor = { at: string; id: string };

/**
 * Условие «строки после курсора» для `.or()` при сортировке (col desc, id desc).
 * Время — в кавычках: в нём есть точки, двоеточия и плюс.
 */
export function afterCursor(column: string, cursor: Cursor): string {
  return `${column}.lt."${cursor.at}",and(${column}.eq."${cursor.at}",id.lt.${cursor.id})`;
}

/** Порции, сложенные React Query, — для setQueryData после правки строки. */
export type PagedData<T> = InfiniteData<T[], Cursor | null>;

export function usePaged<T>({
  queryKey,
  load,
  cursorOf,
  errorMessage,
  enabled = true,
}: {
  queryKey: QueryKey;
  load: (cursor: Cursor | null) => Promise<T[]>;
  cursorOf: (row: T) => Cursor;
  errorMessage: string;
  enabled?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => load(pageParam),
    initialPageParam: null as Cursor | null,
    getNextPageParam: (last: T[]) =>
      last.length < PAGE_SIZE ? undefined : cursorOf(last[last.length - 1]),
    enabled,
    meta: { errorMessage },
  });
  const { data, hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  const items = useMemo(() => data?.pages.flat() ?? [], [data]);

  /** Повесить на элемент под списком: дошли до него — грузим дальше. */
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchingNextPage || isError) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, items.length]);

  return {
    items,
    loading: query.isPending && enabled,
    hasMore: !!hasNextPage,
    loadingMore: isFetchingNextPage,
    more: () => void fetchNextPage(),
    sentinel,
  };
}
