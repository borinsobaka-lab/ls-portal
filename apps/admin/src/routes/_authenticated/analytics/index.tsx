import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { CityTreeTable } from "@/components/analytics/city-tree";
import { NomenclatureTable } from "@/components/analytics/nomenclature";
import { KpiGrid, KpiTile, TableCard } from "@/components/analytics/parts";
import { ChartArea, ChartPanel, DailyPlot } from "@/components/dashboard/chart-panel";
import { AnalyticsCityBodySkeleton, AnalyticsCityPageSkeleton } from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { classesQuery, revenueQuery, salesQuery, trialsQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, CITY_TILES, NOMENCLATURE_OPTIONS } from "@/lib/analytics/labels";
import {
  classesSummary,
  cityOf,
  forecast,
  formatRate,
  formatRub,
  lastFullDay,
  monthLabel,
  monthPeriod,
  monthStarts,
  pointZeroOf,
  salesSummary,
  sumRevenue,
  trialsSummary,
  type NomenclatureFilter,
} from "@/lib/analytics/logic";
import type { AnStudio, ClassRow, RevenueRow, SalesData, TrialRow } from "@/lib/analytics/types";
import { formatNumber } from "@/lib/format";

/**
 * «Мой город» — как у Lady Stretch: одна сводка по городу (или студии) за
 * период — выручка с прогнозом и точкой 0, продажи, что покупают,
 * посещения, пробные и таблица студий (нажатие — отчёт по студии). Партнёр
 * видит только свои города: их отдаёт база.
 */
export const Route = createFileRoute("/_authenticated/analytics/")({
  head: () => ({ meta: [{ title: "Мой город — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsCityPageSkeleton,
  component: CityPage,
});

const CHART_MONTHS = 6;

function CityPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.city}
      kinds={["revenue", "sales", "classes", "visits"]}
      skeleton={<AnalyticsCityBodySkeleton />}
    >
      {(view) => <CityBody {...view} />}
    </AnalyticsShell>
  );
}

/** Выручка за период (без сегодняшнего дня) и прогноз — если период и есть текущий месяц. */
function revenueOf(
  rows: RevenueRow[],
  ids: Set<string>,
  period: AnalyticsView["period"],
  today: string,
) {
  const month = monthPeriod(period.from);
  const end = lastFullDay(today) < period.to ? lastFullDay(today) : period.to;
  const fact = sumRevenue(rows, ids, period.from, end);
  const whole = period.from === month.from && period.to === month.to;
  return { fact, forecast: whole ? forecast(fact, month.from, today) : null };
}

type ClubLine = {
  revenue: number;
  forecast: number | null;
  sold: number;
  newSold: number;
  visits: number;
  attendance: number | null;
  trials: number | null;
};

function lineOf(
  ids: Set<string>,
  data: { revenue: RevenueRow[]; sales: SalesData; classes: ClassRow[]; trials: TrialRow[] },
  period: AnalyticsView["period"],
  today: string,
): ClubLine {
  const rev = revenueOf(data.revenue, ids, period, today);
  const s = salesSummary(data.sales, ids);
  const c = classesSummary(data.classes, ids);
  return {
    revenue: rev.fact,
    forecast: rev.forecast,
    sold: s.sold,
    newSold: s.newSold,
    visits: c.attended,
    attendance: c.attendance,
    trials: trialsSummary(data.trials, ids).d14Rate,
  };
}

function CityBody({ scope, studios, ids, idSet, period, today, filters, update }: AnalyticsView) {
  const revenue = useQuery(revenueQuery(ids, period));
  const months = monthStarts(period.to, CHART_MONTHS);
  const history = useQuery(revenueQuery(ids, { from: months[0], to: period.to }, "month"));
  const sales = useQuery(salesQuery(ids, period, "month"));
  const classes = useQuery(classesQuery(ids, period, "month"));
  const trials = useQuery(trialsQuery(ids, period, "month"));
  const [nomFilter, setNomFilter] = useState<NomenclatureFilter>("all");

  if (revenue.isError || sales.isError || classes.isError || trials.isError)
    return <InfoNote variant="warning">Не удалось загрузить отчёт. Обновите страницу.</InfoNote>;

  const rev = revenue.data && revenueOf(revenue.data, idSet, period, today);
  const pointZero = pointZeroOf(studios, scope.studios, scope.targets);
  const reach = rev ? (rev.forecast ?? rev.fact) : null;
  const s = sales.data && salesSummary(sales.data, idSet);
  const c = classes.data && classesSummary(classes.data, idSet);
  const t = trials.data && trialsSummary(trials.data, idSet);
  const cities = new Set(studios.map(cityOf));
  const title =
    filters.clubId && studios.length === 1
      ? `${cityOf(studios[0])} · ${studios[0].name}`
      : cities.size === 1
        ? [...cities][0]
        : `Городов: ${cities.size}`;
  const all =
    revenue.data && sales.data && classes.data && trials.data
      ? { revenue: revenue.data, sales: sales.data, classes: classes.data, trials: trials.data }
      : null;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <KpiGrid>
        <KpiTile
          {...CITY_TILES.revenue}
          loading={revenue.isLoading}
          value={rev && formatRub(rev.fact)}
        />
        <KpiTile
          {...CITY_TILES.forecast}
          loading={revenue.isLoading}
          value={rev && formatRub(rev.forecast)}
          note={rev && rev.forecast === null ? "для периода «текущий месяц»" : undefined}
        />
        <KpiTile
          {...CITY_TILES.pointZero}
          loading={revenue.isLoading}
          value={formatRub(pointZero)}
          note={
            pointZero !== null && reach !== null
              ? `${reach - pointZero >= 0 ? "выше" : "ниже"} на ${formatRub(Math.abs(reach - pointZero))} ${rev?.forecast !== null ? "по прогнозу" : "по факту"}`
              : pointZero === null
                ? "задаётся на город в «Точке 0»"
                : undefined
          }
        />
        <KpiTile
          {...CITY_TILES.sold}
          loading={sales.isLoading}
          value={s && formatNumber(s.sold)}
          note={s && `новых ${formatNumber(s.newSold)} · повторных ${formatNumber(s.repeatSold)}`}
        />
        <KpiTile
          {...CITY_TILES.avgCheck}
          loading={sales.isLoading}
          value={s && formatRub(s.avgCheck)}
          note={s && `оплаты ${formatRub(s.paid)}`}
        />
        <KpiTile
          {...CITY_TILES.visits}
          loading={classes.isLoading}
          value={c && formatNumber(c.attended)}
          note={c && `занятий ${formatNumber(c.classes)}`}
        />
        <KpiTile
          {...CITY_TILES.attendance}
          loading={classes.isLoading}
          value={c && formatRate(c.attendance, 1)}
          note={c && `записано ${formatNumber(c.booked)}`}
        />
        <KpiTile
          {...CITY_TILES.trials}
          loading={trials.isLoading}
          value={t && formatRate(t.d14Rate, 1)}
          note={
            t && `в день пробного ${formatRate(t.day0Rate, 1)} · пришли ${formatNumber(t.attended)}`
          }
        />
      </KpiGrid>

      <div className="grid gap-3 xl:grid-cols-2">
        <ChartPanel title="Выручка по месяцам" tip={CITY_TILES.revenue.tip}>
          <ChartArea height={240} loading={history.isLoading} error={history.isError}>
            <DailyPlot
              data={months.map((m) => ({
                tick: monthLabel(m),
                label: monthLabel(m, true),
                value: history.data ? sumRevenue(history.data, idSet, m, monthPeriod(m).to) : 0,
              }))}
              color="var(--brand)"
              format={(v) => formatRub(v)}
            />
          </ChartArea>
        </ChartPanel>
        <TableCard
          title="Что покупают"
          tip="Номенклатуры проданных абонементов за период."
          actions={
            <SegmentedControl
              aria-label="Какие продажи"
              value={nomFilter}
              onChange={setNomFilter}
              options={NOMENCLATURE_OPTIONS}
            />
          }
        >
          <NomenclatureTable data={sales.data} ids={idSet} filter={nomFilter} limit={8} />
        </TableCard>
      </div>

      <TableCard title="Студии" tip="Нажмите на студию — отчёт покажет только её.">
        <CityTreeTable<ClubLine>
          studios={studios}
          today={today}
          loading={!all}
          compute={(set) =>
            all
              ? lineOf(set, all, period, today)
              : {
                  revenue: 0,
                  forecast: null,
                  sold: 0,
                  newSold: 0,
                  visits: 0,
                  attendance: null,
                  trials: null,
                }
          }
          onPick={(st: AnStudio) => update({ clubId: st.id })}
          columns={[
            {
              key: "revenue",
              label: "Выручка",
              render: (v) => formatRub(v.revenue),
              sort: (v) => v.revenue,
            },
            {
              key: "forecast",
              label: "Прогноз",
              render: (v) => formatRub(v.forecast),
              sort: (v) => v.forecast,
            },
            {
              key: "sold",
              label: "Продано",
              render: (v) => formatNumber(v.sold),
              sort: (v) => v.sold,
            },
            {
              key: "new",
              label: "Новые",
              render: (v) => formatNumber(v.newSold),
              sort: (v) => v.newSold,
            },
            {
              key: "visits",
              label: "Посещения",
              render: (v) => formatNumber(v.visits),
              sort: (v) => v.visits,
            },
            {
              key: "attendance",
              label: "Доходимость",
              render: (v) => formatRate(v.attendance, 1),
              sort: (v) => v.attendance,
            },
            {
              key: "trials",
              label: "Пробные → 14 дн.",
              tip: CITY_TILES.trials.tip,
              render: (v) => formatRate(v.trials, 1),
              sort: (v) => v.trials,
            },
          ]}
        />
      </TableCard>
    </div>
  );
}
