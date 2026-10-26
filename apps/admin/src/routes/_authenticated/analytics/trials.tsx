import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { CityTreeTable, type TreeColumn } from "@/components/analytics/city-tree";
import { EmptyBlock, KpiGrid, KpiTile, TableCard } from "@/components/analytics/parts";
import {
  AnalyticsTrialsBodySkeleton,
  AnalyticsTrialsPageSkeleton,
} from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trialsQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, TRIALS_TILES } from "@/lib/analytics/labels";
import { formatRate, trialLines, trialsSummary, type TrialsSummary } from "@/lib/analytics/logic";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/trials")({
  head: () => ({ meta: [{ title: "Воронка пробных — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsTrialsPageSkeleton,
  component: TrialsPage,
});

const OPEN_TIP =
  "Пришли на пробное, ещё не купили, а 14 дней ещё не прошли — конверсия за 14 дней по ним может вырасти после следующей загрузки.";

const COLUMNS: TreeColumn<TrialsSummary>[] = [
  {
    key: "trials",
    label: "Записей",
    tip: TRIALS_TILES.trials.tip,
    render: (v) => formatNumber(v.trials),
    sort: (v) => v.trials,
  },
  {
    key: "attended",
    label: "Пришли",
    tip: TRIALS_TILES.attended.tip,
    render: (v) => formatNumber(v.attended),
    sort: (v) => v.attended,
  },
  {
    key: "attendance",
    label: "Доходимость",
    render: (v) => formatRate(v.attendance, 1),
    sort: (v) => v.attendance,
  },
  {
    key: "day0",
    label: "В день",
    tip: TRIALS_TILES.day0.tip,
    render: (v) => `${formatNumber(v.day0)} · ${formatRate(v.day0Rate, 1)}`,
    sort: (v) => v.day0Rate,
  },
  {
    key: "d14",
    label: "За 14 дней",
    tip: TRIALS_TILES.d14.tip,
    render: (v) => `${formatNumber(v.d14)} · ${formatRate(v.d14Rate, 1)}`,
    sort: (v) => v.d14Rate,
  },
  {
    key: "open",
    label: "Окно открыто",
    tip: OPEN_TIP,
    render: (v) => formatNumber(v.open),
    sort: (v) => v.open,
  },
];

function TrialsPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.trials}
      kinds={["visits", "sales"]}
      skeleton={<AnalyticsTrialsBodySkeleton />}
    >
      {(view) => <TrialsBody {...view} />}
    </AnalyticsShell>
  );
}

function TrialsBody({ studios, ids, idSet, period, today, update }: AnalyticsView) {
  const q = useQuery(trialsQuery(ids, period, "month"));
  if (q.isError)
    return <InfoNote variant="warning">Не удалось загрузить пробные. Обновите страницу.</InfoNote>;
  const loading = q.isLoading;
  const s = q.data && trialsSummary(q.data, idSet);
  const kinds = q.data ? trialLines(q.data, idSet) : [];

  return (
    <div className="space-y-3">
      <KpiGrid>
        <KpiTile {...TRIALS_TILES.trials} loading={loading} value={s && formatNumber(s.trials)} />
        <KpiTile
          {...TRIALS_TILES.attended}
          loading={loading}
          value={s && formatNumber(s.attended)}
          note={s && `доходимость ${formatRate(s.attendance, 1)}`}
        />
        <KpiTile
          {...TRIALS_TILES.day0}
          loading={loading}
          value={s && formatRate(s.day0Rate, 1)}
          note={s && `${formatNumber(s.day0)} из ${formatNumber(s.attended)}`}
        />
        <KpiTile
          {...TRIALS_TILES.d14}
          loading={loading}
          value={s && formatRate(s.d14Rate, 1)}
          note={s && `${formatNumber(s.d14)} из ${formatNumber(s.attended)}`}
        />
      </KpiGrid>
      {s && s.open > 0 && (
        <InfoNote>
          У {formatNumber(s.open)} пришедших 14 дней ещё не прошли: как у Lady Stretch, они уже в
          знаменателе, а покупки за 14 дней дополнятся после следующей загрузки.
        </InfoNote>
      )}
      <TableCard title="Города и студии">
        <CityTreeTable
          studios={studios}
          today={today}
          loading={loading || !q.data}
          compute={(set) => trialsSummary(q.data ?? [], set)}
          onPick={(st) => update({ clubId: st.id })}
          columns={COLUMNS}
        />
      </TableCard>
      <TableCard
        title="Виды пробных"
        tip="Членства, размеченные в «Номенклатуре» как «Пробное занятие»."
      >
        {!loading && kinds.length === 0 ? (
          <EmptyBlock>Пробных за период нет</EmptyBlock>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Пробное</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} tip={c.tip} className="text-right [&>span]:justify-end">
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={COLUMNS.length + 1} rows={3} />
              ) : (
                kinds.map((k) => (
                  <TableRow key={k.key}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    {COLUMNS.map((c) => (
                      <TableCell key={c.key} className="text-right">
                        {c.render(k)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
