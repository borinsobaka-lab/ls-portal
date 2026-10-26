import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { CoursePlayer } from "@/components/academy/course-player";
import { AcademyCoursePageSkeleton } from "@/components/page-skeletons";
import { acadCourseQuery } from "@/lib/academy/data";

// «Как видит ученик» из конструктора: внутри «Курсов» (в меню подсвечены они,
// а не «Мои курсы»), ход не записывается; ?step= — открытый шаг.
export const Route = createFileRoute("/_authenticated/academy/courses/$courseId/preview")({
  head: () => ({ meta: [{ title: "Как видит ученик — Академия — Base40 Admin" }] }),
  validateSearch: (search: Record<string, unknown>): { step?: string } =>
    typeof search.step === "string" ? { step: search.step } : {},
  pendingComponent: AcademyCoursePageSkeleton,
  component: PreviewPage,
});

function PreviewPage() {
  const { courseId } = Route.useParams();
  const { step } = Route.useSearch();
  const { data: course } = useQuery(acadCourseQuery(courseId));
  return (
    <AdminShell title={course ? `${course.title} — как видит ученик` : "Как видит ученик"}>
      <CoursePlayer key={courseId} courseId={courseId} stepId={step} preview />
    </AdminShell>
  );
}
