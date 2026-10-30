import type { RevenueMetric } from "@/lib/analytics/onec-reports/revenue";

/**
 * Плитки сводки доски «Выручка» (их .summary): подпись, значение и
 * пояснение под ним — строки общей сетки (subgrid), как у плиток дашборда:
 * значения ряда на одной высоте, даже если подпись заняла две строки.
 */
export function RevenueSummary({ metrics }: { metrics: RevenueMetric[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 2xl:grid-cols-6">
      {metrics.map((m) => (
        <div
          key={m.key}
          className="row-span-3 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <span className="text-xs font-medium text-muted-foreground sm:text-sm">{m.label}</span>
          <span className="text-lg font-semibold tabular-nums sm:text-xl">{m.value}</span>
          <span className="text-xs text-muted-foreground">{m.note}</span>
        </div>
      ))}
    </div>
  );
}
