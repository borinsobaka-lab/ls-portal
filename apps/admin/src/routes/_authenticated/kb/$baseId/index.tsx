import { createFileRoute } from "@tanstack/react-router";

import { KbNodePage } from "@/components/kb/kb-node-page";
import { KbNodePageSkeleton } from "@/components/page-skeletons";

// Главная базы знаний: описание, теги и разделы верхнего уровня; дерево — в меню слева.
export const Route = createFileRoute("/_authenticated/kb/$baseId/")({
  // ?tag=<id> — статьи с тегом (облако тегов на главной, поиск в шапке).
  validateSearch: (search: Record<string, unknown>): { tag?: string } => ({
    tag:
      typeof search.tag === "string" && /^[0-9a-f-]{36}$/.test(search.tag) ? search.tag : undefined,
  }),
  head: () => ({ meta: [{ title: "База знаний — Lady Stretch" }] }),
  pendingComponent: KbNodePageSkeleton,
  component: KbBaseHome,
});

function KbBaseHome() {
  const { baseId } = Route.useParams();
  const { tag } = Route.useSearch();
  return <KbNodePage key={baseId} baseId={baseId} nodeId={null} tagId={tag} />;
}
