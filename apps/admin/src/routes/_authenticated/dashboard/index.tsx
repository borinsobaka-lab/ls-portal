import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { min } from "date-fns";

import { ChartArea, ChartPanel, DailyPlot, RatesPlot } from "@/components/dashboard/chart-panel";
import { SALE_ORIGIN_COLOR } from "@/components/dashboard/colors";
import { DashboardShell, type DashboardView } from "@/components/dashboard/dashboard-shell";
import { useSalesHistory } from "@/components/dashboard/queries";
import { StatGrid, type StatDef } from "@/components/dashboard/stat-cards";
import { DashboardOverviewSkeleton, DashboardPageSkeleton } from "@/components/page-skeletons";
import {
  dailySeries,
  membershipPayments,
  otherPayments,
  renewalRates,
} from "@/lib/dashboard-analytics";
import {
  OVERVIEW_LISTS,
  OVERVIEW_SERIES,
  loadPeriodMetrics,
  loadSnapshotMetrics,
  loadVisitDates,
  reportErrors,
  toISO,
  type OverviewMetrics,
  type Period,
} from "@/lib/dashboard-data";
import {
  DASHBOARD_CHART_HEIGHT,
  DASHBOARD_TITLES,
  OVERVIEW_CHARTS,
  OVERVIEW_GRID,
  OVERVIEW_STATS,
  type OverviewKey,
} from "@/lib/dashboard-stats";
import { formatMoney, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard/")({
  head: () => ({ meta: [{ title: "Дашборд — Base40 Admin" }] }),
  pendingComponent: DashboardPageSkeleton,
  component: OverviewPage,
});

const STATS: StatDef<OverviewKey>[] = OVERVIEW_STATS.map((s) => ({
  ...s,
  series: OVERVIEW_SERIES[s.key],
  list: OVERVIEW_LISTS[s.key],
}));

/** Цвета линий — как у продлений и возвратов в долях «Продаж». */
const RATE_COLORS = { renewal: SALE_ORIGIN_COLOR.renewal, returnRate: SALE_ORIGIN_COLOR.return };

function OverviewPage() {
  return (
    <DashboardShell title={DASHBOARD_TITLES.overview} skeleton={<DashboardOverviewSkeleton />}>
      {(view) => <OverviewBody {...view} />}
    </DashboardShell>
  );
}

/**
 * Графики «по дням» — до сегодняшнего дня: будущие дни выбранного месяца
 * всегда пустые и только сжимают прошедшие.
 */
function untilToday(period: Period): Period {
  const today = toISO(new Date());
  return period.from <= today && period.to > today ? { from: period.from, to: today } : period;
}

function OverviewBody(view: DashboardView) {
  const { period, prev, periodEnd } = view;

  // Выбранный и предыдущий периоды меняются вместе (по выбору дат) — один
  // запрос; ответ на уже неактуальный период React Query отбросит сам.
  const periodQuery = useQuery({
    queryKey: ["dashboard", view.scope, "overview", period?.from, period?.to],
    queryFn: async () => {
      const [current, previous] = await Promise.all([
        loadPeriodMetrics(view.clubIds, period!.from, period!.to),
        loadPeriodMetrics(view.clubIds, prev!.from, prev!.to),
      ]);
      reportErrors(`${view.name}: часть показателей за период не загрузилась`, [
        ...current.errors,
        ...previous.errors,
      ]);
      return { current: current.metrics, previous: previous.metrics };
    },
    enabled: !!period,
    meta: { errorMessage: `${view.name}: не удалось загрузить показатели за период` },
  });

  // Метрики «на сейчас» от периода не зависят: грузим их один раз, а не для
  // каждого из двух периодов при каждой смене дат.
  const snapshotQuery = useQuery({
    queryKey: ["dashboard", view.scope, "snapshot"],
    queryFn: async () => {
      const { metrics, errors } = await loadSnapshotMetrics(view.clubIds);
      reportErrors(`${view.name}: часть текущих показателей не загрузилась`, errors);
      return metrics;
    },
    meta: { errorMessage: `${view.name}: не удалось загрузить текущие показатели` },
  });

  const chartPeriod = period && untilToday(period);
  const chartFrom = chartPeriod?.from;
  const chartTo = chartPeriod?.to;
  const history = useSalesHistory(view);
  const visitsQuery = useQuery({
    queryKey: ["dashboard", view.scope, "visit-dates", chartFrom, chartTo],
    queryFn: () => loadVisitDates(view.clubIds, chartFrom!, chartTo!),
    enabled: !!chartPeriod,
    meta: { errorMessage: `${view.name}: не удалось загрузить посещения по дням` },
  });

  const revenue = useMemo(() => {
    if (!history.data || !chartFrom || !chartTo) return null;
    const h = history.data;
    const points = [...membershipPayments(h.sales), ...otherPayments(h.otherSales)].map((p) => ({
      date: p.date,
      value: p.amount,
    }));
    for (const r of h.refunds) points.push({ date: r.date, value: -r.amount });
    return dailySeries(points, chartFrom, chartTo);
  }, [history.data, chartFrom, chartTo]);

  const rateAnchor = toISO(min([periodEnd, new Date()]));
  const rates = useMemo(
    () => history.data && renewalRates(history.data.sales, new Date(`${rateAnchor}T00:00:00`)),
    [history.data, rateAnchor],
  );

  const visits = useMemo(
    () =>
      visitsQuery.data && chartFrom && chartTo
        ? dailySeries(
            visitsQuery.data.map((date) => ({ date, value: 1 })),
            chartFrom,
            chartTo,
          )
        : null,
    [visitsQuery.data, chartFrom, chartTo],
  );

  // Нет данных (ошибка загрузки, период не выбран) — в карточке «—», а не 0.
  const current: Partial<OverviewMetrics> = { ...periodQuery.data?.current, ...snapshotQuery.data };
  const previous: Partial<OverviewMetrics> = periodQuery.data?.previous ?? {};
  const color = view.color;
  const revenueTotal = revenue?.reduce((s, d) => s + d.value, 0);
  const visitsTotal = visits?.reduce((s, d) => s + d.value, 0);

  return (
    <>
      <StatGrid
        target={view}
        stats={STATS}
        current={current}
        previous={previous}
        loading={periodQuery.isLoading || snapshotQuery.isLoading}
        periodEnd={periodEnd}
        className={OVERVIEW_GRID}
      />

      <ChartPanel
        title={OVERVIEW_CHARTS.revenue.title}
        tip={OVERVIEW_CHARTS.revenue.tip}
        summary={revenueTotal !== undefined && `Итого ${formatMoney(revenueTotal)}`}
      >
        <ChartArea
          height={DASHBOARD_CHART_HEIGHT}
          loading={history.isLoading}
          error={history.isError}
          empty={!revenue || revenue.every((d) => d.value === 0)}
        >
          <DailyPlot data={revenue ?? []} color={color} format={formatMoney} />
        </ChartArea>
      </ChartPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel
          title={OVERVIEW_CHARTS.rates.title}
          tip={OVERVIEW_CHARTS.rates.tip}
          summary={
            <span className="inline-flex flex-wrap gap-x-3 text-xs">
              <LegendDot color={RATE_COLORS.renewal} label="Продления" />
              <LegendDot color={RATE_COLORS.returnRate} label="Возвращения" />
            </span>
          }
        >
          <ChartArea
            height={DASHBOARD_CHART_HEIGHT}
            loading={history.isLoading}
            error={history.isError}
            empty={!rates || rates.every((r) => r.renewalBase === 0 && r.returnBase === 0)}
            emptyText="Нет данных за 5 месяцев"
          >
            <RatesPlot data={rates ?? []} colors={RATE_COLORS} />
          </ChartArea>
        </ChartPanel>

        <ChartPanel
          title={OVERVIEW_CHARTS.visits.title}
          tip={OVERVIEW_CHARTS.visits.tip}
          summary={visitsTotal !== undefined && `Всего ${formatNumber(visitsTotal)}`}
        >
          <ChartArea
            height={DASHBOARD_CHART_HEIGHT}
            loading={visitsQuery.isLoading}
            error={visitsQuery.isError}
            empty={!visits || visitsTotal === 0}
          >
            <DailyPlot data={visits ?? []} color={color} format={formatNumber} />
          </ChartArea>
        </ChartPanel>
      </div>
    </>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
