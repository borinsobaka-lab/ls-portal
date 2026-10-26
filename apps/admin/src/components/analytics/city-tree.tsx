import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { groupByCity, isClosed } from "@/lib/analytics/logic";
import type { AnStudio } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";

export type TreeColumn<T> = {
  key: string;
  label: string;
  tip?: string;
  render: (v: T) => ReactNode;
  /** Значение для сортировки; нет — колонка не сортируется. */
  sort?: (v: T) => number | null;
};

/**
 * Таблица отчёта «город → студии» (как у Lady Stretch): сверху «Итого по
 * сети», ниже города (нажатие раскрывает студии), внутри — открытые, затем
 * закрытые. Показатели строки считает `compute` по набору студий — поэтому
 * доли и средние города считаются из его сумм, а не средним студий.
 * Сортировка по заголовку — городов и студий внутри города.
 */
export function CityTreeTable<T>({
  studios,
  today,
  compute,
  columns,
  loading,
  firstLabel = "Город / студия",
  onPick,
}: {
  studios: AnStudio[];
  today: string;
  compute: (ids: Set<string>) => T;
  columns: TreeColumn<T>[];
  loading: boolean;
  firstLabel?: string;
  /** Нажатие на студию (например, «показать только её»). */
  onPick?: (studio: AnStudio) => void;
}) {
  const sort = useTableSort();
  const groups = groupByCity(studios, today);
  const [open, setOpen] = useState<Set<string> | "all" | null>(null);
  const expanded = (city: string) =>
    open === "all" || (open === null ? groups.length <= 3 : open.has(city));
  const toggle = (city: string) => {
    const now = new Set(groups.filter((g) => expanded(g.city)).map((g) => g.city));
    if (now.has(city)) now.delete(city);
    else now.add(city);
    setOpen(now);
  };

  const col = sort.sort ? columns.find((c) => c.key === sort.sort!.key) : undefined;
  const order = <X,>(list: X[], value: (x: X) => number | null) => {
    if (!col || !sort.sort) return list;
    const sign = sort.sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * sign;
    });
  };

  const rows = loading
    ? []
    : order(
        groups.map((g) => ({
          group: g,
          value: compute(new Set(g.studios.map((s) => s.id))),
          studios: g.studios.map((s) => ({ studio: s, value: compute(new Set([s.id])) })),
        })),
        (r) => (col?.sort ? col.sort(r.value) : null),
      );
  const total = loading ? null : compute(new Set(studios.map((s) => s.id)));
  const num = "text-right [&>span]:justify-end";

  return (
    <>
      {groups.length > 1 && (
        <div className="flex justify-end gap-1 border-b px-2 py-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen("all")}>
            Раскрыть все
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(new Set())}>
            Свернуть
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-48">{firstLabel}</TableHead>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                tip={c.tip}
                className={num}
                {...(c.sort ? sort.head(c.key) : {})}
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading || !total ? (
            <TableSkeletonRows columns={columns.length + 1} rows={6} />
          ) : (
            <>
              {groups.length > 1 && (
                <TableRow className="bg-violet-50/70 font-semibold hover:bg-violet-50">
                  <TableCell>Итого по сети</TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="text-right">
                      {c.render(total)}
                    </TableCell>
                  ))}
                </TableRow>
              )}
              {rows.map((r) => {
                const isOpen = expanded(r.group.city);
                return (
                  <Fragment key={r.group.city}>
                    <TableRow
                      className={cn("font-medium", !r.group.open && "text-muted-foreground")}
                    >
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggle(r.group.city)}
                          aria-expanded={isOpen}
                          className="inline-flex items-center gap-1.5 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {r.group.city}
                          <span className="text-xs font-normal text-muted-foreground">
                            · {r.group.studios.length}
                          </span>
                        </button>
                      </TableCell>
                      {columns.map((c) => (
                        <TableCell key={c.key} className="text-right">
                          {c.render(r.value)}
                        </TableCell>
                      ))}
                    </TableRow>
                    {isOpen &&
                      order(r.studios, (x) => (col?.sort ? col.sort(x.value) : null)).map((x) => (
                        <TableRow
                          key={x.studio.id}
                          className={cn(
                            isClosed(x.studio, today) && "text-muted-foreground",
                            onPick && "cursor-pointer",
                          )}
                          onClick={onPick ? () => onPick(x.studio) : undefined}
                        >
                          <TableCell className="pl-9">
                            <span className="inline-flex items-center gap-2">
                              {x.studio.name}
                              {isClosed(x.studio, today) && (
                                <StatusChip tone="neutral" size="sm">
                                  закрыта
                                </StatusChip>
                              )}
                            </span>
                          </TableCell>
                          {columns.map((c) => (
                            <TableCell key={c.key} className="text-right">
                              {c.render(x.value)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
            </>
          )}
        </TableBody>
      </Table>
    </>
  );
}
