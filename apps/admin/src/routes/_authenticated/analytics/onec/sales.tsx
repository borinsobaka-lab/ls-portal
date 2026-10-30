import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SalesBoard } from "@/components/analytics/onec/boards/sales-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecSalesPageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { SalesPayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/sales")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Продажи абонементов — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecSalesPageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Продажи абонементов» — их доска sales (/1c?report=sales). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="sales"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => <SalesBoard payload={payload as SalesPayload} controls={controls} />}
    </OnecReportFrame>
  );
}
