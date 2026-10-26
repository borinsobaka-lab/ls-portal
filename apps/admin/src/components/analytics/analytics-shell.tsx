import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { endOfMonth, format, parseISO, startOfMonth } from "date-fns";
import { Loader2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter } from "@/components/date-range-filter";
import { AnalyticsBodySkeleton, DashboardFilterField } from "@/components/page-skeletons";
import { ToolbarReset } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isCurrentMonth } from "@/hooks/use-dashboard-filters";
import { useAnalyticsFilters, type AnalyticsFilters } from "@/hooks/use-analytics-filters";
import { ANALYTICS_KEY, analyticsScopeQuery } from "@/lib/analytics/data";
import { ANALYTICS_FILTERS, KIND_TITLE } from "@/lib/analytics/labels";
import {
  cityNames,
  cityOf,
  filterStudios,
  monthLabel,
  monthStarts,
  type StatusFilter,
} from "@/lib/analytics/logic";
import type { AnKind, AnScope, AnStudio, Period } from "@/lib/analytics/types";
import { formatDate } from "@/lib/format";

/** Что получает отчёт: студии под фильтрами, период, сегодня. */
export type AnalyticsView = {
  scope: AnScope;
  /** Студии под фильтрами (бренд, город, студия, статус). */
  studios: AnStudio[];
  /** Для запросов: id студий; null — все доступные (короткий queryKey). */
  ids: string[] | null;
  idSet: Set<string>;
  period: Period;
  today: string;
  filters: AnalyticsFilters;
  update: (next: Partial<AnalyticsFilters>) => void;
};

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "Все студии",
  open: "Открытые",
  closed: "Закрытые",
};

const iso = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * Каркас отчёта «Аналитики сети»: шапка, плашка фильтров с подписями (как у
 * дашборда), свежесть данных и тело. Студии — клубы сети на своих учётных
 * системах, которые видит сотрудник (все или свои города); их отдаёт база
 * (an_scope), она же ограничивает данные. `mode="month"` — вместо периода
 * выбор месяца («Выручка», «Рейтинг»). `kinds` — какие загрузки нужны отчёту
 * (под фильтрами — «данные по …»).
 */
export function AnalyticsShell({
  title,
  skeleton,
  mode = "range",
  kinds = [],
  children,
}: {
  title: string;
  /** Тело отчёта, пока нет клубов (то же, что в скелетоне страницы). */
  skeleton: ReactNode;
  mode?: "range" | "month";
  kinds?: AnKind[];
  children: (view: AnalyticsView) => ReactNode;
}) {
  const { data: scope, isLoading, isError } = useQuery(analyticsScopeQuery);
  const { filters, update, reset } = useAnalyticsFilters();
  const fetching = useIsFetching({ queryKey: [ANALYTICS_KEY] }) > 0;

  if (isError)
    return (
      <AdminShell title={title}>
        <InfoNote variant="warning">
          Не удалось загрузить студии аналитики. Обновите страницу.
        </InfoNote>
      </AdminShell>
    );
  if (isLoading || !scope)
    return (
      <AdminShell title={title}>
        <AnalyticsBodySkeleton mode={mode}>{skeleton}</AnalyticsBodySkeleton>
      </AdminShell>
    );
  if (scope.studios.length === 0)
    return (
      <AdminShell title={title}>
        <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
          {scope.canManage ? (
            <>
              Данных ещё нет. Загрузите первую выгрузку учётной системы в{" "}
              <Link to="/analytics/upload" className="font-medium text-foreground underline">
                «Загрузке данных»
              </Link>
              .
            </>
          ) : (
            "Студий для вас пока нет: попросите назначить вам города или открыть аналитику сети."
          )}
        </div>
      </AdminShell>
    );

  const today = scope.today;
  const brands = [
    ...new Map(
      scope.studios.filter((s) => s.brandId).map((s) => [s.brandId!, s.brandName ?? "Бренд"]),
    ).entries(),
  ];
  const inBrand = scope.studios.filter((s) => !filters.brandId || s.brandId === filters.brandId);
  const cities = cityNames(inBrand, today);
  const inCity = inBrand.filter((s) => !filters.city || cityOf(s) === filters.city);
  const studios = filterStudios(scope.studios, filters, today);

  const from = filters.range?.from ?? startOfMonth(new Date());
  const to = filters.range?.to ?? filters.range?.from ?? endOfMonth(new Date());
  const period: Period =
    mode === "month"
      ? { from: iso(startOfMonth(from)), to: iso(endOfMonth(from)) }
      : { from: iso(from), to: iso(to) };
  const months = monthStarts(today, 24).reverse();

  const changed =
    !isCurrentMonth(filters.range) ||
    !!filters.brandId ||
    !!filters.city ||
    !!filters.clubId ||
    filters.status !== "all";
  const all = studios.length === scope.studios.length;
  const view: AnalyticsView = {
    scope,
    studios,
    ids: all ? null : studios.map((s) => s.id),
    idSet: new Set(studios.map((s) => s.id)),
    period,
    today,
    filters,
    update,
  };

  return (
    <AdminShell title={title}>
      <div className="space-y-3">
        <div className="table-toolbar flex flex-wrap items-end gap-2 rounded-lg border bg-background p-2 sm:px-3">
          {mode === "month" ? (
            <DashboardFilterField {...ANALYTICS_FILTERS.month}>
              <Select
                value={period.from}
                onValueChange={(m) => {
                  const d = parseISO(m);
                  update({ range: { from: startOfMonth(d), to: endOfMonth(d) } });
                }}
              >
                <SelectTrigger aria-label="Месяц" className="w-full first-letter:uppercase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(months.includes(period.from) ? months : [period.from, ...months]).map((m) => (
                    <SelectItem key={m} value={m} className="first-letter:uppercase">
                      {monthLabel(m, true)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DashboardFilterField>
          ) : (
            <DashboardFilterField {...ANALYTICS_FILTERS.period}>
              <DateRangeFilter
                placeholder="Выберите период"
                showLabel={false}
                value={filters.range}
                onChange={(range) => update({ range })}
                className="w-full"
              />
            </DashboardFilterField>
          )}
          {brands.length > 1 && (
            <DashboardFilterField {...ANALYTICS_FILTERS.brand}>
              <Select
                value={filters.brandId ?? "all"}
                onValueChange={(v) =>
                  update({ brandId: v === "all" ? null : v, city: null, clubId: null })
                }
              >
                <SelectTrigger aria-label="Бренд" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все бренды</SelectItem>
                  {brands.map(([id, name]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DashboardFilterField>
          )}
          {cities.length > 1 && (
            <DashboardFilterField {...ANALYTICS_FILTERS.city}>
              <Select
                value={filters.city ?? "all"}
                onValueChange={(v) => update({ city: v === "all" ? null : v, clubId: null })}
              >
                <SelectTrigger aria-label="Город" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все города</SelectItem>
                  {cities.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DashboardFilterField>
          )}
          {inCity.length > 1 && (
            <DashboardFilterField {...ANALYTICS_FILTERS.club}>
              <Select
                value={filters.clubId ?? "all"}
                onValueChange={(v) => update({ clubId: v === "all" ? null : v })}
              >
                <SelectTrigger aria-label="Студия" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {filters.city ? "Все студии города" : "Все студии"}
                  </SelectItem>
                  {inCity.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DashboardFilterField>
          )}
          {scope.studios.some((s) => s.closedOn) && (
            <DashboardFilterField {...ANALYTICS_FILTERS.status}>
              <Select
                value={filters.status}
                onValueChange={(v) => update({ status: v as StatusFilter })}
              >
                <SelectTrigger aria-label="Статус студий" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {STATUS_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DashboardFilterField>
          )}
          <ToolbarReset active={changed} onReset={reset} />
          {fetching && (
            <div className="inline-flex h-10 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              обновляем…
            </div>
          )}
        </div>
        {kinds.length > 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            {kinds
              .map((k) => {
                const to = scope.loaded[k]?.to;
                return `${KIND_TITLE[k]}: ${to ? `данные по ${formatDate(to)}` : "не загружены"}`;
              })
              .join(" · ")}
          </p>
        )}
        {studios.length === 0 ? (
          <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
            Под фильтры не попала ни одна студия.
          </div>
        ) : (
          children(view)
        )}
      </div>
    </AdminShell>
  );
}
