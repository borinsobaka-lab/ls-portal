/**
 * Раздел «Чаты» (TASKS_CHATS_PLAN.md, веха 2): слева — список (папка из
 * меню раздела), справа — открытый чат и его сведения. На телефоне — одно
 * из двух: список или чат во весь экран (назад — к списку).
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { ChatInfo } from "@/components/chats/chat-info";
import { ChatList } from "@/components/chats/chat-list";
import { ChatView } from "@/components/chats/chat-view";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { chatTitle } from "@/lib/chats/content";
import { useChatList } from "@/lib/chats/data";
import type { FolderKey } from "@/lib/chats/folders";
import { usePeople } from "@/lib/chats/people";
import { cn } from "@/lib/utils";

export function ChatsPage({
  chatId,
  folder,
  focusSeq,
}: {
  chatId: string | null;
  folder: FolderKey;
  focusSeq: number | null;
}) {
  const navigate = useNavigate();
  const { data: profile } = useStaffProfile();
  const { data: chats, isPending } = useChatList();
  const { name } = usePeople();
  const [infoOpen, setInfoOpen] = useState(false);
  const me = profile?.id ?? "";
  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const search = folder === "all" ? {} : { f: folder };

  const open = (id: string, seq?: number) =>
    navigate({
      to: "/chats/$chatId",
      params: { chatId: id },
      search: { ...search, ...(seq ? { m: seq } : {}) },
    });

  return (
    <AdminShell title={chat ? chatTitle(chat, name) : "Чаты"} fill hideHeaderOnMobile={!!chatId}>
      <div className="flex h-full min-h-0">
        <div
          className={cn(
            "flex min-h-0 w-full flex-col border-r bg-background md:w-80 lg:w-96 md:shrink-0",
            chatId && "max-md:hidden",
          )}
        >
          {me && <ChatList activeId={chatId} folder={folder} me={me} onOpen={open} />}
        </div>
        <div className={cn("min-h-0 min-w-0 flex-1", !chatId && "max-md:hidden")}>
          {chat && me ? (
            <>
              <ChatView
                key={chat.id}
                chat={chat}
                me={me}
                focusSeq={focusSeq}
                onBack={() => navigate({ to: "/chats", search })}
                onInfo={() => setInfoOpen(true)}
              />
              <ChatInfo
                chat={chat}
                me={me}
                open={infoOpen}
                onClose={() => setInfoOpen(false)}
                onJump={(seq) => {
                  setInfoOpen(false);
                  void open(chat.id, seq);
                }}
              />
            </>
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
      </div>
    </AdminShell>
  );
}
