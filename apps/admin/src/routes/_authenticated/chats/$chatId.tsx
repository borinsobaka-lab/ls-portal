import { createFileRoute } from "@tanstack/react-router";

import { ChatsPage } from "@/components/chats/chats-page";
import { ChatsPageSkeleton } from "@/components/page-skeletons";
import { PORTAL_NAME } from "@/lib/brand";
import { chatsSearch } from "@/lib/chats/search-params";

/** Открытый чат: /chats/<id>, ?m=<seq> — на нужном сообщении, ?f= — папка списка. */
export const Route = createFileRoute("/_authenticated/chats/$chatId")({
  head: () => ({ meta: [{ title: `Чаты — ${PORTAL_NAME}` }] }),
  validateSearch: chatsSearch,
  pendingComponent: ChatsPageSkeleton,
  component: ChatRoute,
});

function ChatRoute() {
  const { chatId } = Route.useParams();
  const { f, m, g } = Route.useSearch();
  return <ChatsPage chatId={chatId} folder={f ?? "all"} focusSeq={m ?? null} general={!!g} />;
}
