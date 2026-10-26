import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { KbArticlesTab } from "@/components/kb/analytics/articles-tab";
import { KbOverviewTab } from "@/components/kb/analytics/overview-tab";
import { KbPeopleTab } from "@/components/kb/analytics/people-tab";
import { KbRatingsTab } from "@/components/kb/analytics/ratings-tab";
import { KbSearchTab } from "@/components/kb/analytics/search-tab";
import { KbPageHeading } from "@/components/kb/kb-header";
import { KbAnalyticsPageSkeleton } from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { canEditKb } from "@/lib/kb/access";
import { KB_PERIODS, type KbPeriod } from "@/lib/kb/analytics";
import { kbBasesQuery } from "@/lib/kb/data";

const TABS = [
  { value: "overview", label: "Обзор" },
  { value: "people", label: "Сотрудники" },
  { value: "articles", label: "Статьи" },
  { value: "ratings", label: "Оценки" },
  { value: "search", label: "Поиск" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const isTab = (v: unknown): v is Tab => TABS.some((t) => t.value === v);
const isPeriod = (v: unknown): v is KbPeriod => KB_PERIODS.some((p) => p.value === String(v));

export const Route = createFileRoute("/_authenticated/kb/$baseId/analytics")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: Tab; period?: KbPeriod; node?: string } => ({
    tab: isTab(search.tab) ? search.tab : undefined,
    period: isPeriod(search.period) ? (String(search.period) as KbPeriod) : undefined,
    // Статья для «Оценок» (ссылка «Кто и как оценил» под статьёй).
    node:
      typeof search.node === "string" && /^[0-9a-f-]{36}$/.test(search.node)
        ? search.node
        : undefined,
  }),
  head: () => ({ meta: [{ title: "Аналитика — Lady Stretch" }] }),
  pendingComponent: KbAnalyticsPageSkeleton,
  component: KbAnalyticsPage,
});

/**
 * Аналитика базы знаний (редакторам базы и владельцам; схема —
 * db/migrations/2026-10-25_zzzz_kb_reading_analytics.sql): кто что
 * прочитал и когда, время и докуда дочитали, кто читал прежнюю версию,
 * активность по дням, что ищут и не находят, оценки статей. Вкладка и
 * период — в адресе.
 */
function KbAnalyticsPage() {
  const { baseId } = Route.useParams();
  const { tab = "overview", period = "30", node } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const access = useAdminAccess();
  const canEdit = canEditKb(access?.kbAdmin ? "manage" : access?.kb?.[baseId]);
  const { data: bases } = useQuery(kbBasesQuery);
  const base = bases?.find((b) => b.id === baseId);
  const go = (next: { tab?: Tab; period?: KbPeriod; node?: string }) =>
    void navigate({ search: (s) => ({ ...s, ...next }), replace: true });

  return (
    <AdminShell title={`Аналитика${base ? ` · ${base.title}` : ""}`}>
      <div className="mx-auto max-w-6xl space-y-4">
        <KbPageHeading baseId={baseId} title="Аналитика" />
        {!canEdit && access ? (
          <InfoNote variant="warning">Аналитику видят редакторы базы и владельцы.</InfoNote>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs
                value={tab}
                onValueChange={(v) => go({ tab: v as Tab })}
                activationMode="manual"
              >
                <TabsList aria-label="Разделы аналитики" className="max-w-full overflow-x-auto">
                  {TABS.map((t) => (
                    <TabsTrigger key={t.value} value={t.value}>
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {tab !== "articles" && (
                <SegmentedControl
                  aria-label="Период"
                  value={period}
                  onChange={(p) => go({ period: p })}
                  options={KB_PERIODS.map((p) => ({ value: p.value, label: p.label }))}
                />
              )}
            </div>
            {tab === "overview" && (
              <KbOverviewTab
                baseId={baseId}
                period={period}
                onOpenSearch={() => go({ tab: "search" })}
              />
            )}
            {tab === "people" && <KbPeopleTab baseId={baseId} period={period} />}
            {tab === "articles" && (
              <KbArticlesTab baseId={baseId} canGrant={hasRight(access, "users.manage")} />
            )}
            {tab === "search" && <KbSearchTab baseId={baseId} period={period} />}
            {tab === "ratings" && (
              <KbRatingsTab
                baseId={baseId}
                period={period}
                nodeId={node ?? null}
                onNode={(id) => go({ node: id ?? undefined })}
              />
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}
