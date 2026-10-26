import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { StepEditor } from "@/components/academy/step-editor";
import { AcademyStepPageSkeleton } from "@/components/page-skeletons";
import { acadStepsQuery } from "@/lib/academy/data";

// Шаг курса в конструкторе: урок (текст) или тест (вопросы); ?new=1 — только
// что создан, курсор в название.
export const Route = createFileRoute("/_authenticated/academy/courses/$courseId/$stepId")({
  head: () => ({ meta: [{ title: "Шаг курса — Академия — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { new?: 1 } =>
    search.new === 1 || search.new === "1" ? { new: 1 } : {},
  pendingComponent: AcademyStepPageSkeleton,
  component: StepPage,
});

function StepPage() {
  const { courseId, stepId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  // «Только что создан» — один раз: метку из адреса убираем, иначе любое
  // повторное открытие страницы снова выделило бы название под замену.
  const [isNew] = useState(!!search.new);
  useEffect(() => {
    if (search.new)
      void navigate({
        to: "/academy/courses/$courseId/$stepId",
        params: { courseId, stepId },
        search: {},
        replace: true,
      });
  }, [search.new, navigate, courseId, stepId]);
  // Шапка — название шага, а не безликое «Шаг курса».
  const { data: steps } = useQuery(acadStepsQuery(courseId));
  const step = steps?.find((s) => s.id === stepId);
  return (
    <AdminShell title={step?.title ?? "Шаг курса"}>
      <StepEditor key={stepId} courseId={courseId} stepId={stepId} isNew={isNew} />
    </AdminShell>
  );
}
