import { createFileRoute } from "@tanstack/react-router";

import { AdminShell } from "@/components/admin-shell";
import { AttemptView } from "@/components/academy/attempt-view";
import { AcademyAttemptPageSkeleton } from "@/components/page-skeletons";

// Результат теста: ответы ученика, баллы и комментарии проверяющего.
export const Route = createFileRoute("/_authenticated/academy/attempts/$attemptId")({
  head: () => ({ meta: [{ title: "Результат теста — Академия — Lady Stretch" }] }),
  pendingComponent: AcademyAttemptPageSkeleton,
  component: AttemptPage,
});

function AttemptPage() {
  const { attemptId } = Route.useParams();
  return (
    <AdminShell title="Результат теста">
      <AttemptView key={attemptId} attemptId={attemptId} />
    </AdminShell>
  );
}
