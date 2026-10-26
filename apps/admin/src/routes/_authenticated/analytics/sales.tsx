import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { CityTreeTable } from "@/components/analytics/city-tree";
import { NomenclatureTable } from "@/components/analytics/nomenclature";
import { KpiGrid, KpiTile, TableCard } from "@/components/analytics/parts";
import { ChartArea, ChartPanel, DailyPlot } from "@/components/dashboard/chart-panel";
import {
  AnalyticsSalesBodySkeleton,
  AnalyticsSalesPageSkeleton,
} from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { salesQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, NOMENCLATURE_OPTIONS, SALES_TILES } from "@/lib/analytics/labels";
import {
  change,
  formatRub,
  monthStarts,
  salesByMonth,
  salesSummary,
  shiftPeriod,
  type NomenclatureFilter,
  type SalesSummary,
} from "@/lib/analytics/logic";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/sales")({
  head: () => ({ meta: [{ title: "Продажи абонементов — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsSalesPageSkeleton,
  component: SalesPage,
});

/** Месяцев на графиках (как у Lady Stretch). */
const CHART_MONTHS = 9;
const CHART_HEIGHT = 240;

function SalesPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.sales}
      kinds={["sales"]}
      skeleton={<AnalyticsSalesBodySkeleton />}
    >
      {(view) => <SalesBody {...view} />}
    </AnalyticsShell>
  );
}

function SalesBody({ studios, ids, idSet, period, today, update }: AnalyticsView) {
  const cur = useQuery(salesQuery(ids, period, "month"));
  const prevMonth = useQuery(salesQuery(ids, shiftPeriod(period, -1), "month"));
  const prevYear = useQuery(salesQuery(ids, shiftPeriod(period, -12), "month"));
  const months = monthStarts(period.to, CHART_MONTHS);
  const chart = useQuery(salesQuery(ids, { from: months[0], to: period.to }, "month"));
  const [nomFilter, setNomFilter] = useState<NomenclatureFilter>("all");

  if (cur.isError)
    return <InfoNote variant="warning">Не удалось загрузить продажи. Обновите страницу.</InfoNote>;

  const loading = cur.isLoading;
  const s = cur.data && salesSummary(cur.data, idSet);
  const pm = prevMonth.data && salesSummary(prevMonth.data, idSet);
  const py = prevYear.data && salesSummary(prevYear.data, idSet);
  // Сравнение — с теми же датами прошлого месяца и прошлого года.
  const tile = (k: keyof typeof SALES_TILES, show: (x: SalesSummary) => string) => {
    const key = k as keyof SalesSummary;
    return (
      <KpiTile
        key={k}
        {...SALES_TILES[k]}
        loading={loading}
        value={s && show(s)}
        deltas={[
          { label: "к пр. месяцу", value: s && pm ? change(s[key], pm[key]) : null },
          { label: "к пр. году", value: s && py ? change(s[key], py[key]) : null },
        ]}
      />
    );
  };
  const points = chart.data ? salesByMonth(chart.data, idSet, months) : [];
  const data = cur.data;

  return (
    <div className="space-y-3">
      <KpiGrid cols={6}>
        {tile("sold", (x) => formatNumber(x.sold))}
        {tile("newSold", (x) => formatNumber(x.newSold))}
        {tile("repeatSold", (x) => formatNumber(x.repeatSold))}
        {tile("paid", (x) => formatRub(x.paid))}
        {tile("newPaid", (x) => formatRub(x.newPaid))}
        {tile("repeatPaid", (x) => formatRub(x.repeatPaid))}
      </KpiGrid>
      <KpiGrid cols={3}>
        {tile("avgCheck", (x) => formatRub(x.avgCheck))}
        {tile("avgNew", (x) => formatRub(x.avgNew))}
        {tile("avgRepeat", (x) => formatRub(x.avgRepeat))}
      </KpiGrid>
      {s && s.unknown > 0 && (
        <InfoNote>
          У {formatNumber(s.unknown)} продаж в выгрузке нет кода клиента — они в «Продано» и
          «Оплатах», но не в новых и повторных.
        </InfoNote>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        <ChartPanel title="Продано по месяцам" tip={SALES_TILES.sold.tip}>
          <ChartArea height={CHART_HEIGHT} loading={chart.isLoading} error={chart.isError}>
            <DailyPlot
              data={points.map((p) => ({ tick: p.label, label: p.label, value: p.sold }))}
              color="var(--brand)"
              format={formatNumber}
            />
          </ChartArea>
        </ChartPanel>
        <ChartPanel title="Оплаты по месяцам" tip={SALES_TILES.paid.tip}>
          <ChartArea height={CHART_HEIGHT} loading={chart.isLoading} error={chart.isError}>
            <DailyPlot
              data={points.map((p) => ({ tick: p.label, label: p.label, value: p.paid }))}
              color="var(--brand)"
              format={(v) => formatRub(v)}
            />
          </ChartArea>
        </ChartPanel>
      </div>
      <TableCard title="Города и студии">
        <CityTreeTable
          studios={studios}
          today={today}
          loading={loading || !data}
          compute={(set) =>
            data ? salesSummary(data, set) : salesSummary({ sold: [], names: {} }, set)
          }
          onPick={(st) => update({ clubId: st.id })}
          columns={[
            {
              key: "sold",
              label: "Продано",
              tip: SALES_TILES.sold.tip,
              render: (v) => formatNumber(v.sold),
              sort: (v) => v.sold,
            },
            {
              key: "new",
              label: "Новые",
              tip: SALES_TILES.newSold.tip,
              render: (v) => formatNumber(v.newSold),
              sort: (v) => v.newSold,
            },
            {
              key: "renewals",
              label: "Продления",
              render: (v) => formatNumber(v.renewals),
              sort: (v) => v.renewals,
            },
            {
              key: "returns",
              label: "Возвращённые",
              render: (v) => formatNumber(v.returns),
              sort: (v) => v.returns,
            },
            {
              key: "paid",
              label: "Оплаты",
              tip: SALES_TILES.paid.tip,
              render: (v) => formatRub(v.paid),
              sort: (v) => v.paid,
            },
            {
              key: "avg",
              label: "Средний чек",
              tip: SALES_TILES.avgCheck.tip,
              render: (v) => formatRub(v.avgCheck),
              sort: (v) => v.avgCheck,
            },
          ]}
        />
      </TableCard>
      <TableCard
        title="Что покупают"
        tip="Номенклатуры проданных абонементов: число продаж и оплаты."
        actions={
          <SegmentedControl
            aria-label="Какие продажи"
            value={nomFilter}
            onChange={setNomFilter}
            options={NOMENCLATURE_OPTIONS}
          />
        }
      >
        <NomenclatureTable data={data} ids={idSet} filter={nomFilter} />
      </TableCard>
    </div>
  );
}
