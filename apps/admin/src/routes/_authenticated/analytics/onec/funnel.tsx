import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { FunnelBoard } from "@/components/analytics/onec/boards/funnel-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecFunnelPageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { FunnelPayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/funnel")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Воронка пробных — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecFunnelPageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Воронка пробных» — их доска funnel (/1c?report=funnel). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="funnel"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => (
        <FunnelBoard payload={payload as FunnelPayload} controls={controls} />
      )}
    </OnecReportFrame>
  );
}
