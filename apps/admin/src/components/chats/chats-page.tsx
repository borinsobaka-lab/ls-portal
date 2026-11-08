/**
 * Раздел «Чаты» (TASKS_CHATS_PLAN.md, веха 2): слева — список (папка из
 * меню раздела), справа — открытый чат и его сведения. На телефоне — одно
 * из двух: список или чат во весь экран (назад — к списку).
 *
 * Группа с темами (этап 2, Д.5): справа — колонка тем и переписка открытой
 * темы («Общая» — сама группа). С lg — обе рядом; уже — по очереди: список
 * тем, затем тема (назад — к темам). Сведения темы — сведения её группы.
 */
import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { ChatInfo } from "@/components/chats/chat-info";
import { ChatList } from "@/components/chats/chat-list";
import { ChatView } from "@/components/chats/chat-view";
import { TopicsPane } from "@/components/chats/topics-pane";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { chatTitle } from "@/lib/chats/content";
import { useChatList } from "@/lib/chats/data";
import type { FolderKey } from "@/lib/chats/folders";
import { usePeople } from "@/lib/chats/people";
import { isForum } from "@/lib/chats/topics";
import { cn } from "@/lib/utils";

const WIDE = "(min-width: 1024px)";
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
/** С lg колонка тем стоит рядом с перепиской. */
function useWide() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export function ChatsPage({
  chatId,
  folder,
  focusSeq,
  general = false,
}: {
  chatId: string | null;
  folder: FolderKey;
  focusSeq: number | null;
  /** У группы с темами — открыть «Общую» (на узком экране). */
  general?: boolean;
}) {
  const navigate = useNavigate();
  const { data: profile } = useStaffProfile();
  const { data: chats, isPending } = useChatList();
  const { name } = usePeople();
  const wide = useWide();
  const [infoOpen, setInfoOpen] = useState(false);
  const me = profile?.id ?? "";
  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const group =
    chat?.kind === "topic"
      ? (chats?.find((c) => c.id === chat.parent_id) ?? null)
      : chat && isForum(chat)
        ? chat
        : null;
  // Узкий экран, группа с темами, тема не выбрана — список тем вместо переписки.
  const topicsOnly = !!group && chat?.id === group.id && !general && !focusSeq && !wide;
  const infoChat = group ?? chat;
  const search = folder === "all" ? {} : { f: folder };

  const open = (id: string, seq?: number, g?: boolean) =>
    navigate({
      to: "/chats/$chatId",
      params: { chatId: id },
      search: { ...search, ...(seq ? { m: seq } : {}), ...(g ? { g: true } : {}) },
    });

  const title = !chat
    ? "Чаты"
    : chat.kind === "topic" && group
      ? `${chatTitle(group, name)} › ${chatTitle(chat, name)}`
      : chatTitle(chat, name);

  return (
    <AdminShell title={title} fill hideHeaderOnMobile={!!chatId}>
      <div className="flex h-full min-h-0">
        <div
          className={cn(
            "flex min-h-0 w-full flex-col border-r bg-background md:w-80 lg:w-96 md:shrink-0",
            chatId && "max-md:hidden",
            group && "lg:max-xl:w-80",
          )}
        >
          {me && <ChatList activeId={group?.id ?? chatId} folder={folder} me={me} onOpen={open} />}
        </div>
        {group && me && (wide || topicsOnly) && (
          <TopicsPane
            group={group}
            chats={chats ?? []}
            activeId={topicsOnly ? null : (chat?.id ?? null)}
            me={me}
            onOpen={(id, g) => void open(id, undefined, g)}
            onBack={() => navigate({ to: "/chats", search })}
            onInfo={() => setInfoOpen(true)}
            className={cn("border-r", topicsOnly ? "min-w-0 flex-1" : "w-72 shrink-0")}
          />
        )}
        {!topicsOnly && (
          <div className={cn("min-h-0 min-w-0 flex-1", !chatId && "max-md:hidden")}>
            {chat && me ? (
              <ChatView
                key={chat.id}
                chat={chat}
                me={me}
                focusSeq={focusSeq}
                group={group}
                onBack={() =>
                  group
                    ? navigate({ to: "/chats/$chatId", params: { chatId: group.id }, search })
                    : navigate({ to: "/chats", search })
                }
                onInfo={() => setInfoOpen(true)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                <MessagesSquare className="size-10 opacity-40" />
                <p className="text-sm">
                  {chatId && !isPending
                    ? "Чат не найден или вас в нём нет."
                    : "Выберите чат слева или начните новый."}
                </p>
              </div>
            )}
          </div>
        )}
        {infoChat && me && (
          <ChatInfo
            chat={infoChat}
            me={me}
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            onJump={(seq) => {
              setInfoOpen(false);
              void open(infoChat.id, seq, true);
            }}
          />
        )}
      </div>
    </AdminShell>
  );
}
