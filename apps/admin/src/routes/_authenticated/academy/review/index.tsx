import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { AcadEmpty, PersonCell } from "@/components/academy/parts";
import { AcademyReviewPageSkeleton } from "@/components/page-skeletons";
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
import { useTableSort } from "@/hooks/use-table-sort";
import { acadReviewQueueQuery } from "@/lib/academy/data";
import { acadError } from "@/lib/academy/logic";
import type { AcadReviewItem } from "@/lib/academy/types";
import { formatDateTime } from "@/lib/format";
import type { SortGetters } from "@/lib/table-sort";

export const Route = createFileRoute("/_authenticated/academy/review/")({
  head: () => ({ meta: [{ title: "Проверка ответов — Академия — Lady Stretch" }] }),
  pendingComponent: AcademyReviewPageSkeleton,
  component: ReviewQueuePage,
});

const SORT: SortGetters<AcadReviewItem> = {
  name: (r) => r.full_name ?? "",
  course: (r) => r.course_title,
  sent: (r) => r.submitted_at,
  open: (r) => r.open_answers,
};

/**
 * «Проверка ответов» (право «Проверяет ответы»): попытки тестов со
 * свободными ответами, ждущие оценки, — сначала давние. По строке — проверка.
 */
function ReviewQueuePage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(acadReviewQueueQuery);
  const sort = useTableSort<AcadReviewItem>(SORT);
  const rows = sort.apply(data ?? []);
  const open = (r: AcadReviewItem) =>
    void navigate({ to: "/academy/review/$attemptId", params: { attemptId: r.attempt_id } });

  return (
    <AdminShell title="Проверка ответов">
      <div className="mx-auto max-w-5xl space-y-3">
        {error && !data ? (
          <InfoNote variant="warning">{acadError(error)}</InfoNote>
        ) : data && data.length === 0 ? (
          <AcadEmpty title="Проверять нечего">
            Здесь появятся тесты со свободными ответами, которые ученики отправили на проверку.
          </AcadEmpty>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead {...sort.head("name")}>Сотрудник</TableHead>
                  <TableHead {...sort.head("course")}>Курс и тест</TableHead>
                  <TableHead {...sort.head("open")}>Свободных ответов</TableHead>
                  <TableHead {...sort.head("sent")}>Отправлено</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableSkeletonRows columns={4} rows={4} />
                ) : (
                  rows.map((r) => (
                    <TableRow
                      key={r.attempt_id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => open(r)}
                      onKeyDown={(e) => e.key === "Enter" && open(r)}
                    >
                      <TableCell>
                        <PersonCell name={r.full_name} avatar={r.avatar_url} userId={r.user_id} />
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="block font-medium">{r.course_title}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.step_title} · попытка {r.attempt_no}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{r.open_answers}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(r.submitted_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
