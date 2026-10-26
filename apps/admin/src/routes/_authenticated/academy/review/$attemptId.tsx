import { createFileRoute } from "@tanstack/react-router";

import { AdminShell } from "@/components/admin-shell";
import { AttemptView } from "@/components/academy/attempt-view";
import { AcademyAttemptPageSkeleton } from "@/components/page-skeletons";

// Проверка попытки: свободные ответы — «Верно / Неверно» и комментарий.
export const Route = createFileRoute("/_authenticated/academy/review/$attemptId")({
  head: () => ({ meta: [{ title: "Проверка ответов — Академия — Base40 Admin" }] }),
  pendingComponent: AcademyAttemptPageSkeleton,
  component: ReviewAttemptPage,
});

function ReviewAttemptPage() {
  const { attemptId } = Route.useParams();
  return (
    <AdminShell title="Проверка ответов">
      <AttemptView key={attemptId} attemptId={attemptId} fromReview />
    </AdminShell>
  );
}
