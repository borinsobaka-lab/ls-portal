import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Клиентская пагинация. `resetKey` — сортировка или фильтр строкой: при его
 * смене — сразу (в том же рендере) 1-я страница, как в useServerTable.
 */
export function usePagination<T>(
  items: T[],
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
  resetKey = "",
) {
  const [pageState, setPageState] = useState({ resetKey, page: 1 });
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const page = pageState.resetKey === resetKey ? pageState.page : 1;
  const setPage = useCallback((p: number) => setPageState({ resetKey, page: p }), [resetKey]);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount, setPage]);

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  return {
    paged,
    page,
    setPage,
    pageSize,
    setPageSize: (s: number) => {
      setPageSize(s);
      setPage(1);
    },
    pageCount,
    total,
  };
}

type Props = {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  setPage: (p: number) => void;
  setPageSize: (s: number) => void;
  /** Первая загрузка: вместо «0–0 из 0» и «1 / 1» — болванки, стрелки выключены. */
  loading?: boolean;
  className?: string;
};

export function DataPagination({
  page,
  pageCount,
  pageSize,
  total,
  setPage,
  setPageSize,
  loading = false,
  className,
}: Props) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    // Подвал таблицы оформлен как шапка: белый, отделён верхней границей,
    // скруглены нижние углы под обёртку таблицы. Все контролы — общей высоты
    // 40px, как селект «Строк на странице». На телефоне — одна строка: без
    // подписи у селекта и без кнопок «первая/последняя», иначе подвал
    // разъезжался на две строки и съедал экран под таблицей.
    <div
      className={`data-pagination flex items-center justify-between gap-2 rounded-b-lg border-t bg-background px-2 py-2 sm:gap-3 sm:px-3 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="max-sm:hidden">Строк на странице</span>
        <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
          <SelectTrigger className="w-20" aria-label="Строк на странице">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground sm:gap-3">
        {loading ? (
          <Skeleton className="h-4 w-20" />
        ) : (
          <span className="whitespace-nowrap tabular-nums">
            {from}–{to} из {total}
          </span>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="max-sm:hidden"
            onClick={() => setPage(1)}
            aria-label="Первая страница"
            disabled={loading || page <= 1}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page - 1)}
            aria-label="Предыдущая страница"
            disabled={loading || page <= 1}
          >
            <ChevronLeft />
          </Button>
          {loading ? (
            <Skeleton className="mx-1 h-4 w-8 sm:mx-2" />
          ) : (
            <span className="whitespace-nowrap px-1 tabular-nums sm:px-2">
              {page} / {pageCount}
            </span>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page + 1)}
            aria-label="Следующая страница"
            disabled={loading || page >= pageCount}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="max-sm:hidden"
            onClick={() => setPage(pageCount)}
            aria-label="Последняя страница"
            disabled={loading || page >= pageCount}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
