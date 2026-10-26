import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ChartArea,
  ChartPanel,
  PieLegend,
  PiePlot,
  RankList,
  type Slice,
} from "@/components/dashboard/chart-panel";
import { OTHER_COLOR, SERIES_COLORS } from "@/components/dashboard/colors";
import { DashboardShell, type DashboardView } from "@/components/dashboard/dashboard-shell";
import { FunnelBars } from "@/components/dashboard/funnel";
import { MetricTable, ShareCell, type MetricRow } from "@/components/dashboard/metric-table";
import { useSalesHistory } from "@/components/dashboard/queries";
import { StatGrid, type StatDef, type StatList } from "@/components/dashboard/stat-cards";
import {
  DashboardFunnelSkeleton,
  DashboardMarketingPageSkeleton,
  DashboardMarketingSkeleton,
  DashboardPieSkeleton,
} from "@/components/page-skeletons";
import { GOAL_LABELS, REFERRAL_LABELS } from "@/lib/client-profile";
import { foldSlices, inPeriod } from "@/lib/dashboard-analytics";
import type { DetailRow, DetailsSpec } from "@/lib/dashboard-details";
import {
  OVERVIEW_SERIES,
  loadClientsData,
  loadNpsScores,
  loadProfileAnswers,
  loadVisitedClientIds,
  type SeriesDef,
} from "@/lib/dashboard-data";
import {
  NO_ANSWER,
  cohortByAnswer,
  marketingMetrics,
  marketingSeries,
  newClients,
  newClientsFunnel,
  npsPoints,
  promoCodes,
  type MarketingClient,
  type ProfileAnswers,
} from "@/lib/dashboard-marketing";
import type { SeriesPoint } from "@/lib/dashboard-series";
import {
  DASHBOARD_PIE_HEIGHT,
  DASHBOARD_TITLES,
  MARKETING_CHARTS,
  MARKETING_GRID,
  MARKETING_STATS,
  SOURCE_COLUMNS,
  formatStat,
  type MarketingKey,
} from "@/lib/dashboard-stats";
import { formatMoney, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard/marketing")({
  head: () => ({ meta: [{ title: "Маркетинг — Дашборд — Base40 Admin" }] }),
  pendingComponent: DashboardMarketingPageSkeleton,
  component: MarketingPage,
});

function MarketingPage() {
  return (
    <DashboardShell title={DASHBOARD_TITLES.marketing} skeleton={<DashboardMarketingSkeleton />}>
      {(view) => <MarketingBody {...view} />}
    </DashboardShell>
  );
}

/** Ответы «Откуда узнали» — цвет закреплён за ответом. */
const REFERRAL_KEYS = Object.keys(REFERRAL_LABELS);

/** Где оформлена продажа (sales.source) — подпись и цвет. */
const CHANNELS = [
  { key: "admin", label: "Оформил администратор", color: SERIES_COLORS[0] },
  { key: "mobile", label: "Купил в приложении", color: SERIES_COLORS[1] },
] as const;

const CLIENTS_UNIT: DetailsSpec["unit"] = ["клиент", "клиента", "клиентов"];
const SALES_UNIT: DetailsSpec["unit"] = ["продажа", "продажи", "продаж"];

const NPS_SERIES: SeriesDef = {
  kind: "avg",
  description: "ответы NPS: промоутеры минус критики",
  base: { label: "Ответов", empty: "нет ответов" },
  details: {
    title: "Ответы — критиков первыми",
    unit: ["ответ", "ответа", "ответов"],
    sort: "dateDesc",
    empty: "Ответов нет",
  },
  load: async (studioIds, from, to) => npsPoints(await loadNpsScores(studioIds, from, to)),
};

/** Графики плиток из уже загруженных продаж и клиентов: окно не ходит в базу. */
function seriesDefs(points: Partial<Record<MarketingKey, SeriesPoint[]>>) {
  const def = (
    key: MarketingKey,
    kind: SeriesDef["kind"],
    description: string,
    details: DetailsSpec,
    base?: SeriesDef["base"],
  ): SeriesDef => ({ kind, description, base, details, load: async () => points[key] ?? [] });
  const firsts: DetailsSpec = {
    title: "Первые покупки",
    unit: CLIENTS_UNIT,
    format: "money",
    totalLabel: "Итого",
    sort: "dateDesc",
    empty: "Новых покупателей нет",
  };
  return {
    newClients: OVERVIEW_SERIES.signups,
    newBuyers: def("newBuyers", "count", "клиенты по дате первой покупки абонемента", firsts),
    purchaseConversion: def(
      "purchaseConversion",
      "avg",
      "новые клиенты месяца регистрации, купившие абонемент",
      {
        title: "Новые клиенты — кто не купил, первыми",
        unit: CLIENTS_UNIT,
        dateLabel: "Добавлен",
        sort: "dateDesc",
        empty: "Новых клиентов нет",
      },
      { label: "Новых клиентов", empty: "нет новых клиентов" },
    ),
    trialConversion: def(
      "trialConversion",
      "avg",
      "пробные, после которых купили абонемент",
      {
        title: "Пробные — кто не купил, первыми",
        unit: CLIENTS_UNIT,
        dateLabel: "Пробное",
        sort: "dateDesc",
        empty: "Пробных нет",
      },
      { label: "Пробных", empty: "нет пробных" },
    ),
    firstRevenue: def(
      "firstRevenue",
      "sum",
      "стоимость первых абонементов новых покупателей",
      firsts,
    ),
    daysToPurchase: def(
      "daysToPurchase",
      "avg",
      "дней от регистрации до первой покупки",
      {
        title: "Покупатели — дольше всех думали сверху",
        unit: CLIENTS_UNIT,
        format: "days",
        sort: "value",
        empty: "Покупок нет",
      },
      { label: "Покупателей", empty: "нет покупок" },
    ),
    appSales: def("appSales", "avg", "доля абонементов, купленных в приложении", {
      title: "Проданные абонементы",
      unit: SALES_UNIT,
      format: "money",
      sort: "dateDesc",
      empty: "Продаж нет",
    }),
    nps: NPS_SERIES,
    discounts: def("discounts", "sum", "скидки от цены номенклатуры по дате продажи", {
      title: "Продажи со скидкой",
      unit: SALES_UNIT,
      format: "money",
      totalLabel: "Скидки",
      sort: "value",
      empty: "Скидок нет",
    }),
  } satisfies Partial<Record<MarketingKey, SeriesDef>>;
}

const APP_MEMBERS_DETAILS: DetailsSpec = {
  title: "Члены клуба — без приложения первыми",
  unit: CLIENTS_UNIT,
  dateLabel: "Добавлен",
  sort: "dateDesc",
  empty: "Членов клуба нет",
};

/** Члены клуба и вошли ли в приложение: не вошедшим не доходят пуши и новости. */
function appMemberRows(clients: MarketingClient[], memberIds: Set<string>): DetailRow[] {
  return clients
    .filter((c) => memberIds.has(c.id))
    .map((c) => ({
      key: `client:${c.id}`,
      date: c.registrationDate ?? "0000-01-01",
      dateText: c.registrationDate ? undefined : "—",
      clientId: c.id,
      badge: c.userId
        ? { text: "В приложении", tone: "good" as const }
        : { text: "Нет приложения", tone: "bad" as const },
      attention: !c.userId,
    }));
}

const percent = (n: number) => formatStat("percent", n);

function MarketingBody(view: DashboardView) {
  const { period, prev, periodEnd } = view;
  const color = view.color;
  const from = period?.from;
  const to = period?.to;
  const withTrials = view.clubs.every((c) => c.format === "packages");

  const history = useSalesHistory(view);
  // Тот же запрос, что у «Клиентов»: переход между подразделами — без загрузки.
  const clientsQuery = useQuery({
    queryKey: ["dashboard", view.scope, "clients"],
    queryFn: () => loadClientsData(view.clubIds),
    meta: { errorMessage: `${view.name}: не удалось загрузить клиентов для дашборда` },
  });
  const npsQuery = useQuery({
    queryKey: ["dashboard", view.scope, "nps", prev?.from, to],
    queryFn: () => loadNpsScores(view.clubIds, prev!.from, to!),
    enabled: !!period,
    meta: { errorMessage: `${view.name}: не удалось загрузить ответы NPS` },
  });

  const clients = useMemo<MarketingClient[] | undefined>(
    () =>
      clientsQuery.data?.clients.map((c) => ({
        id: c.id,
        userId: c.userId,
        registrationDate: c.registrationDate,
        ownClub: c.ownClub,
      })),
    [clientsQuery.data],
  );
  const cohort = useMemo(
    () => (clients && from && to ? newClients(clients, from, to) : undefined),
    [clients, from, to],
  );

  // Анкеты и посещения — только новых клиентов периода.
  const cohortQuery = useQuery({
    queryKey: ["dashboard", view.scope, "new-clients", from, to, cohort?.length],
    queryFn: async () => {
      const userIds = cohort!.flatMap((c) => (c.userId ? [c.userId] : []));
      const [profiles, visited] = await Promise.all([
        userIds.length ? loadProfileAnswers(userIds) : new Map<string, ProfileAnswers>(),
        loadVisitedClientIds(cohort!.map((c) => c.id)),
      ]);
      return { profiles, visited };
    },
    enabled: !!cohort && cohort.length > 0,
    meta: { errorMessage: `${view.name}: не удалось загрузить анкеты новых клиентов` },
  });
  // Новых клиентов нет — грузить нечего, анкеты пустые.
  const noCohort = cohort?.length === 0;
  const cohortData = useMemo(
    () =>
      noCohort
        ? { profiles: new Map<string, ProfileAnswers>(), visited: new Set<string>() }
        : cohortQuery.data,
    [noCohort, cohortQuery.data],
  );
  // Нет когорты (период не выбран, клиенты не загрузились) — не грузится и анкета.
  const cohortLoading = !!cohort && !cohortData && !cohortQuery.isError;

  const h = history.data;
  const memberIds = clientsQuery.data?.memberIds;
  const nps = npsQuery.data;

  const stats = useMemo<StatDef<MarketingKey>[]>(() => {
    const defs: Partial<Record<MarketingKey, SeriesDef>> =
      h && clients ? seriesDefs(marketingSeries({ sales: h.sales, clients })) : {};
    const appMembers: StatList = {
      details: APP_MEMBERS_DETAILS,
      rows: clients && memberIds && appMemberRows(clients, memberIds),
    };
    return MARKETING_STATS.map((s) => ({
      ...s,
      series: defs[s.key],
      list: s.key === "appMembers" ? appMembers : undefined,
    }));
  }, [h, clients, memberIds]);

  // NPS — отдельный запрос: не загрузился — «—» только у его плитки.
  const metrics = (p: typeof period) => {
    if (!h || !clients || !memberIds || !p) return {};
    const m = marketingMetrics(
      { sales: h.sales, clients, memberIds, nps: nps ?? [] },
      p.from,
      p.to,
    );
    return nps ? m : { ...m, nps: undefined };
  };

  const charts = useMemo(() => {
    if (!h || !cohort || !cohortData || !from || !to) return null;
    const funnel = newClientsFunnel(cohort, h.sales, cohortData.visited, withTrials);

    const sources = cohortByAnswer(cohort, cohortData.profiles, h.sales, (p) => p.referralSource);
    const sourceSlices: Slice[] = sources
      .filter((g) => g.key !== NO_ANSWER)
      .map((g) => {
        const idx = REFERRAL_KEYS.indexOf(g.key);
        return {
          key: g.key,
          label: REFERRAL_LABELS[g.key] ?? g.key,
          value: g.clients,
          color: idx >= 0 ? SERIES_COLORS[idx] : OTHER_COLOR,
        };
      });

    const goals = cohortByAnswer(cohort, cohortData.profiles, h.sales, (p) => p.goal);
    const goalSlices: Slice[] = foldSlices(
      goals
        .filter((g) => g.key !== NO_ANSWER)
        .map((g) => ({ key: g.key, label: GOAL_LABELS[g.key] ?? g.key, value: g.clients })),
      SERIES_COLORS.length,
    ).map((s, i) => ({ ...s, color: s.key === "__other" ? OTHER_COLOR : SERIES_COLORS[i] }));

    const sold = h.sales.filter((s) => inPeriod(s.soldAt, from, to));
    const channelSlices: Slice[] = CHANNELS.map((c) => ({
      ...c,
      value: sold.filter((s) => (s.source === "mobile" ? "mobile" : "admin") === c.key).length,
    })).filter((s) => s.value > 0);

    const promos = promoCodes(h.sales, from, to)
      .slice(0, 10)
      .map((p) => ({ key: p.key, label: p.key, value: p.value, note: salesText(p.n) }));

    const sourceRows: MetricRow[] = sources.map((g) => ({
      key: g.key,
      name: g.key === NO_ANSWER ? "Нет ответа в анкете" : (REFERRAL_LABELS[g.key] ?? g.key),
      muted: g.key === NO_ANSWER,
      values: {
        name: REFERRAL_LABELS[g.key] ?? g.key,
        clients: g.clients,
        buyers: g.buyers,
        conversion: g.conversion,
        revenue: g.revenue,
      },
      cells: {
        clients: formatNumber(g.clients),
        buyers: formatNumber(g.buyers),
        conversion:
          g.conversion === undefined ? undefined : (
            <ShareCell value={g.conversion} text={percent(g.conversion)} color={color} />
          ),
        revenue: formatMoney(g.revenue),
      },
    }));

    return { funnel, sourceSlices, goalSlices, channelSlices, promos, sourceRows };
  }, [h, cohort, cohortData, from, to, withTrials, color]);

  const loading = history.isLoading || clientsQuery.isLoading || npsQuery.isLoading;
  const chartsLoading = history.isLoading || clientsQuery.isLoading || cohortLoading;
  const chartsError = history.isError || clientsQuery.isError || cohortQuery.isError;
  const answered = (slices: Slice[] | undefined) =>
    slices &&
    cohort &&
    cohort.length > 0 &&
    `Ответили ${formatNumber(slices.reduce((s, x) => s + x.value, 0))} из ${formatNumber(cohort.length)}`;

  return (
    <>
      <StatGrid
        target={view}
        stats={stats}
        current={metrics(period)}
        previous={metrics(prev)}
        loading={loading}
        periodEnd={periodEnd}
        className={MARKETING_GRID}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <ChartPanel
          title={MARKETING_CHARTS.funnel.title}
          tip={MARKETING_CHARTS.funnel.tip}
          className="lg:col-span-2"
        >
          {chartsLoading ? (
            <DashboardFunnelSkeleton rows={withTrials ? 6 : 4} />
          ) : chartsError || !charts || cohort?.length === 0 ? (
            <Empty error={chartsError} text="Новых клиентов за период нет" />
          ) : (
            <FunnelBars steps={charts.funnel} color={color} />
          )}
        </ChartPanel>
        <CountPie
          chart={MARKETING_CHARTS.sources}
          slices={charts?.sourceSlices}
          summary={answered(charts?.sourceSlices)}
          loading={chartsLoading}
          error={chartsError}
          emptyText="Нет ответов"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <ChartPanel
          title={MARKETING_CHARTS.sourcesTable.title}
          tip={MARKETING_CHARTS.sourcesTable.tip}
          className="lg:col-span-2"
        >
          <MetricTable
            nameLabel="Источник"
            columns={Object.entries(SOURCE_COLUMNS).map(([key, c]) => ({ key, ...c }))}
            rows={charts?.sourceRows ?? []}
            loading={chartsLoading}
            error={chartsError}
            emptyText="Новых клиентов за период нет"
          />
        </ChartPanel>
        <CountPie
          chart={MARKETING_CHARTS.goals}
          slices={charts?.goalSlices}
          summary={answered(charts?.goalSlices)}
          loading={chartsLoading}
          error={chartsError}
          emptyText="Нет ответов"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel title={MARKETING_CHARTS.promoCodes.title} tip={MARKETING_CHARTS.promoCodes.tip}>
          <RankList
            items={charts?.promos ?? []}
            loading={chartsLoading}
            error={chartsError}
            format={formatMoney}
            color={color}
            rows={5}
            emptyText="Продаж с промокодом за период нет"
          />
        </ChartPanel>
        <CountPie
          chart={MARKETING_CHARTS.channels}
          slices={charts?.channelSlices}
          summary={
            charts &&
            charts.channelSlices.length > 0 &&
            `Продаж: ${formatNumber(charts.channelSlices.reduce((s, x) => s + x.value, 0))}`
          }
          loading={history.isLoading}
          error={history.isError}
          rows={2}
        />
      </div>
    </>
  );
}

function Empty({ error, text }: { error: boolean; text: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {error ? "Не удалось загрузить данные" : text}
    </div>
  );
}

/** Круговая со счётом штук (клиентов, продаж) и легендой. */
function CountPie({
  chart,
  slices,
  summary,
  loading,
  error,
  emptyText,
  rows = 4,
}: {
  chart: { title: string; tip: string };
  slices: Slice[] | undefined;
  summary: React.ReactNode;
  loading: boolean;
  error: boolean;
  emptyText?: string;
  rows?: number;
}) {
  return (
    <ChartPanel title={chart.title} tip={chart.tip} summary={summary || undefined}>
      {loading ? (
        <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} rows={rows} />
      ) : (
        <>
          <ChartArea
            height={DASHBOARD_PIE_HEIGHT}
            loading={false}
            error={error}
            empty={!!emptyText && (slices?.length ?? 0) === 0}
            emptyText={emptyText}
          >
            <PiePlot slices={slices ?? []} format={formatNumber} />
          </ChartArea>
          {slices && slices.length > 0 && <PieLegend slices={slices} format={formatNumber} />}
        </>
      )}
    </ChartPanel>
  );
}

/** «1 продажа», «3 продажи», «5 продаж». */
function salesText(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "продажа"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "продажи"
        : "продаж";
  return `${formatNumber(n)} ${word}`;
}
