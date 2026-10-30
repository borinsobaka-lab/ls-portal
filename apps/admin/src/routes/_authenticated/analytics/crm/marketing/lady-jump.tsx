import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { MarketingReport } from "@/components/analytics/amo/marketing-report";
import { AnalyticsMktJumpPageSkeleton } from "@/components/page-skeletons";
import { validateMktSearch, type MktSearch } from "@/lib/analytics/amo/marketing";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/crm/marketing/lady-jump")({
  head: () => ({ meta: [{ title: "Маркетинг Lady Jump — Аналитика — Lady Stretch" }] }),
  validateSearch: validateMktSearch,
  pendingComponent: AnalyticsMktJumpPageSkeleton,
  component: AnalyticsMktJumpPage,
});

/** «CRM» → «Маркетинг Lady Jump» (права «Маркетинг Lady Jump»). */
function AnalyticsMktJumpPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <MarketingReport
      brand="Lady Jump"
      title={AN_TITLES.mktJump}
      search={search}
      onSearch={(patch) => void navigate({ search: (s: MktSearch) => ({ ...s, ...patch }) })}
    />
  );
}
