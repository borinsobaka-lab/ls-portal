import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { CategoryPlot, ChartArea, ChartPanel, RankList } from "@/components/dashboard/chart-panel";
import { DashboardShell, type DashboardView } from "@/components/dashboard/dashboard-shell";
import { useSalesHistory } from "@/components/dashboard/queries";
import { StatGrid, type StatDef, type StatList } from "@/components/dashboard/stat-cards";
import {
  DashboardClientsPageSkeleton,
  DashboardClientsSkeleton,
} from "@/components/page-skeletons";
import { ageGroups, ageOn, clientLtv } from "@/lib/dashboard-analytics";
import { loadClientsData, loadVisits, type VisitRow } from "@/lib/dashboard-data";
import type { DetailRow, DetailsSpec } from "@/lib/dashboard-details";
import {
  CLIENTS_CHARTS,
  CLIENTS_GRID,
  CLIENTS_STATS,
  DASHBOARD_RANK_HEIGHT,
  DASHBOARD_TITLES,
  type ClientsKey,
} from "@/lib/dashboard-stats";
import { formatMoney, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard/clients")({
  head: () => ({ meta: [{ title: "Клиенты — Дашборд — Base40 Admin" }] }),
  pendingComponent: DashboardClientsPageSkeleton,
  component: ClientsPage,
});

const MEMBERS_UNIT: DetailsSpec["unit"] = ["член клуба", "члена клуба", "членов клуба"];

const VISITS_DETAILS: DetailsSpec = {
  title: "Члены клуба — реже всех ходят сверху",
  unit: MEMBERS_UNIT,
  valueUnit: ["посещение", "посещения", "посещений"],
  sort: "valueAsc",
  noDate: true,
  empty: "Членов клуба нет",
};

const LTV_DETAILS: DetailsSpec = {
  title: "Члены клуба по LTV",
  unit: MEMBERS_UNIT,
  format: "money",
  totalLabel: "Итого",
  sort: "value",
  noDate: true,
  empty: "Членов клуба нет",
};

function ClientsPage() {
  return (
    <DashboardShell title={DASHBOARD_TITLES.clients} skeleton={<DashboardClientsSkeleton />}>
      {(view) => <ClientsBody {...view} />}
    </DashboardShell>
  );
}

function ClientsBody(view: DashboardView) {
  const { period, prev, periodEnd } = view;
  const color = view.color;

  const clientsQuery = useQuery({
    queryKey: ["dashboard", view.scope, "clients"],
    queryFn: () => loadClientsData(view.clubIds),
    meta: { errorMessage: `${view.name}: не удалось загрузить клиентов для дашборда` },
  });
  const visitsQuery = useQuery({
    queryKey: ["dashboard", view.scope, "visits", period?.from, period?.to],
    queryFn: async () => {
      const [current, previous] = await Promise.all([
        loadVisits(view.clubIds, period!.from, period!.to),
        loadVisits(view.clubIds, prev!.from, prev!.to),
      ]);
      return { current, previous };
    },
    enabled: !!period,
    meta: { errorMessage: `${view.name}: не удалось загрузить посещения` },
  });
  const history = useSalesHistory(view);

  const clients = clientsQuery.data;
  const people = useMemo(() => {
    if (!clients) return null;
    const byId = new Map(clients.clients.map((c) => [c.id, c]));
    const byUser = new Map(clients.clients.flatMap((c) => (c.userId ? [[c.userId, c.id]] : [])));
    // Посещение — клиенту: по карточке, иначе по учётной записи приложения.
    const clientOf = (v: VisitRow) => v.clientId ?? (v.userId ? byUser.get(v.userId) : undefined);
    const members = clients.clients.filter((c) => clients.memberIds.has(c.id));
    const today = new Date();
    const ages = members.map((c) => ageOn(c.birthday, today));
    const known = ages.filter((a): a is number => a !== null);
    return {
      byId,
      clientOf,
      members,
      avgAge: known.length ? known.reduce((s, a) => s + a, 0) / known.length : undefined,
      ages: ageGroups(ages),
    };
  }, [clients]);

  const visits = visitsQuery.data;
  const perMember = (rows: VisitRow[] | undefined) => {
    if (!rows || !people || !clients) return undefined;
    const count = rows.filter((v) => {
      const id = people.clientOf(v);
      return !!id && clients.memberIds.has(id);
    }).length;
    return people.members.length ? count / people.members.length : 0;
  };

  const topVisits = useMemo(() => {
    if (!visits || !people) return null;
    const groups = new Map<string, { label: string; value: number }>();
    for (const v of visits.current) {
      const id = people.clientOf(v);
      const key = id ?? v.userId ?? `name:${v.name}`;
      const g = groups.get(key) ?? {
        label: (id && people.byId.get(id)?.name) || v.name,
        value: 0,
      };
      g.value++;
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [visits, people]);

  const ltv = useMemo(() => (history.data ? clientLtv(history.data) : null), [history.data]);
  const topLtv = useMemo(() => {
    if (!ltv || !people) return null;
    return [...ltv.entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, value]) => ({ key: id, label: people.byId.get(id)?.name ?? "—", value }));
  }, [ltv, people]);

  const avgLtv =
    ltv && people
      ? people.members.length
        ? people.members.reduce((s, c) => s + (ltv.get(c.id) ?? 0), 0) / people.members.length
        : 0
      : undefined;

  // Подробные отчёты плиток (без графика): кто из членов клуба не ходит —
  // кандидаты на уход, кто принёс больше всех.
  const stats = useMemo<StatDef<ClientsKey>[]>(() => {
    const visitsBy = new Map<string, number>();
    if (visits && people)
      for (const v of visits.current) {
        const id = people.clientOf(v);
        if (id) visitsBy.set(id, (visitsBy.get(id) ?? 0) + 1);
      }
    const memberRow = (c: { id: string }, value: number): DetailRow => ({
      key: `client:${c.id}`,
      date: "",
      clientId: c.id,
      value,
    });
    const lists: Partial<Record<ClientsKey, StatList>> = {
      visitsPerClient: {
        details: VISITS_DETAILS,
        description: "посещения за период",
        rows:
          visits && people
            ? people.members.map((c) => {
                const n = visitsBy.get(c.id) ?? 0;
                return {
                  ...memberRow(c, n),
                  badge: n === 0 ? { text: "Без посещений", tone: "bad" as const } : undefined,
                  attention: n === 0,
                };
              })
            : undefined,
      },
      ltv: {
        details: LTV_DETAILS,
        description: "за всё время",
        rows:
          ltv && people ? people.members.map((c) => memberRow(c, ltv.get(c.id) ?? 0)) : undefined,
      },
    };
    return CLIENTS_STATS.map((s) => ({ ...s, list: lists[s.key] }));
  }, [visits, people, ltv]);

  const current: Partial<Record<ClientsKey, number>> = {
    avgAge: people?.avgAge,
    visitsPerClient: perMember(visits?.current),
    ltv: avgLtv,
  };
  const previous: Partial<Record<ClientsKey, number>> = {
    visitsPerClient: perMember(visits?.previous),
  };

  return (
    <>
      <StatGrid
        target={view}
        stats={stats}
        current={current}
        previous={previous}
        loading={clientsQuery.isLoading || visitsQuery.isLoading || history.isLoading}
        periodEnd={periodEnd}
        className={CLIENTS_GRID}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel
          title={CLIENTS_CHARTS.ages.title}
          tip={CLIENTS_CHARTS.ages.tip}
          summary={people && `Членов клуба: ${formatNumber(people.members.length)}`}
        >
          <ChartArea
            height={DASHBOARD_RANK_HEIGHT}
            loading={clientsQuery.isLoading}
            error={clientsQuery.isError}
            empty={!people || people.members.length === 0}
            emptyText="Нет клиентов с действующим абонементом"
          >
            <CategoryPlot data={people?.ages ?? []} color={color} format={formatNumber} />
          </ChartArea>
        </ChartPanel>
        <ChartPanel title={CLIENTS_CHARTS.topVisits.title} tip={CLIENTS_CHARTS.topVisits.tip}>
          <RankList
            items={topVisits ?? []}
            loading={visitsQuery.isLoading || clientsQuery.isLoading}
            error={visitsQuery.isError}
            format={formatNumber}
            color={color}
          />
        </ChartPanel>
      </div>

      <ChartPanel title={CLIENTS_CHARTS.topLtv.title} tip={CLIENTS_CHARTS.topLtv.tip}>
        <RankList
          items={topLtv ?? []}
          loading={history.isLoading || clientsQuery.isLoading}
          error={history.isError || clientsQuery.isError}
          format={formatMoney}
          color={color}
          emptyText="Платежей пока нет"
        />
      </ChartPanel>
    </>
  );
}
