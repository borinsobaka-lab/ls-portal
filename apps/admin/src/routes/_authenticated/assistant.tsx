import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/admin-shell";
import { KateChat } from "@/components/kate-chat";
import { AssistantPageSkeleton } from "@/components/page-skeletons";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({ meta: [{ title: "Kate — AI ассистент" }] }),
  pendingComponent: AssistantPageSkeleton,
  component: AssistantPage,
});

function AssistantPage() {
  return (
    <AdminShell title="Kate — AI ассистент">
      <KateChat />
    </AdminShell>
  );
}
