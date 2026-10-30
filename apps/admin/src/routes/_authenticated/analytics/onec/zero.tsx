import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ZeroBoard } from "@/components/analytics/onec/boards/zero-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecZeroPageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { ZeroPayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/zero")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Нулевая номенклатура — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecZeroPageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Нулевая номенклатура» — их доска zero (/1c?report=zero). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="zero"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => <ZeroBoard payload={payload as ZeroPayload} controls={controls} />}
    </OnecReportFrame>
  );
}
