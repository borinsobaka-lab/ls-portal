import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { OnecProcessingTab } from "@/components/analytics/onec/processing-tab";
import { OnecRefsTab } from "@/components/analytics/onec/refs-tab";
import { AnalyticsOnecPageSkeleton } from "@/components/page-skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AN_ONEC_TABS, AN_TITLES, type AnOnecTab } from "@/lib/analytics/labels";
import { ONEC_ACTIVE, onecOverviewQuery } from "@/lib/analytics/onec-page";

const isTab = (v: unknown): v is AnOnecTab => AN_ONEC_TABS.some((t) => t.value === v);

export const Route = createFileRoute("/_authenticated/analytics/tools/onec")({
  validateSearch: (search: Record<string, unknown>): { tab?: AnOnecTab } => ({
    tab: isTab(search.tab) ? search.tab : undefined,
  }),
  head: () => ({ meta: [{ title: "Обработка 1С — Аналитика — LadyFitPro" }] }),
  pendingComponent: AnalyticsOnecPageSkeleton,
  component: AnalyticsOnecPage,
});

/**
 * «Аналитика» → «Инструменты» → «Обработка 1С» (администратору аналитики;
 * ANALYTICS_PLAN.md §8.1): их Windows-обработчик — выгрузки, обработка,
 * загрузка снимка в отчёты — и справочники студий, номенклатуры, точки 0.
 */
function AnalyticsOnecPage() {
  const { tab = "processing" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useQuery(onecOverviewQuery);
  const latest = data?.runs[0];
  const locked = !!latest && ONEC_ACTIVE.includes(latest.status);

  // Табы — первой строкой белой плашки; у справочников на ней же их поиск и
  // кнопки (плашку рисует OnecRefsTab).
  const tabsNode = (
    <Tabs
      value={tab}
      onValueChange={(v) => void navigate({ search: { tab: v as AnOnecTab }, replace: true })}
      activationMode="manual"
    >
      <TabsList aria-label="Разделы обработки 1С" indicatorMemoryKey="an-onec-tabs">
        {AN_ONEC_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <AdminShell title={AN_TITLES.onec}>
      <div className="space-y-4">
        {tab === "processing" && <TableToolbar tabs={tabsNode} />}
        {tab === "processing" ? (
          <OnecProcessingTab />
        ) : (
          <OnecRefsTab
            key={tab}
            refKind={tab}
            info={data?.refs[tab]}
            locked={locked}
            toolbarTabs={tabsNode}
          />
        )}
      </div>
    </AdminShell>
  );
}
