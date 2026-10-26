import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import {
  AcadEmpty,
  AttemptBadge,
  CourseStatusBadge,
  PersonCell,
  ProgressBadge,
  ProgressBar,
} from "@/components/academy/parts";
import { AcademyReportPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTableSort } from "@/hooks/use-table-sort";
import { acadOverviewQuery, acadPeopleQuery, acadPersonQuery } from "@/lib/academy/data";
import { acadError, progressPercent } from "@/lib/academy/logic";
import type { AcadOverviewRow, AcadPeopleRow } from "@/lib/academy/types";
import { formatDate, formatDateTime } from "@/lib/format";
import type { SortGetters } from "@/lib/table-sort";
import { cn } from "@/lib/utils";

type ReportTab = "courses" | "people";

export const Route = createFileRoute("/_authenticated/academy/report")({
  head: () => ({ meta: [{ title: "Отчёт — Академия — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: ReportTab } =>
    search.tab === "people" ? { tab: "people" } : {},
  pendingComponent: AcademyReportPageSkeleton,
  component: ReportPage,
});

const TIPS = {
  overdue: "Срок назначения прошёл, а курс не пройден.",
  review: "Тест отправлен, свободные ответы ждут проверяющего.",
};

/**
 * Отчёт по обучению (№68 брифа; создателям и проверяющим): по курсам — сколько
 * учеников и в каком состоянии, по сотрудникам — их курсы, просрочки и
 * попытки. Разбор ошибок по вопросам — во вкладке «Ошибки» курса.
 */
function ReportPage() {
  const navigate = useNavigate();
  const { tab = "courses" } = Route.useSearch();
  return (
    <AdminShell title="Отчёт по обучению">
      <div className="mx-auto max-w-6xl space-y-4">
        <Tabs
          value={tab}
          onValueChange={(t) =>
            void navigate({
              to: "/academy/report",
              search: t === "people" ? { tab: "people" } : {},
              replace: true,
            })
          }
        >
          <TabsList>
            <TabsTrigger value="courses">Курсы</TabsTrigger>
            <TabsTrigger value="people">Сотрудники</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "people" ? <PeopleTab /> : <CoursesTab />}
      </div>
    </AdminShell>
  );
}

const COURSE_SORT: SortGetters<AcadOverviewRow> = {
  title: (r) => r.title,
  learners: (r) => r.learners,
  completed: (r) => (r.learners ? r.completed / r.learners : -1),
  overdue: (r) => r.overdue,
  review: (r) => r.review,
};

function CoursesTab() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery(acadOverviewQuery);
  const sort = useTableSort<AcadOverviewRow>(COURSE_SORT);
  if (error && !data) return <InfoNote variant="warning">{acadError(error)}</InfoNote>;
  if (data && data.length === 0) return <AcadEmpty title="Курсов пока нет" />;
  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead {...sort.head("title")}>Курс</TableHead>
            <TableHead {...sort.head("learners")}>Учеников</TableHead>
            <TableHead {...sort.head("completed")}>Прошли</TableHead>
            <TableHead>Проходят / не начали</TableHead>
            <TableHead tip={TIPS.review} {...sort.head("review")}>
              На проверке
            </TableHead>
            <TableHead tip={TIPS.overdue} {...sort.head("overdue")}>
              Просрочено
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableSkeletonRows columns={6} rows={4} />
          ) : (
            sort.apply(data ?? []).map((r) => (
              <TableRow
                key={r.course_id}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() =>
                  void navigate({
                    to: "/academy/courses/$courseId",
                    params: { courseId: r.course_id },
                    search: { tab: "learners" },
                  })
                }
              >
                <TableCell>
                  <span className="block font-medium">{r.title}</span>
                  <CourseStatusBadge status={r.status} size="sm" />
                </TableCell>
                <TableCell className="text-sm tabular-nums">{r.learners}</TableCell>
                <TableCell className="min-w-40">
                  <span className="mb-1 block text-xs tabular-nums">
                    {r.completed} из {r.learners}
                  </span>
                  <ProgressBar value={progressPercent(r.completed, r.learners)} />
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {r.in_progress} / {r.not_started}
                </TableCell>
                <TableCell className={cn("text-sm tabular-nums", r.review > 0 && "text-amber-700")}>
                  {r.review}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-sm tabular-nums",
                    r.overdue > 0 && "font-medium text-destructive",
                  )}
                >
                  {r.overdue}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

const PEOPLE_SORT: SortGetters<AcadPeopleRow> = {
  name: (r) => r.full_name ?? "",
  courses: (r) => r.courses,
  completed: (r) => (r.courses ? r.completed / r.courses : -1),
  overdue: (r) => r.overdue,
  activity: (r) => r.last_activity_at,
};

function PeopleTab() {
  const { data, isLoading, error } = useQuery(acadPeopleQuery);
  const sort = useTableSort<AcadPeopleRow>(PEOPLE_SORT);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<AcadPeopleRow | null>(null);
  const term = q.trim().toLowerCase();
  const rows = sort.apply(
    (data ?? []).filter((r) => !term || (r.full_name ?? "").toLowerCase().includes(term)),
  );
  if (error && !data) return <InfoNote variant="warning">{acadError(error)}</InfoNote>;
  if (data && data.length === 0)
    return <AcadEmpty title="Опубликованные курсы пока никому не назначены" />;
  return (
    <div className="space-y-3">
      <TableToolbar>
        <ToolbarSearch value={q} onChange={setQ} placeholder="Имя сотрудника" />
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Сотрудник</TableHead>
              <TableHead {...sort.head("courses")}>Курсов</TableHead>
              <TableHead {...sort.head("completed")}>Пройдено</TableHead>
              <TableHead tip={TIPS.overdue} {...sort.head("overdue")}>
                Просрочено
              </TableHead>
              <TableHead {...sort.head("activity")}>Последнее действие</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={5} rows={5} />
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.user_id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                >
                  <TableCell>
                    <PersonCell name={r.full_name} avatar={r.avatar_url} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{r.courses}</TableCell>
                  <TableCell className="min-w-40">
                    <span className="mb-1 block text-xs tabular-nums">
                      {r.completed} из {r.courses}
                      {r.review ? ` · ${r.review} на проверке` : ""}
                    </span>
                    <ProgressBar value={progressPercent(r.completed, r.courses)} />
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-sm tabular-nums",
                      r.overdue > 0 && "font-medium text-destructive",
                    )}
                  >
                    {r.overdue}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.last_activity_at ? formatDateTime(r.last_activity_at) : "Не начинал"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-2xl">{open && <PersonDialog row={open} />}</DialogContent>
      </Dialog>
    </div>
  );
}

function PersonDialog({ row }: { row: AcadPeopleRow }) {
  const { data, isLoading } = useQuery(acadPersonQuery(row.user_id));
  return (
    <>
      <DialogHeader>
        <DialogTitle>{row.full_name || "Сотрудник"}</DialogTitle>
        <DialogDescription>Назначенные курсы и попытки тестов.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {isLoading || !data ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Курсы</h3>
              <ul className="divide-y rounded-md border">
                {data.courses.map((c) => (
                  <li key={c.course_id} className="space-y-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{c.title}</span>
                      <ProgressBadge status={c.status} overdue={c.overdue} />
                    </div>
                    <ProgressBar value={progressPercent(c.steps_done, c.steps_total)} />
                    <p className="text-xs text-muted-foreground">
                      {c.steps_done} из {c.steps_total} шагов
                      {c.due_date ? ` · срок ${formatDate(c.due_date)}` : ""}
                      {c.completed_at ? ` · пройден ${formatDate(c.completed_at)}` : ""}
                      {c.avg_percent != null
                        ? ` · тесты ${Math.round(Number(c.avg_percent))}%`
                        : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Попытки тестов</h3>
              {data.attempts.length === 0 ? (
                <InfoNote variant="empty">Тестов пока не сдавал.</InfoNote>
              ) : (
                <ul className="divide-y rounded-md border">
                  {data.attempts.map((a) => (
                    <li key={a.id}>
                      <Link
                        to="/academy/attempts/$attemptId"
                        params={{ attemptId: a.id }}
                        className="flex items-center gap-3 p-3 text-sm hover:bg-muted/40"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{a.step_title}</span>
                          <span className="text-xs text-muted-foreground">
                            {a.course_title} · попытка {a.attempt_no} ·{" "}
                            {formatDateTime(a.submitted_at)}
                          </span>
                        </span>
                        <span className="tabular-nums">{Math.round(Number(a.percent))}%</span>
                        <AttemptBadge status={a.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogBody>
    </>
  );
}
