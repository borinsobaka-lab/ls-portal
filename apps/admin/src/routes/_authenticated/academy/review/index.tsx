import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AcadEmpty, AttemptBadge, PersonCell } from "@/components/academy/parts";
import { AcademyReviewPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { CountBadge, StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useTableSort } from "@/hooks/use-table-sort";
import {
  acadCompletionsQuery,
  acadReviewQueueQuery,
  invalidateAcademy,
  markAcadCompletionSeen,
} from "@/lib/academy/data";
import { acadError } from "@/lib/academy/logic";
import type { AcadCompletion, AcadReviewItem } from "@/lib/academy/types";
import { formatDate, formatDateTime } from "@/lib/format";
import type { SortGetters } from "@/lib/table-sort";
import { cn } from "@/lib/utils";

type ReviewTab = "answers" | "completed";

export const Route = createFileRoute("/_authenticated/academy/review/")({
  head: () => ({ meta: [{ title: "Проверка — Академия — LadyFitPro" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: ReviewTab } =>
    search.tab === "completed" ? { tab: "completed" } : {},
  pendingComponent: AcademyReviewPageSkeleton,
  component: ReviewPage,
});

/**
 * «Проверка» (право «Проверяет ответы»): вкладка «Ответы» — попытки тестов со
 * свободными ответами, ждущие оценки; «Пройденные курсы» — кто прошёл курс
 * (за 90 дней) и с каким результатом, новые — в счётчике рейки и меню.
 */
function ReviewPage() {
  const navigate = useNavigate();
  const { tab = "answers" } = Route.useSearch();
  const access = useAdminAccess();
  const toReview = access?.academy?.to_review ?? 0;
  const newCompletions = access?.academy?.new_completions ?? 0;
  return (
    <AdminShell title="Проверка">
      <div className="mx-auto max-w-5xl space-y-3">
        <TableToolbar>
          <Tabs
            value={tab}
            onValueChange={(t) =>
              void navigate({
                to: "/academy/review",
                search: t === "completed" ? { tab: "completed" } : {},
                replace: true,
              })
            }
            className="toolbar-full"
          >
            <TabsList>
              <TabsTrigger value="answers" className="gap-1.5">
                Ответы
                {toReview > 0 && <CountBadge count={toReview} />}
              </TabsTrigger>
              <TabsTrigger value="completed" className="gap-1.5">
                Пройденные курсы
                {newCompletions > 0 && <CountBadge count={newCompletions} />}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </TableToolbar>
        {tab === "completed" ? <CompletionsTab /> : <AnswersTab />}
      </div>
    </AdminShell>
  );
}

const ANSWERS_SORT: SortGetters<AcadReviewItem> = {
  name: (r) => r.full_name ?? "",
  course: (r) => r.course_title,
  sent: (r) => r.submitted_at,
  open: (r) => r.open_answers,
};

function AnswersTab() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(acadReviewQueueQuery);
  const sort = useTableSort<AcadReviewItem>(ANSWERS_SORT);
  const rows = sort.apply(data ?? []);
  const open = (r: AcadReviewItem) =>
    void navigate({ to: "/academy/review/$attemptId", params: { attemptId: r.attempt_id } });

  if (error && !data) return <InfoNote variant="warning">{acadError(error)}</InfoNote>;
  if (data && data.length === 0)
    return (
      <AcadEmpty title="Проверять нечего">
        Здесь появятся тесты со свободными ответами, которые ученики отправили на проверку.
      </AcadEmpty>
    );
  return (
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
  );
}

const COMPLETIONS_SORT: SortGetters<AcadCompletion> = {
  name: (r) => r.full_name ?? "",
  course: (r) => r.course_title,
  result: (r) => (r.avg_percent == null ? -1 : Number(r.avg_percent)),
  done: (r) => r.completed_at,
};

const completionKey = (r: AcadCompletion) => `${r.course_id}:${r.user_id}`;

function CompletionsTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery(acadCompletionsQuery);
  const sort = useTableSort<AcadCompletion>(COMPLETIONS_SORT);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const rows = sort.apply(data ?? []);
  const opened = (data ?? []).find((r) => completionKey(r) === openKey) ?? null;
  const newCount = (data ?? []).filter((r) => r.is_new).length;

  const open = (r: AcadCompletion) => {
    setOpenKey(completionKey(r));
    if (!r.seen)
      void markAcadCompletionSeen(r.course_id, r.user_id)
        .then(() => invalidateAcademy(qc))
        .catch((e: unknown) => toast.error(acadError(e)));
  };
  const markAll = async () => {
    setMarking(true);
    try {
      await markAcadCompletionSeen();
      await invalidateAcademy(qc);
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setMarking(false);
    }
  };

  if (error && !data) return <InfoNote variant="warning">{acadError(error)}</InfoNote>;
  if (data && data.length === 0)
    return (
      <AcadEmpty title="Пока никто не прошёл курс">
        Здесь появятся сотрудники, прошедшие курс целиком за последние 90 дней, с результатами
        тестов.
      </AcadEmpty>
    );
  return (
    <div className="space-y-3">
      {newCount > 0 && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={marking} onClick={() => void markAll()}>
            <CheckCircle2 />
            Отметить все просмотренными
          </Button>
        </div>
      )}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Сотрудник</TableHead>
              <TableHead {...sort.head("course")}>Курс</TableHead>
              <TableHead {...sort.head("result")}>Тесты</TableHead>
              <TableHead {...sort.head("done")}>Пройден</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={4} rows={4} />
            ) : (
              rows.map((r) => (
                <TableRow
                  key={completionKey(r)}
                  className={cn("cursor-pointer", r.is_new && "bg-blue-50/60 dark:bg-blue-400/5")}
                  tabIndex={0}
                  onClick={() => open(r)}
                  onKeyDown={(e) => e.key === "Enter" && open(r)}
                >
                  <TableCell>
                    <PersonCell name={r.full_name} avatar={r.avatar_url} userId={r.user_id} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{r.course_title}</span>
                      {r.is_new && (
                        <StatusChip tone="info" size="sm">
                          Новое
                        </StatusChip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {r.avg_percent == null ? (
                      <span className="text-muted-foreground">Без тестов</span>
                    ) : (
                      <>
                        {Math.round(Number(r.avg_percent))}%
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {r.tests.length} {testsWord(r.tests.length)}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(r.completed_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!opened} onOpenChange={(o) => !o && setOpenKey(null)}>
        <DialogContent className="max-w-2xl">
          {opened && <CompletionDialog row={opened} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function testsWord(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "тест";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "теста";
  return "тестов";
}

function CompletionDialog({ row }: { row: AcadCompletion }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{row.full_name || "Сотрудник"}</DialogTitle>
        <DialogDescription>
          Прошёл курс «{row.course_title}» {formatDate(row.completed_at)}.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {row.tests.length === 0 ? (
          <InfoNote variant="empty">В курсе нет тестов — только уроки.</InfoNote>
        ) : (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Тесты — последняя попытка</h3>
            <ul className="divide-y rounded-md border">
              {row.tests.map((t) => (
                <li key={t.step_id}>
                  <Link
                    to="/academy/attempts/$attemptId"
                    params={{ attemptId: t.attempt_id }}
                    className="flex items-center gap-3 p-3 text-sm hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.step_title}</span>
                      <span className="text-xs text-muted-foreground">
                        попытка {t.attempt_no} · {formatDateTime(t.submitted_at)}
                      </span>
                    </span>
                    <span className="tabular-nums">{Math.round(Number(t.percent))}%</span>
                    <AttemptBadge status={t.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogBody>
    </>
  );
}
