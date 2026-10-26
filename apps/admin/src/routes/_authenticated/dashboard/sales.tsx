import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  ChartArea,
  ChartPanel,
  PieLegend,
  PiePlot,
  RankList,
  type Slice,
} from "@/components/dashboard/chart-panel";
import { OTHER_COLOR, SALE_ORIGIN_COLOR, SERIES_COLORS } from "@/components/dashboard/colors";
import { DashboardShell, type DashboardView } from "@/components/dashboard/dashboard-shell";
import { useSalesHistory } from "@/components/dashboard/queries";
import { StatGrid, type StatDef } from "@/components/dashboard/stat-cards";
import {
  DashboardPieSkeleton,
  DashboardSalesPageSkeleton,
  DashboardSalesSkeleton,
} from "@/components/page-skeletons";
import {
  SALE_ORIGIN_LABEL,
  classifySales,
  foldSlices,
  groupSum,
  inPeriod,
  membershipPayments,
  otherPayments,
  salesMetrics,
  sumBy,
  type SaleOrigin,
} from "@/lib/dashboard-analytics";
import type { SalesHistory, SeriesDef } from "@/lib/dashboard-data";
import {
  ORIGIN_BADGE,
  boughtSince,
  conversionBadge,
  saleDetail,
  type DetailsSpec,
} from "@/lib/dashboard-details";
import type { SeriesPoint } from "@/lib/dashboard-series";
import {
  DASHBOARD_PIE_HEIGHT,
  DASHBOARD_TITLES,
  SALES_CHARTS,
  SALES_GRID,
  SALES_STATS,
  type SalesKey,
} from "@/lib/dashboard-stats";
import { formatMoney } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from "@/lib/payments";

export const Route = createFileRoute("/_authenticated/dashboard/sales")({
  head: () => ({ meta: [{ title: "Продажи — Дашборд — Lady Stretch" }] }),
  pendingComponent: DashboardSalesPageSkeleton,
  component: SalesPage,
});

function SalesPage() {
  return (
    <DashboardShell title={DASHBOARD_TITLES.sales} skeleton={<DashboardSalesSkeleton />}>
      {(view) => <SalesBody {...view} />}
    </DashboardShell>
  );
}

const ORIGINS: SaleOrigin[] = ["new", "renewal", "return", "single"];

const MONEY_ROWS = {
  unit: ["продажа", "продажи", "продаж"],
  format: "money",
  totalLabel: "Итого",
  empty: "Продаж нет",
} as const satisfies Partial<DetailsSpec>;

/**
 * Графики плиток «Продаж» — из уже загруженной истории продаж: окно графика
 * не ходит в базу. Точки вне 12 корзин графика отбрасывает aggregate. У
 * каждой точки — строка подробного отчёта (кто купил, что, тип продажи).
 */
function salesSeries(history: SalesHistory): Record<SalesKey, SeriesDef> {
  const origins = classifySales(history.sales);
  const salesById = new Map(history.sales.map((s) => [s.id, s]));
  const sold: SeriesPoint[] = history.sales.map((s) => ({
    date: s.soldAt,
    amount: s.totalAmount,
    n: 1,
    row: saleDetail(s, { badge: ORIGIN_BADGE[origins.get(s.id) ?? "new"] }),
  }));
  const paid: SeriesPoint[] = membershipPayments(history.sales).map((p, i) => {
    const sale = salesById.get(p.saleId);
    const method = p.method && PAYMENT_METHOD_LABEL[p.method as PaymentMethod];
    return {
      date: p.date,
      amount: p.amount,
      n: 1,
      row: {
        key: `payment:${p.saleId}:${i}`,
        date: p.date,
        clientId: p.clientId,
        title: sale?.membershipName,
        note: method || undefined,
        value: p.amount,
      },
    };
  });
  const others: SeriesPoint[] = history.otherSales.map((s) => ({
    date: s.soldAt,
    amount: s.totalAmount,
    n: 1,
    row: {
      key: `other:${s.id}`,
      date: s.soldAt,
      clientId: s.clientId,
      title: s.itemName,
      value: s.totalAmount,
    },
  }));
  // Разовое посещение — шаг до пакета: кто так и не купил, тех зовём первыми.
  const singles: SeriesPoint[] = history.sales
    .filter((s) => s.single && !s.noMembership)
    .map((s) => {
      const bought = boughtSince(history.sales, s.clientId, s.soldAt);
      return {
        date: s.soldAt,
        amount: s.totalAmount,
        n: 1,
        row: saleDetail(s, { badge: conversionBadge(bought), attention: !bought }),
      };
    });
  const def = (
    kind: SeriesDef["kind"],
    description: string,
    points: SeriesPoint[],
    details: DetailsSpec,
  ): SeriesDef => ({ kind, description, details, load: async () => points });
  const soldList = (sort: DetailsSpec["sort"]): DetailsSpec => ({
    title: "Проданные абонементы",
    sort,
    ...MONEY_ROWS,
  });
  const paidList = (sort: DetailsSpec["sort"]): DetailsSpec => ({
    title: "Поступившие платежи",
    sort,
    ...MONEY_ROWS,
    unit: ["платёж", "платежа", "платежей"],
    empty: "Платежей нет",
  });
  const otherList = (sort: DetailsSpec["sort"]): DetailsSpec => ({
    title: "Прочие продажи",
    sort,
    ...MONEY_ROWS,
  });
  const singleList: DetailsSpec = {
    title: "Разовые посещения — предложить пакет",
    sort: "dateDesc",
    ...MONEY_ROWS,
  };
  return {
    membershipRevenue: def(
      "sum",
      "стоимость проданных абонементов по дате продажи",
      sold,
      soldList("dateDesc"),
    ),
    membershipPayments: def(
      "sum",
      "поступившие платежи по абонементам",
      paid,
      paidList("dateDesc"),
    ),
    otherRevenue: def("sum", "прочие продажи: услуги и товары", others, otherList("dateDesc")),
    singleRevenue: def("sum", "стоимость проданных разовых посещений", singles, singleList),
    singleVisits: def("count", "проданные разовые посещения", singles, singleList),
    avgMembershipCheck: def(
      "avg",
      "стоимость проданных абонементов / число продаж",
      sold,
      soldList("value"),
    ),
    avgMembershipPayment: def(
      "avg",
      "платежи по абонементам / число платежей",
      paid,
      paidList("value"),
    ),
    avgOtherCheck: def("avg", "прочие продажи / их число", others, otherList("value")),
  };
}

function SalesBody(view: DashboardView) {
  const { period, prev, periodEnd } = view;
  const history = useSalesHistory(view);
  const h = history.data;
  const color = view.color;

  const stats = useMemo<StatDef<SalesKey>[]>(() => {
    const series = h ? salesSeries(h) : null;
    return SALES_STATS.map((s) => ({ ...s, series: series?.[s.key] }));
  }, [h]);

  const from = period?.from;
  const to = period?.to;
  const data = useMemo(() => {
    if (!h || !from || !to) return null;
    const salesById = new Map(h.sales.map((s) => [s.id, s]));
    const itemById = new Map(h.otherSales.map((s) => [s.id, s.itemName]));
    const membership = membershipPayments(h.sales).filter((p) => inPeriod(p.date, from, to));
    const other = otherPayments(h.otherSales).filter((p) => inPeriod(p.date, from, to));

    // Новые / продления / возвраты — по выручке проданных за период абонементов.
    const origins = classifySales(h.sales);
    const sold = h.sales.filter((s) => inPeriod(s.soldAt, from, to));
    const originSlices: Slice[] = ORIGINS.map((origin) => ({
      key: origin,
      label: SALE_ORIGIN_LABEL[origin],
      value: sumBy(
        sold.filter((s) => origins.get(s.id) === origin),
        (s) => s.totalAmount,
      ),
      color: SALE_ORIGIN_COLOR[origin],
    })).filter((s) => s.value > 0);

    // Способы оплаты — цвет закреплён за способом, а не за местом по сумме.
    const byMethod = groupSum(
      [...membership, ...other],
      (p) => p.method ?? "none",
      (p) => p.amount,
    );
    const methodSlices: Slice[] = byMethod
      .filter((g) => g.value > 0)
      .map((g) => {
        const idx = PAYMENT_METHODS.indexOf(g.key as PaymentMethod);
        return {
          key: g.key,
          label: idx >= 0 ? PAYMENT_METHOD_LABEL[g.key as PaymentMethod] : "Не указан",
          value: g.value,
          color: idx >= 0 ? SERIES_COLORS[idx] : OTHER_COLOR,
        };
      });

    // Предмет оплаты: абонементы и позиции прочих продаж (хвост — «Остальное»).
    const items = foldSlices(
      groupSum(
        other,
        (p) => itemById.get(p.saleId) ?? "—",
        (p) => p.amount,
      ).map((g) => ({ key: g.key, label: g.key, value: g.value })),
      SERIES_COLORS.length - 1,
    );
    const subjectSlices: Slice[] = [
      {
        key: "__memberships",
        label: "Абонементы",
        value: sumBy(membership, (p) => p.amount),
        color: SERIES_COLORS[0],
      },
      ...items.map((s, i) => ({
        ...s,
        color: s.key === "__other" ? OTHER_COLOR : SERIES_COLORS[i + 1],
      })),
    ].filter((s) => s.value > 0);

    const topMemberships = groupSum(
      membership,
      (p) => salesById.get(p.saleId)?.membershipName ?? "Без названия",
      (p) => p.amount,
    )
      .slice(0, 10)
      .map((g) => ({ key: g.key, label: g.key, value: g.value, note: payments(g.n) }));

    // Ответственный — администратор из справочника (seller_id), подпись —
    // снимок имени из самой поздней его продажи (история — по дате продажи);
    // у старых продаж без продавца — «Не указан».
    const sellerName = new Map(h.sales.map((s) => [s.sellerKey ?? "none", s.sellerName]));
    const topSellers = groupSum(
      membership,
      (p) => salesById.get(p.saleId)?.sellerKey ?? "none",
      (p) => p.amount,
    )
      .slice(0, 10)
      .map((g) => ({
        key: g.key,
        label: sellerName.get(g.key) || "Не указан",
        value: g.value,
        note: payments(g.n),
      }));

    return { originSlices, methodSlices, subjectSlices, topMemberships, topSellers };
  }, [h, from, to]);

  const current = h && period ? salesMetrics(h, period.from, period.to) : {};
  const previous = h && prev ? salesMetrics(h, prev.from, prev.to) : {};
  const loading = history.isLoading;

  return (
    <>
      <StatGrid
        target={view}
        stats={stats}
        current={current}
        previous={previous}
        loading={loading}
        periodEnd={periodEnd}
        className={SALES_GRID}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <PiePanel
          chart={SALES_CHARTS.origin}
          slices={data?.originSlices}
          loading={loading}
          error={history.isError}
        />
        <PiePanel
          chart={SALES_CHARTS.methods}
          slices={data?.methodSlices}
          loading={loading}
          error={history.isError}
        />
        <PiePanel
          chart={SALES_CHARTS.subjects}
          slices={data?.subjectSlices}
          loading={loading}
          error={history.isError}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel title={SALES_CHARTS.topMemberships.title} tip={SALES_CHARTS.topMemberships.tip}>
          <RankList
            items={data?.topMemberships ?? []}
            loading={loading}
            error={history.isError}
            format={formatMoney}
            color={color}
          />
        </ChartPanel>
        <ChartPanel title={SALES_CHARTS.topSellers.title} tip={SALES_CHARTS.topSellers.tip}>
          <RankList
            items={data?.topSellers ?? []}
            loading={loading}
            error={history.isError}
            format={formatMoney}
            color={color}
          />
        </ChartPanel>
      </div>
    </>
  );
}

function payments(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "платёж"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "платежа"
        : "платежей";
  return `${n} ${word}`;
}

function PiePanel({
  chart,
  slices,
  loading,
  error,
}: {
  chart: { title: string; tip: string };
  slices: Slice[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  const total = slices ? sumBy(slices, (s) => s.value) : undefined;
  return (
    <ChartPanel
      title={chart.title}
      tip={chart.tip}
      summary={total !== undefined && total > 0 && formatMoney(total)}
    >
      {loading ? (
        <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} />
      ) : (
        <>
          <ChartArea height={DASHBOARD_PIE_HEIGHT} loading={false} error={error}>
            <PiePlot slices={slices ?? []} format={formatMoney} />
          </ChartArea>
          {slices && slices.length > 0 && <PieLegend slices={slices} format={formatMoney} />}
        </>
      )}
    </ChartPanel>
  );
}
