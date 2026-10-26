import { createFileRoute } from "@tanstack/react-router";

import { ScriptsPage } from "@/components/scripts/scripts-page";
import { ScriptsAllPageSkeleton } from "@/components/page-skeletons";

// «Скрипты LS» → «Все скрипты». ?item=<id> — ссылка на скрипт без раздела:
// страница сама откроет раздел, где он лежит.
export const Route = createFileRoute("/_authenticated/scripts/")({
  head: () => ({ meta: [{ title: "Скрипты LS — Base40 Admin" }] }),
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" && search.item ? { item: search.item } : {},
  pendingComponent: ScriptsAllPageSkeleton,
  component: AllScripts,
});

function AllScripts() {
  const { item } = Route.useSearch();
  return <ScriptsPage focusId={item} />;
}
