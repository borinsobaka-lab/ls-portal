import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ActivitiesBoard } from "@/components/analytics/onec/boards/activities-board";
import { OnecReportFrame } from "@/components/analytics/onec/report-frame";
import { AnalyticsOnecActivitiesPageSkeleton } from "@/components/page-skeletons";
import { parseOnecSearch } from "@/lib/analytics/onec-reports/search";
import type { ActivitiesPayload } from "@/lib/analytics/onec-reports/payload";

export const Route = createFileRoute("/_authenticated/analytics/onec/activities")({
  validateSearch: parseOnecSearch,
  head: () => ({ meta: [{ title: "Занятия — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsOnecActivitiesPageSkeleton,
  component: Page,
});

/** «1С · Lady Stretch» → «Занятия» — их доска activities (/1c?report=activities). */
function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <OnecReportFrame
      board="activities"
      search={search}
      navigate={(next, replace) => void navigate({ search: next, replace })}
    >
      {(payload, controls) => (
        <ActivitiesBoard payload={payload as ActivitiesPayload} controls={controls} />
      )}
    </OnecReportFrame>
  );
}
