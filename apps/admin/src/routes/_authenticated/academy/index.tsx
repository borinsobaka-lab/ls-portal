import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { AcadEmpty, CourseCover, ProgressBadge, ProgressBar } from "@/components/academy/parts";
import { AcademyMyPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { acadMyCoursesQuery } from "@/lib/academy/data";
import { dueLabel, plural, progressPercent } from "@/lib/academy/logic";
import type { AcadMyCourse } from "@/lib/academy/types";
import { formatDate, todayISO } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/academy/")({
  head: () => ({ meta: [{ title: "Мои курсы — Академия — Base40 Admin" }] }),
  pendingComponent: AcademyMyPageSkeleton,
  component: MyCoursesPage,
});

/**
 * «Академия» → «Мои курсы»: курсы, назначенные сотруднику (людям или
 * ролью), — сначала непройденные и просроченные. Схема —
 * db/migrations/2026-10-25_zzzzzzz_academy.sql (acad_my_courses).
 */
function MyCoursesPage() {
  const access = useAdminAccess();
  const { data, isLoading } = useQuery(acadMyCoursesQuery);
  const team =
    !!access?.academy?.is_admin || !!access?.academy?.can_create || !!access?.academy?.can_review;
  const courses = data ?? [];
  const open = courses.filter((c) => c.status !== "completed");
  const done = courses.filter((c) => c.status === "completed");

  return (
    <AdminShell title="Мои курсы">
      <div className="mx-auto max-w-5xl space-y-6">
        {isLoading ? null : courses.length === 0 ? (
          <AcadEmpty
            title="Вам пока не назначено ни одного курса"
            action={
              team ? (
                <Button asChild variant="outline">
                  <Link to="/academy/courses">Перейти к курсам</Link>
                </Button>
              ) : undefined
            }
          >
            Когда руководитель назначит курс, он появится здесь — со сроком, если он есть.
          </AcadEmpty>
        ) : (
          <>
            {open.length > 0 && <CourseGrid title="Нужно пройти" courses={open} />}
            {done.length > 0 && <CourseGrid title="Пройдено" courses={done} />}
          </>
        )}
      </div>
    </AdminShell>
  );
}

function CourseGrid({ title, courses }: { title: string; courses: AcadMyCourse[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">
        {title} · {courses.length}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((c) => (
          <CourseCard key={c.course_id} course={c} />
        ))}
      </div>
    </section>
  );
}

function CourseCard({ course: c }: { course: AcadMyCourse }) {
  const due = c.status === "completed" ? null : dueLabel(c.due_date, todayISO());
  const pct = progressPercent(c.steps_done, c.steps_total);
  return (
    <Link
      to="/academy/my/$courseId"
      params={{ courseId: c.course_id }}
      className="group flex flex-col overflow-hidden rounded-lg border bg-background outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* 16:9 — как просят загружать обложку: показывается целиком, без обрезки. */}
      <CourseCover cover={c.cover} className="aspect-[16/9]" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        {c.folder_title && (
          <span className="text-xs font-semibold text-brand-on-light">{c.folder_title}</span>
        )}
        <span className="line-clamp-2 font-semibold leading-snug">{c.title}</span>
        {c.description && (
          <span className="line-clamp-2 text-sm text-muted-foreground">{c.description}</span>
        )}
        <div className="mt-auto space-y-2 pt-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {c.steps_done} из {c.steps_total} {plural(c.steps_total, ["шага", "шагов", "шагов"])}
            </span>
            <ProgressBadge status={c.status} overdue={c.overdue} />
          </div>
          <ProgressBar value={pct} />
          <p className={cn("text-xs", due?.overdue ? "text-destructive" : "text-muted-foreground")}>
            {c.status === "completed"
              ? `Пройден ${formatDate(c.completed_at)}`
              : (due?.text ?? "Без срока")}
          </p>
        </div>
      </div>
    </Link>
  );
}
