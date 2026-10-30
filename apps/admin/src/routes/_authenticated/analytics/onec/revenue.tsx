import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { RevenueBoard } from "@/components/analytics/onec/boards/revenue-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecRevenuePageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { RevenuePayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/revenue")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Выручка — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecRevenuePageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Выручка» — их доска revenue (/1c?report=revenue). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="revenue"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => (
        <RevenueBoard payload={payload as RevenuePayload} controls={controls} />
      )}
    </OnecReportFrame>
  );
}
