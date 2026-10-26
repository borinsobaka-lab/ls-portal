import { lazy, Suspense, type ReactNode } from "react";

import { DashboardRankSkeleton } from "@/components/page-skeletons";
import { FieldHint } from "@/components/ui/field-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Блоки графиков дашборда: белая панель с заголовком и «?», область графика
 * со своими состояниями (загрузка, ошибка, пусто), рейтинг «Топ 10» и легенда
 * круговой диаграммы. Сами графики (recharts) — в ./plots.tsx отдельным
 * чанком.
 */

// recharts (~100 kB gzip) — только чанком: дашборд открывается первым после входа.
export const DailyPlot = lazy(() => import("./plots").then((m) => ({ default: m.DailyPlot })));
export const RatesPlot = lazy(() => import("./plots").then((m) => ({ default: m.RatesPlot })));
export const PiePlot = lazy(() => import("./plots").then((m) => ({ default: m.PiePlot })));
export const CategoryPlot = lazy(() =>
  import("./plots").then((m) => ({ default: m.CategoryPlot })),
);

export function ChartPanel({
  title,
  tip,
  summary,
  className,
  children,
}: {
  title: string;
  tip: ReactNode;
  /** Итог справа от заголовка (сумма за период и т. п.). */
  summary?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border bg-background p-3 sm:p-4", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          {title}
          <FieldHint>{tip}</FieldHint>
        </h3>
        {summary !== undefined && (
          <div className="text-sm text-muted-foreground tabular-nums">{summary}</div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Область графика фиксированной высоты: пока данных нет — болванка той же
 * высоты, ошибка и «нет данных» — текстом по центру.
 */
export function ChartArea({
  height,
  loading,
  error,
  empty,
  emptyText = "Нет данных за период",
  children,
}: {
  height: number;
  loading: boolean;
  error?: boolean;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative" style={{ height }}>
      {loading ? (
        <Skeleton className="h-full w-full" />
      ) : error ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Не удалось загрузить данные
        </div>
      ) : empty ? (
        <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <Suspense fallback={<Skeleton className="h-full w-full" />}>{children}</Suspense>
      )}
    </div>
  );
}

export type RankItem = { key: string; label: string; value: number; note?: string };

/** «Топ 10»: место, название, полоса доли от лидера и значение. */
export function RankList({
  items,
  loading,
  error,
  format,
  color,
  emptyText = "Нет данных за период",
  rows = 10,
}: {
  items: RankItem[];
  loading: boolean;
  error?: boolean;
  format: (n: number) => string;
  color: string;
  emptyText?: string;
  rows?: number;
}) {
  if (loading) return <DashboardRankSkeleton rows={rows} />;
  if (error || items.length === 0)
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {error ? "Не удалось загрузить данные" : emptyText}
      </div>
    );
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return (
    <ol className="space-y-2">
      {items.map((item, idx) => (
        <li
          key={item.key}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2"
        >
          <span className="text-xs text-muted-foreground tabular-nums">{idx + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-sm" title={item.label}>
              {item.label}
              {item.note && <span className="text-muted-foreground"> · {item.note}</span>}
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${(item.value / max) * 100}%`, backgroundColor: color }}
              />
            </div>
          </div>
          <span className="text-sm font-semibold tabular-nums">{format(item.value)}</span>
        </li>
      ))}
    </ol>
  );
}

export type Slice = { key: string; label: string; value: number; color: string };

/** Легенда круговой диаграммы: цвет, подпись, значение и доля. */
export function PieLegend({ slices, format }: { slices: Slice[]; format: (n: number) => string }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <ul className="mt-3 space-y-1.5">
      {slices.map((s) => (
        <li key={s.key} className="flex items-center gap-2 text-sm">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
          <span className="min-w-0 flex-1 truncate" title={s.label}>
            {s.label}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {Math.round((s.value / total) * 100)}%
          </span>
          <span className="w-24 text-right font-medium tabular-nums">{format(s.value)}</span>
        </li>
      ))}
    </ul>
  );
}
