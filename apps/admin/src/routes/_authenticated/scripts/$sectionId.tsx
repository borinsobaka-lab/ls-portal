import { createFileRoute } from "@tanstack/react-router";

import { ScriptsPage } from "@/components/scripts/scripts-page";
import { ScriptsSectionPageSkeleton } from "@/components/page-skeletons";

// Раздел «Скриптов LS». ?item=<id> — ссылка на скрипт: докрутить и
// подсветить; если скрипт перенесли, страница найдёт его в другом разделе.
export const Route = createFileRoute("/_authenticated/scripts/$sectionId")({
  head: () => ({ meta: [{ title: "Скрипты LS — Lady Stretch" }] }),
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" && search.item ? { item: search.item } : {},
  pendingComponent: ScriptsSectionPageSkeleton,
  component: ScriptsSection,
});

function ScriptsSection() {
  const { sectionId } = Route.useParams();
  const { item } = Route.useSearch();
  return <ScriptsPage sectionId={sectionId} focusId={item} />;
}
