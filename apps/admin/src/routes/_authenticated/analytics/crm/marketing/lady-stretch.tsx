import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { MarketingReport } from "@/components/analytics/amo/marketing-report";
import { AnalyticsMktStretchPageSkeleton } from "@/components/page-skeletons";
import { validateMktSearch, type MktSearch } from "@/lib/analytics/amo/marketing";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/crm/marketing/lady-stretch")({
  head: () => ({ meta: [{ title: "Маркетинг Lady Stretch — Аналитика — Lady Stretch" }] }),
  validateSearch: validateMktSearch,
  pendingComponent: AnalyticsMktStretchPageSkeleton,
  component: AnalyticsMktStretchPage,
});

/** «CRM» → «Маркетинг Lady Stretch» (права «Маркетинг Lady Stretch»). */
function AnalyticsMktStretchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <MarketingReport
      brand="Lady Stretch"
      title={AN_TITLES.mktStretch}
      search={search}
      onSearch={(patch) => void navigate({ search: (s: MktSearch) => ({ ...s, ...patch }) })}
    />
  );
}
