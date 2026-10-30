import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PartnerBoard } from "@/components/analytics/onec/boards/mycity-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecMycityPageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { PartnerPayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/mycity")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Мой город — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecMycityPageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Мой город» — их доска partner (/1c?report=partner). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="partner"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => (
        <PartnerBoard payload={payload as PartnerPayload} controls={controls} />
      )}
    </OnecReportFrame>
  );
}
