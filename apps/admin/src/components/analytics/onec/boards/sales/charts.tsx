import { lazy, Suspense, type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import type { SalesCharts } from "@/lib/analytics/onec-reports/sales";
import { cn } from "@/lib/utils";

// recharts — отдельным чанком: таблица и плитки не ждут графиков.
const SalesBarPlot = lazy(() => import("./plots").then((m) => ({ default: m.SalesBarPlot })));
const SalesAmountPlot = lazy(() => import("./plots").then((m) => ({ default: m.SalesAmountPlot })));
const SalesSharePlot = lazy(() => import("./plots").then((m) => ({ default: m.SalesSharePlot })));

const HEIGHT = 168;

/** Три графика доски (их renderCharts): по месяцам, структура, динамика суммы. */
export function SalesChartsRow({ charts }: { charts: SalesCharts }) {
  const { months, donut } = charts;
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <ChartCard title="Продажи абонементов по месяцам">
        <PlotArea>
          <SalesBarPlot months={months} max={charts.maxSales} badge={charts.salesBadge} />
        </PlotArea>
      </ChartCard>
      <ChartCard title="Структура продаж">
        <div className="flex items-center justify-center gap-6" style={{ height: HEIGHT }}>
          <div className="relative size-36 shrink-0">
            <Suspense fallback={<Skeleton className="size-full rounded-full" />}>
              <SalesSharePlot newShare={donut.newShare} />
            </Suspense>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-semibold tabular-nums">{donut.total}</span>
              <span className="text-xs text-muted-foreground">продаж</span>
            </div>
          </div>
          <ul className="min-w-0 space-y-3 text-sm">
            <LegendItem
              label="Новые продажи"
              value={donut.newSales}
              percent={donut.newPercent}
              dotClass="bg-brand"
            />
            <LegendItem
              label="Повторные продажи"
              value={donut.repeatSales}
              percent={donut.repeatPercent}
              dotClass="bg-brand/25"
            />
          </ul>
        </div>
      </ChartCard>
      <ChartCard title="Динамика суммы продаж">
        <PlotArea>
          <SalesAmountPlot months={months} max={charts.maxAmount} badge={charts.amountBadge} />
        </PlotArea>
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="group min-w-0 rounded-lg border bg-background p-3 sm:p-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PlotArea({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: HEIGHT }}>
      <Suspense fallback={<Skeleton className="h-full w-full" />}>{children}</Suspense>
    </div>
  );
}

function LegendItem({
  label,
  value,
  percent,
  dotClass,
}: {
  label: string;
  value: string;
  percent: string;
  dotClass: string;
}) {
  return (
    <li className="grid grid-cols-[0.625rem_minmax(0,1fr)] items-center gap-x-2">
      <span className={cn("size-2.5 rounded-full", dotClass)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="col-start-2 tabular-nums">
        <span className="font-semibold">{value}</span>{" "}
        <span className="text-muted-foreground">({percent}%)</span>
      </span>
    </li>
  );
}
