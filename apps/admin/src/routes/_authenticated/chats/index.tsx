import { createFileRoute } from "@tanstack/react-router";

import { ChatsPage } from "@/components/chats/chats-page";
import { ChatsPageSkeleton } from "@/components/page-skeletons";
import { PORTAL_NAME } from "@/lib/brand";
import { chatsSearch } from "@/lib/chats/search-params";

/** «Чаты» без открытого чата: список (папка — ?f=). */
export const Route = createFileRoute("/_authenticated/chats/")({
  head: () => ({ meta: [{ title: `Чаты — ${PORTAL_NAME}` }] }),
  validateSearch: chatsSearch,
  pendingComponent: ChatsPageSkeleton,
  component: ChatsIndex,
});

function ChatsIndex() {
  const { f } = Route.useSearch();
  return <ChatsPage chatId={null} folder={f ?? "all"} focusSeq={null} />;
}
