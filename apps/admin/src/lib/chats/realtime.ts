/**
 * Живое обновление чатов — личная тема Realtime `user:<id>` (приватный
 * канал: политика на realtime.messages пускает только в свою тему). База
 * шлёт короткое событие {type, chat_id, seq} на каждое изменение чата
 * (chat_broadcast в db/migrations/2026-11-08_chats.sql), здесь — дозапрос
 * того, что изменилось. Соединения нет (Realtime не поднят, сеть) — чаты
 * работают опросом (lib/chats/data.ts), после переподключения — дозапрос
 * всего открытого.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { loadNewer, messagesKey, refreshMessage, type ChatWindow } from "./data";
import { emitChatEvent, setRealtimeConnected, type ChatEvent } from "./realtime-state";

let listTimer: ReturnType<typeof setTimeout> | null = null;

/** Список и счётчики — не чаще раза в 400 мс (пачка сообщений — один запрос). */
function invalidateList(qc: QueryClient) {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void qc.invalidateQueries({ queryKey: ["chat_list"] });
    void qc.invalidateQueries({ queryKey: ["chat_unread"] });
  }, 400);
}

export function handleChatEvent(qc: QueryClient, e: ChatEvent) {
  if (!e?.chat_id) return;
  const open = !!qc.getQueryData<ChatWindow>(messagesKey(e.chat_id));
  switch (e.type) {
    case "message":
      invalidateList(qc);
      if (open) void loadNewer(qc, e.chat_id);
      break;
    case "edit":
    case "react":
    case "delete":
      if (open && e.seq) void refreshMessage(qc, e.chat_id, Number(e.seq));
      if (e.type === "delete") invalidateList(qc);
      break;
    case "pin":
      if (open && e.seq) void refreshMessage(qc, e.chat_id, Number(e.seq));
      void qc.invalidateQueries({ queryKey: ["chat_pinned", e.chat_id] });
      break;
    case "read":
      void qc.invalidateQueries({ queryKey: ["chat_members", e.chat_id] });
      invalidateList(qc);
      break;
    case "members":
    case "chat":
    case "removed":
      void qc.invalidateQueries({ queryKey: ["chat_members", e.chat_id] });
      invalidateList(qc);
      if (open && e.type !== "removed") void loadNewer(qc, e.chat_id);
      break;
  }
  emitChatEvent(e);
}

/** Подписка вошедшего (монтирует каркас портала один раз). */
export function useChatRealtime(userId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    let wasConnected = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      channel = supabase
        .channel(`user:${userId}`, { config: { private: true } })
        .on("broadcast", { event: "chat" }, ({ payload }) =>
          handleChatEvent(qc, payload as ChatEvent),
        )
        .subscribe((status) => {
          const ok = status === "SUBSCRIBED";
          setRealtimeConnected(ok);
          // Переподключились — дозапросить всё, что могли пропустить.
          if (ok && wasConnected) {
            void qc.invalidateQueries({ queryKey: ["chat_list"] });
            void qc.invalidateQueries({ queryKey: ["chat_unread"] });
            for (const q of qc.getQueryCache().findAll({ queryKey: ["chat_messages"] })) {
              const chatId = q.queryKey[1];
              if (typeof chatId === "string") void loadNewer(qc, chatId);
            }
          }
          if (ok) wasConnected = true;
        });
    })();
    return () => {
      cancelled = true;
      setRealtimeConnected(false);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId, qc]);
}

/** «Печатает…»: тема `chat:<id>`, только участники (политика базы). */
export function joinTypingChannel(
  chatId: string,
  onTyping: (userId: string) => void,
): { send: (userId: string) => void; leave: () => void } {
  const channel = supabase
    .channel(`chat:${chatId}`, { config: { private: true, broadcast: { self: false } } })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      const uid = (payload as { user_id?: string })?.user_id;
      if (uid) onTyping(uid);
    })
    .subscribe();
  return {
    send: (userId) =>
      void channel.send({ type: "broadcast", event: "typing", payload: { user_id: userId } }),
    leave: () => void supabase.removeChannel(channel),
  };
}
