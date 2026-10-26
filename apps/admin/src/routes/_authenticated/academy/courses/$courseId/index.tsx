import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { CourseBuilder, type BuilderTab } from "@/components/academy/course-builder";
import { AcademyBuilderPageSkeleton } from "@/components/page-skeletons";
import { acadCourseQuery } from "@/lib/academy/data";

const TABS: BuilderTab[] = ["content", "learners", "errors"];

// Конструктор курса; ?tab= — «Ученики» / «Ошибки» (без — «Содержание»).
export const Route = createFileRoute("/_authenticated/academy/courses/$courseId/")({
  head: () => ({ meta: [{ title: "Курс — Академия — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: BuilderTab } =>
    TABS.includes(search.tab as BuilderTab) && search.tab !== "content"
      ? { tab: search.tab as BuilderTab }
      : {},
  pendingComponent: AcademyBuilderPageSkeleton,
  component: BuilderPage,
});

function BuilderPage() {
  const { courseId } = Route.useParams();
  const { tab } = Route.useSearch();
  const { data: course } = useQuery(acadCourseQuery(courseId));
  return (
    <AdminShell title={course?.title ?? "Курс"}>
      <CourseBuilder key={courseId} courseId={courseId} tab={tab ?? "content"} />
    </AdminShell>
  );
}
