import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { DataPagination, DEFAULT_PAGE_SIZE } from "@/components/data-pagination";
import { AnalyticsJournalPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { anJournalQuery } from "@/lib/analytics/admin-data";
import { auditLabel, formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/admin/journal")({
  head: () => ({ meta: [{ title: "Журнал — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsJournalPageSkeleton,
  component: AnalyticsJournalPage,
});

/**
 * «Аналитика» → «Журнал» (администратору аналитики) — их «Последняя
 * активность» (audit_log): когда, кто, действие, детали; новые сверху.
 */
function AnalyticsJournalPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, error, isPending } = useQuery(anJournalQuery(page, pageSize));
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <AdminShell title={AN_TITLES.journal}>
      <div className="space-y-3">
        <InfoNote>
          Входы в «Аналитику», просмотры отчётов, загрузка данных 1С в отчёты, изменения партнёров и
          ключей API. Время — московское, как на старом портале.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Когда</TableHead>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Действие</TableHead>
                  <TableHead>Детали</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={4} rows={8} />
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Пока нет действий
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm whitespace-nowrap tabular-nums">
                        {formatMsk(r.created_at)}
                      </TableCell>
                      <TableCell className="text-sm">{r.full_name ?? "Система"}</TableCell>
                      <TableCell className="text-sm">{auditLabel(r.event)}</TableCell>
                      <TableCell className="max-w-md text-sm break-words text-muted-foreground">
                        {r.details || "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination
              page={page}
              pageCount={Math.max(1, Math.ceil(total / pageSize))}
              pageSize={pageSize}
              total={total}
              setPage={setPage}
              setPageSize={(s) => {
                setPageSize(s);
                setPage(1);
              }}
              loading={isPending}
            />
          </div>
        )}
      </div>
    </AdminShell>
  );
}
