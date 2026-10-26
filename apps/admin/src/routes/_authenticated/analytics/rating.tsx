import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { ChartPanel, RankList } from "@/components/dashboard/chart-panel";
import {
  AnalyticsRatingBodySkeleton,
  AnalyticsRatingPageSkeleton,
} from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { salesQuery, trialsQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, RATING_PANELS } from "@/lib/analytics/labels";
import { formatRate, monthLabel, rating, type RankBy } from "@/lib/analytics/logic";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/rating")({
  head: () => ({ meta: [{ title: "Рейтинг — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsRatingPageSkeleton,
  component: RatingPage,
});

function RatingPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.rating}
      mode="month"
      kinds={["visits", "sales"]}
      skeleton={<AnalyticsRatingBodySkeleton />}
    >
      {(view) => <RatingBody {...view} />}
    </AnalyticsShell>
  );
}

function RatingBody({ studios, ids, period }: AnalyticsView) {
  const [by, setBy] = useState<RankBy>("city");
  const trials = useQuery(trialsQuery(ids, period, "month"));
  const sales = useQuery(salesQuery(ids, period, "month"));
  const loading = trials.isLoading || sales.isLoading;
  const error = trials.isError || sales.isError;
  if (error)
    return <InfoNote variant="warning">Не удалось загрузить рейтинг. Обновите страницу.</InfoNote>;
  const r =
    trials.data && sales.data
      ? rating({ studios, trials: trials.data, sales: sales.data, by })
      : null;

  const empty = by === "club" ? "Нет студий с данными за месяц" : "Нет городов с данными за месяц";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground first-letter:uppercase">
          Топ-10 за {monthLabel(period.from, true)}
        </p>
        <SegmentedControl
          aria-label="Рейтинг"
          value={by}
          onChange={setBy}
          options={[
            { value: "city", label: "Города" },
            { value: "club", label: "Студии" },
          ]}
        />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {(["day0", "d14"] as const).map((k) => (
          <ChartPanel key={k} title={RATING_PANELS[k].label} tip={RATING_PANELS[k].tip}>
            <RankList
              loading={loading}
              color="var(--brand)"
              emptyText={empty}
              format={(v) => formatRate(v, 1)}
              items={(r?.[k] ?? []).map((e) => ({
                key: e.key,
                label: e.label,
                value: e.value,
                note: `${formatNumber(e.part ?? 0)} / ${formatNumber(e.base ?? 0)}`,
              }))}
            />
          </ChartPanel>
        ))}
        {(["renewals", "returns"] as const).map((k) => (
          <ChartPanel key={k} title={RATING_PANELS[k].label} tip={RATING_PANELS[k].tip}>
            <RankList
              loading={loading}
              color="var(--brand)"
              emptyText={empty}
              format={formatNumber}
              items={(r?.[k] ?? []).map((e) => ({ key: e.key, label: e.label, value: e.value }))}
            />
          </ChartPanel>
        ))}
      </div>
    </div>
  );
}
