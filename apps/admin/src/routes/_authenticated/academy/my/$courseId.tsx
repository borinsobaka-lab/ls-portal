import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { CoursePlayer } from "@/components/academy/course-player";
import { AcademyCoursePageSkeleton } from "@/components/page-skeletons";
import { acadCourseViewQuery } from "@/lib/academy/data";

// Прохождение курса; ?step= — открытый шаг (иначе первый непройденный).
export const Route = createFileRoute("/_authenticated/academy/my/$courseId")({
  head: () => ({ meta: [{ title: "Курс — Академия — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { step?: string } =>
    typeof search.step === "string" ? { step: search.step } : {},
  pendingComponent: AcademyCoursePageSkeleton,
  component: CoursePage,
});

function CoursePage() {
  const { courseId } = Route.useParams();
  const { step } = Route.useSearch();
  // Тот же запрос, что у CoursePlayer, — шапке название курса.
  const { data: view } = useQuery(acadCourseViewQuery(courseId));
  return (
    <AdminShell title={view?.course.title ?? "Курс"}>
      <CoursePlayer key={courseId} courseId={courseId} stepId={step} />
    </AdminShell>
  );
}
