import { createFileRoute } from "@tanstack/react-router";

import { KbNodePage } from "@/components/kb/kb-node-page";
import { KbNodePageSkeleton } from "@/components/page-skeletons";

// Папка или статья базы знаний. ?edit=1 — сразу в редактор (новая статья, копия).
export const Route = createFileRoute("/_authenticated/kb/$baseId/$nodeId")({
  head: () => ({ meta: [{ title: "База знаний — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { edit?: boolean } =>
    search.edit === true || search.edit === "1" || search.edit === "true" ? { edit: true } : {},
  pendingComponent: KbNodePageSkeleton,
  component: KbNode,
});

function KbNode() {
  const { baseId, nodeId } = Route.useParams();
  const { edit } = Route.useSearch();
  return <KbNodePage key={nodeId} baseId={baseId} nodeId={nodeId} edit={edit} />;
}
