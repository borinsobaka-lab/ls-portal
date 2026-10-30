import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { AnalyticsActivityPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { anActivityQuery } from "@/lib/analytics/admin-data";
import {
  activityTotals,
  defaultActivityPeriod,
  formatDuration,
  formatMsk,
  type AnActivityRow,
} from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import type { SortGetters } from "@/lib/table-sort";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type ActivitySearch = { from?: string; to?: string };

export const Route = createFileRoute("/_authenticated/analytics/admin/activity")({
  head: () => ({ meta: [{ title: "Посещаемость — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): ActivitySearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
  }),
  pendingComponent: AnalyticsActivityPageSkeleton,
  component: AnalyticsActivityPage,
});

const TIPS = {
  visits: "Входы в «Аналитику»: сессии входа в портал, в которых человек открывал её страницы.",
  time: "Только пока вкладка видна и человек что-то делает на странице: пауза дольше 45 секунд не считается.",
  views: "Сколько раз открывал отчёты. Отчёты 1С просмотров не пишут — как на старом портале.",
  last: "Последний засчитанный промежуток активного времени, по Москве.",
};

const SORT_GETTERS: SortGetters<AnActivityRow> = {
  name: (r) => r.full_name,
  visits: (r) => r.visits,
  time: (r) => r.seconds,
  views: (r) => r.views,
  last: (r) => r.last_active,
};

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * «Аналитика» → «Посещаемость» (администратору аналитики) — их
 * activity_page: визиты, активное время, просмотры и дашборды за период
 * (по умолчанию — 30 дней по сегодня, по Москве), обновляется раз в минуту.
 */
function AnalyticsActivityPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const fallback = defaultActivityPeriod();
  const from = search.from && search.to && search.from <= search.to ? search.from : fallback.from;
  const to = search.from && search.to && search.from <= search.to ? search.to : fallback.to;
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const { data, error, isPending } = useQuery(anActivityQuery(from, to));
  const rows = data ?? [];
  const totals = activityTotals(rows);
  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(rows), undefined, sort.key);

  return (
    <AdminShell title={AN_TITLES.activity}>
      <div className="space-y-3">
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Начало и конец периода"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                void navigate({ search: { from: toIso(r.from), to: toIso(r.to) } });
              } else setDraft(r);
            }}
          />
        </TableToolbar>
        <p className="text-xs text-muted-foreground">
          {ru(from)} — {ru(to)} · Активное время учитывается, только когда вкладка видима и
          пользователь взаимодействует с порталом. Обновляется раз в минуту.
        </p>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Визитов за период" value={totals.visits} loading={isPending} />
              <StatTile
                label="Активное время команды"
                value={formatDuration(totals.seconds)}
                loading={isPending}
              />
              <StatTile label="Не заходили" value={totals.inactive} loading={isPending} />
            </div>
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead {...sort.head("name")}>Пользователь</TableHead>
                    <TableHead tip={TIPS.visits} {...sort.head("visits")}>
                      Визиты
                    </TableHead>
                    <TableHead tip={TIPS.time} {...sort.head("time")}>
                      Активное время
                    </TableHead>
                    <TableHead tip={TIPS.views} {...sort.head("views")}>
                      Просмотры
                    </TableHead>
                    <TableHead>Дашборды</TableHead>
                    <TableHead tip={TIPS.last} {...sort.head("last")}>
                      Последняя активность
                    </TableHead>
                    <TableHead>Статус</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    <TableSkeletonRows columns={7} rows={6} />
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Никому ещё не открыта «Аналитика».
                      </TableCell>
                    </TableRow>
                  ) : (
                    pg.paged.map((r) => (
                      <TableRow key={r.user_id}>
                        <TableCell>
                          <div className="font-medium">{r.full_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.position || r.email}
                          </div>
                        </TableCell>
                        <TableCell className="tabular-nums">{r.visits}</TableCell>
                        <TableCell className="tabular-nums">{formatDuration(r.seconds)}</TableCell>
                        <TableCell className="tabular-nums">{r.views}</TableCell>
                        <TableCell className="max-w-xs text-sm">
                          {r.dashboards.join(", ") || "—"}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {formatMsk(r.last_active)}
                        </TableCell>
                        <TableCell>
                          {r.visits === 0 ? (
                            <StatusChip tone="neutral">не заходил(а)</StatusChip>
                          ) : (
                            <StatusChip tone="positive">активен(на)</StatusChip>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              <DataPagination {...pg} loading={isPending} />
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}
