import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { AcadCourseForm } from "@/components/academy/course-form";
import { AcadEmpty, CourseCover, CourseStatusBadge } from "@/components/academy/parts";
import { AcademyCoursesPageSkeleton } from "@/components/page-skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { supabase } from "@/integrations/supabase/client";
import {
  ACAD_KEY,
  acadCoursesQuery,
  acadFoldersQuery,
  acadOverviewQuery,
} from "@/lib/academy/data";
import { acadError, plural } from "@/lib/academy/logic";
import type { AcadCourse, AcadCourseStatus } from "@/lib/academy/types";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/academy/courses/")({
  head: () => ({ meta: [{ title: "Курсы — Академия — Base40 Admin" }] }),
  pendingComponent: AcademyCoursesPageSkeleton,
  component: CoursesPage,
});

type StatusFilter = "all" | AcadCourseStatus;
type StepCounts = { lessons: number; quizzes: number; emptyQuizzes: number };

/**
 * Каталог курсов (создателям и проверяющим): по папкам, у курса — статус,
 * число уроков и тестов, ученики и сколько прошли. Новый курс — создатель.
 */
function CoursesPage() {
  const navigate = useNavigate();
  const access = useAdminAccess();
  const canCreate = !!access?.academy?.is_admin || !!access?.academy?.can_create;
  const { data: courses, isLoading, error } = useQuery(acadCoursesQuery);
  const { data: folders } = useQuery(acadFoldersQuery);
  const { data: overview } = useQuery(acadOverviewQuery);
  const { data: stepCounts } = useQuery({
    queryKey: [ACAD_KEY, "step-counts"],
    queryFn: async () => {
      const [rows, questions] = await Promise.all([
        unwrap<{ id: string; course_id: string; kind: string }[]>(
          supabase.from("acad_steps").select("id, course_id, kind"),
        ),
        unwrap<{ step_id: string }[]>(supabase.from("acad_questions").select("step_id")),
      ]);
      const withQuestions = new Set(questions.map((q) => q.step_id));
      const out: Record<string, StepCounts> = {};
      for (const r of rows) {
        const c = (out[r.course_id] ??= { lessons: 0, quizzes: 0, emptyQuizzes: 0 });
        if (r.kind === "quiz") {
          c.quizzes += 1;
          if (!withQuestions.has(r.id)) c.emptyQuizzes += 1;
        } else c.lessons += 1;
      }
      return out;
    },
    meta: { errorMessage: "Не удалось посчитать уроки курсов" },
  });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [creating, setCreating] = useState(false);

  const term = q.trim().toLowerCase();
  const list = (courses ?? []).filter(
    (c) =>
      (status === "all" || c.status === status) && (!term || c.title.toLowerCase().includes(term)),
  );
  const groups = [
    ...(folders ?? []).map((f) => ({
      key: f.id,
      title: f.title,
      items: list.filter((c) => c.folder_id === f.id),
    })),
    {
      key: "none",
      title: "Без папки",
      items: list.filter((c) => !c.folder_id || !folders?.some((f) => f.id === c.folder_id)),
    },
  ].filter((g) => g.items.length > 0);
  const stats = new Map((overview ?? []).map((o) => [o.course_id, o]));

  return (
    <AdminShell
      title="Курсы"
      actions={
        canCreate ? (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Новый курс
          </Button>
        ) : null
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        {error && !courses ? (
          <InfoNote variant="warning">{acadError(error)}</InfoNote>
        ) : !isLoading && (courses ?? []).length === 0 ? (
          <AcadEmpty
            title="Курсов пока нет"
            action={
              canCreate ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus /> Создать первый курс
                </Button>
              ) : undefined
            }
          >
            Курс собирается из уроков (свой текст или копия статьи базы знаний) и тестов. Потом его
            назначают сотрудникам или ролям.
          </AcadEmpty>
        ) : (
          <>
            <TableToolbar>
              <ToolbarSearch value={q} onChange={setQ} placeholder="Название курса" />
              <SegmentedControl
                aria-label="Статус"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "all", label: "Все" },
                  { value: "published", label: "Опубликованы" },
                  { value: "draft", label: "Черновики" },
                  { value: "archived", label: "Архив" },
                ]}
              />
            </TableToolbar>
            {groups.length === 0 && !isLoading ? (
              <InfoNote variant="empty">Ничего не нашлось</InfoNote>
            ) : (
              groups.map((g) => (
                <section key={g.key} className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground">{g.title}</h2>
                  <ul className="divide-y rounded-lg border bg-background">
                    {g.items.map((c) => (
                      <CourseRow
                        key={c.id}
                        course={c}
                        counts={stepCounts?.[c.id]}
                        learners={stats.get(c.id)?.learners ?? 0}
                        completed={stats.get(c.id)?.completed ?? 0}
                        review={stats.get(c.id)?.review ?? 0}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg">
          {creating && (
            <AcadCourseForm
              course={null}
              onDone={(id) => {
                setCreating(false);
                if (id)
                  void navigate({ to: "/academy/courses/$courseId", params: { courseId: id } });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function CourseRow({
  course: c,
  counts,
  learners,
  completed,
  review,
}: {
  course: AcadCourse;
  counts?: StepCounts;
  learners: number;
  completed: number;
  review: number;
}) {
  return (
    <li>
      <Link
        to="/academy/courses/$courseId"
        params={{ courseId: c.id }}
        className="flex items-center gap-3 p-3 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CourseCover
          cover={c.cover}
          className="aspect-[16/9] w-28 shrink-0 rounded-md [&_svg]:size-6"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{c.title}</span>
            <CourseStatusBadge status={c.status} size="sm" />
          </span>
          <span className="block text-xs text-muted-foreground">
            {counts?.lessons ?? 0} {plural(counts?.lessons ?? 0, ["урок", "урока", "уроков"])} ·{" "}
            {counts?.quizzes ?? 0} {plural(counts?.quizzes ?? 0, ["тест", "теста", "тестов"])}
            {counts?.emptyQuizzes ? (
              <span className="text-amber-700">
                {" "}
                ·{" "}
                {counts.emptyQuizzes === counts.quizzes && counts.quizzes === 1
                  ? "без вопросов"
                  : `${counts.emptyQuizzes} без вопросов`}
              </span>
            ) : null}
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
          <span className="block text-sm font-medium text-foreground tabular-nums">
            {completed} из {learners}
          </span>
          прошли{review ? ` · ${review} на проверке` : ""}
        </span>
      </Link>
    </li>
  );
}
