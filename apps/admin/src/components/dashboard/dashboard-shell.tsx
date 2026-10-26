import { type ReactNode } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter } from "@/components/date-range-filter";
import { ClubsFilter } from "@/components/dashboard/clubs-filter";
import { DashboardBodySkeleton, DashboardFilterField } from "@/components/page-skeletons";
import { ToolbarReset } from "@/components/table-toolbar";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { isCurrentMonth, useDashboardFilters } from "@/hooks/use-dashboard-filters";
import { useStudios, type Studio } from "@/hooks/use-studios";
import { dashboardStudioIds } from "@/lib/admin-access";
import { defaultClubId, resolveClubIds } from "@/lib/dashboard-clubs";
import { previousPeriod, toISO, type Period } from "@/lib/dashboard-data";
import { DASHBOARD_FILTERS } from "@/lib/dashboard-stats";

/** Что получает подраздел дашборда: выбранные клубы и период. */
export type DashboardView = {
  /** Выбранные клубы (одного формата); показатели — суммарно по ним. */
  clubs: Studio[];
  clubIds: string[];
  /** Ключ выбора клубов для queryKey: id через запятую. */
  scope: string;
  /** Для текстов ошибок: клуб или «N клубов». */
  name: string;
  /** Цвет графиков: основной цвет клуба, у нескольких — общий. */
  color: string;
  /** Выбранный период; null — даты не выбраны. */
  period: Period | null;
  /** Предыдущий период той же длины — для сравнения. */
  prev: Period | null;
  /** Конец выбранного периода (без периода — сегодня). */
  periodEnd: Date;
};

/**
 * Подраздел дашборда (меню «Дашборд»: общие показатели, продажи, клиенты…).
 * Дашборд — над клубами: сверху плашка фильтров «Период» и «Клубы» (общие
 * для всех подразделов, hooks/use-dashboard-filters.ts), ниже — показатели,
 * суммарно по выбранным клубам. В фильтре — клубы, где у сотрудника есть
 * роль и открыт раздел «Дашборд» («Доступы»); данные всё равно ограничивает
 * RLS по клубу.
 */
export function DashboardShell({
  title,
  skeleton,
  children,
}: {
  title: string;
  /** Тело подраздела, пока данных нет (то же, что в скелетоне страницы). */
  skeleton: ReactNode;
  children: (view: DashboardView) => ReactNode;
}) {
  const access = useAdminAccess();
  const { data: studios, isLoading } = useStudios();
  const activeId = useActiveStudioId();
  const { filters, setRange, setClubIds, reset } = useDashboardFilters();
  const fetching = useIsFetching({ queryKey: ["dashboard"] }) > 0;

  const allowed = access ? new Set(dashboardStudioIds(access)) : null;
  const clubs = allowed ? (studios ?? []).filter((s) => allowed.has(s.id)) : [];

  if (isLoading || !access)
    return (
      <AdminShell title={title}>
        <DashboardBodySkeleton>{skeleton}</DashboardBodySkeleton>
      </AdminShell>
    );
  if (clubs.length === 0)
    return (
      <AdminShell title={title}>
        <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
          Нет клубов, где вам открыт дашборд.
        </div>
      </AdminShell>
    );

  const clubIds = resolveClubIds(clubs, activeId, filters.clubIds);
  const selected = clubs.filter((c) => clubIds.includes(c.id));
  const fromDate = filters.range?.from;
  const toDate = filters.range?.to ?? filters.range?.from;
  const period = fromDate && toDate ? { from: toISO(fromDate), to: toISO(toDate) } : null;
  // Сбросить есть что, если период — не текущий месяц или клубы — не клуб из шапки.
  const changed =
    !isCurrentMonth(filters.range) ||
    clubIds.length !== 1 ||
    clubIds[0] !== defaultClubId(clubs, activeId);

  const view: DashboardView = {
    clubs: selected,
    clubIds,
    scope: clubIds.join(","),
    name: selected.length === 1 ? selected[0].name : `Клубы (${selected.length})`,
    color: (selected.length === 1 && selected[0].brand_color) || "var(--brand)",
    period,
    prev: period && previousPeriod(period),
    periodEnd: toDate ?? new Date(),
  };

  return (
    <AdminShell title={title}>
      <div className="space-y-3">
        {/* Подписи над полями — решение владельца 2026-10-11 (в остальных
            плашках фильтров подписей нет). */}
        <div className="table-toolbar flex flex-wrap items-end gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <DashboardFilterField {...DASHBOARD_FILTERS.period}>
            <DateRangeFilter
              placeholder="Выберите период"
              showLabel={false}
              value={filters.range}
              onChange={setRange}
              className="w-full"
            />
          </DashboardFilterField>
          <DashboardFilterField {...DASHBOARD_FILTERS.clubs}>
            <ClubsFilter
              clubs={clubs}
              selected={clubIds}
              activeId={activeId}
              onChange={setClubIds}
            />
          </DashboardFilterField>
          <ToolbarReset active={changed} onReset={reset} />
          {fetching && (
            <div className="inline-flex h-10 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              обновляем…
            </div>
          )}
        </div>
        {children(view)}
      </div>
    </AdminShell>
  );
}
