/**
 * Чаты — запросы и кэш (RPC chat_* из db/migrations/2026-11-08_chats.sql).
 *
 * - Список чатов — ["chat_list"], счётчик рейки — ["chat_unread"].
 * - Переписка открытого чата — ["chat_messages", chatId]: окно сообщений по
 *   возрастанию seq (последние 50, по прокрутке вверх — старше). Новые
 *   дозапрашиваются «после последнего seq» — пропусков не бывает.
 * - Живое обновление — Realtime (lib/chats/realtime.ts): событие {type,
 *   chat_id, seq} → дозапрос. Нет соединения — опрос: список раз в 10 с,
 *   открытый чат — раз в 4 с.
 */
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { useRealtimeConnected } from "./realtime-state";
import type {
  ChatDoc,
  ChatFolder,
  ChatMember,
  ChatMessage,
  ChatRow,
  ChatSearchHit,
  ChatSource,
} from "./types";

export const PAGE = 50;

const rpc = async <T>(fn: string, args?: Record<string, unknown>) =>
  unwrap<T>(supabase.rpc(fn, args));

// ---- Список и счётчики -----------------------------------------------------

export const chatListQuery = queryOptions({
  queryKey: ["chat_list"],
  queryFn: async () =>
    ((await rpc<ChatRow[] | null>("chat_list")) ?? []).map((c) => ({
      ...c,
      // bigint из базы — числами (сравнения seq).
      last_seq: Number(c.last_seq),
      last_read_seq: Number(c.last_read_seq),
      member_count: Number(c.member_count),
    })),
  meta: { errorMessage: "Не удалось загрузить чаты" },
});

export function useChatList() {
  const live = useRealtimeConnected();
  return useQuery({ ...chatListQuery, refetchInterval: live ? 60_000 : 10_000 });
}

export type ChatUnread = { chats: number; muted: number };

export function useChatUnread(enabled = true): ChatUnread {
  const live = useRealtimeConnected();
  const { data } = useQuery({
    queryKey: ["chat_unread"],
    queryFn: async () =>
      (await rpc<ChatUnread | null>("chat_unread_summary")) ?? { chats: 0, muted: 0 },
    refetchInterval: live ? 60_000 : 15_000,
    refetchOnWindowFocus: true,
    enabled,
  });
  return data ?? { chats: 0, muted: 0 };
}

export const chatFoldersQuery = queryOptions({
  queryKey: ["chat_folders"],
  queryFn: async () => (await rpc<ChatFolder[] | null>("chat_folders_list")) ?? [],
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить папки" },
});

export function chatMembersQuery(chatId: string) {
  return queryOptions({
    queryKey: ["chat_members", chatId],
    queryFn: async () =>
      (await rpc<ChatMember[] | null>("chat_members_list", { p_chat: chatId })) ?? [],
    staleTime: 30_000,
  });
}

export function chatPinnedQuery(chatId: string) {
  return queryOptions({
    queryKey: ["chat_pinned", chatId],
    queryFn: async () =>
      ((await rpc<ChatMessage[] | null>("chat_pinned", { p_chat: chatId })) ?? []).map(normalize),
    staleTime: 60_000,
  });
}

// ---- Переписка ---------------------------------------------------------------

export type ChatWindow = {
  messages: ChatMessage[];
  /** Есть сообщения старше первого загруженного. */
  hasOlder: boolean;
  /** Есть сообщения новее последнего загруженного (окно открыто «вокруг»). */
  hasNewer: boolean;
};

const normalize = (m: ChatMessage): ChatMessage => ({
  ...m,
  seq: Number(m.seq),
  attachments: m.attachments ?? [],
  reactions: m.reactions ?? [],
  mentions: m.mentions ?? [],
  reply: m.reply ? { ...m.reply, seq: Number(m.reply.seq) } : null,
  forward: m.forward ? { ...m.forward, seq: Number(m.forward.seq) } : null,
});

async function fetchPage(
  chatId: string,
  args: { before?: number; after?: number; around?: number },
) {
  const rows = await rpc<ChatMessage[] | null>("chat_messages_page", {
    p_chat: chatId,
    p_before: args.before ?? null,
    p_after: args.after ?? null,
    p_around: args.around ?? null,
    p_limit: PAGE,
  });
  return (rows ?? []).map(normalize);
}

export const messagesKey = (chatId: string) => ["chat_messages", chatId] as const;

/** Первое окно: последние сообщения или вокруг нужного seq. */
export function chatWindowQuery(chatId: string, around: number | null) {
  return queryOptions({
    queryKey: messagesKey(chatId),
    queryFn: async (): Promise<ChatWindow> => {
      const messages = await fetchPage(chatId, around ? { around } : {});
      const hasNewer = around
        ? (await fetchPage(chatId, { after: messages.at(-1)?.seq ?? 0 })).length > 0
        : false;
      return { messages, hasOlder: messages.length > 0 && messages[0].seq > 1, hasNewer };
    },
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
}

function merge(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(list.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Старше первого загруженного. Возвращает, сколько пришло. */
export async function loadOlder(qc: QueryClient, chatId: string): Promise<number> {
  const win = qc.getQueryData<ChatWindow>(messagesKey(chatId));
  const first = win?.messages[0]?.seq;
  if (!win || !first || !win.hasOlder) return 0;
  const older = await fetchPage(chatId, { before: first });
  qc.setQueryData<ChatWindow>(messagesKey(chatId), (w) =>
    w
      ? {
          ...w,
          messages: merge(w.messages, older),
          hasOlder: older.length === PAGE && older[0].seq > 1,
        }
      : w,
  );
  return older.length;
}

/** Новее последнего загруженного (событие или опрос). */
export async function loadNewer(qc: QueryClient, chatId: string): Promise<number> {
  const win = qc.getQueryData<ChatWindow>(messagesKey(chatId));
  if (!win) return 0;
  const lastSeq = win.messages.filter((m) => !m.id.startsWith("local:")).at(-1)?.seq ?? 0;
  let total = 0;
  let after = lastSeq;
  // Несколько страниц подряд, пока окно открыто «вокруг» старого сообщения.
  for (let i = 0; i < 20; i++) {
    const newer = await fetchPage(chatId, { after });
    if (newer.length === 0) break;
    total += newer.length;
    after = newer.at(-1)!.seq;
    qc.setQueryData<ChatWindow>(messagesKey(chatId), (w) =>
      w ? { ...w, messages: dropSent(merge(w.messages, newer), newer) } : w,
    );
    if (newer.length < PAGE) break;
  }
  qc.setQueryData<ChatWindow>(messagesKey(chatId), (w) => (w ? { ...w, hasNewer: false } : w));
  return total;
}

/** Обновить одно сообщение (правка, реакция, удаление, закреп). */
export async function refreshMessage(qc: QueryClient, chatId: string, seq: number) {
  const win = qc.getQueryData<ChatWindow>(messagesKey(chatId));
  if (!win || !win.messages.some((m) => m.seq === seq)) return;
  const [m] = await fetchPage(chatId, { after: seq - 1 });
  if (m && m.seq === seq) putMessage(qc, m);
}

/** Окно целиком заново (опрос без Realtime: правки и реакции). */
export async function refreshWindowTail(qc: QueryClient, chatId: string) {
  const win = qc.getQueryData<ChatWindow>(messagesKey(chatId));
  if (!win || win.messages.length === 0) return;
  const tail = await fetchPage(chatId, {});
  qc.setQueryData<ChatWindow>(messagesKey(chatId), (w) =>
    w ? { ...w, messages: dropSent(merge(w.messages, tail), tail) } : w,
  );
}

export function putMessage(qc: QueryClient, m: ChatMessage) {
  qc.setQueryData<ChatWindow>(messagesKey(m.chat_id), (w) =>
    w ? { ...w, messages: dropSent(merge(w.messages, [m]), [m]) } : w,
  );
}

// ---- Отправка с черновым сообщением -------------------------------------------

/** Сообщение, ещё не принятое базой: id «local:<client_id>». */
export type LocalMessage = ChatMessage & { local: "sending" | "failed"; clientId: string };

export const isLocal = (m: ChatMessage): m is LocalMessage => m.id.startsWith("local:");

/** Принятые сообщения вытесняют свои черновики (по client_id). */
function dropSent(list: ChatMessage[], sent: ChatMessage[]): ChatMessage[] {
  const ids = new Set(sent.map((m) => m.client_id).filter(Boolean));
  if (ids.size === 0) return list;
  return list.filter((m) => !(isLocal(m) && ids.has(m.clientId)));
}

export type SendInput = {
  chatId: string;
  content: ChatDoc | null;
  text: string;
  replyTo: ChatMessage | null;
  attachments: ChatMessage["attachments"];
  authorId: string;
};

function localSeq(win: ChatWindow | undefined) {
  return (win?.messages.at(-1)?.seq ?? 0) + 0.001;
}

export async function sendMessage(
  qc: QueryClient,
  input: SendInput,
  clientId: string = crypto.randomUUID(),
) {
  const key = messagesKey(input.chatId);
  const local: LocalMessage = {
    id: `local:${clientId}`,
    clientId,
    local: "sending",
    chat_id: input.chatId,
    seq: localSeq(qc.getQueryData<ChatWindow>(key)),
    author_id: input.authorId,
    kind: "text",
    content: input.content,
    text: input.text,
    attachments: input.attachments,
    mentions: [],
    mention_all: false,
    forward: null,
    reply: input.replyTo
      ? {
          seq: input.replyTo.seq,
          author_id: input.replyTo.author_id,
          text: input.replyTo.text.slice(0, 200),
          files: input.replyTo.attachments.length,
          deleted: false,
        }
      : null,
    reactions: [],
    pinned: false,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted: false,
  };
  qc.setQueryData<ChatWindow>(key, (w) =>
    w
      ? { ...w, messages: [...w.messages.filter((m) => m.id !== local.id), local] }
      : { messages: [local], hasOlder: false, hasNewer: false },
  );
  try {
    const sent = normalize(
      await rpc<ChatMessage>("chat_send", {
        p_chat: input.chatId,
        p_content: input.content,
        p_text: input.text,
        p_reply_to: input.replyTo?.seq ?? null,
        p_attachments: input.attachments,
        p_client_id: clientId,
      }),
    );
    qc.setQueryData<ChatWindow>(key, (w) =>
      w
        ? {
            ...w,
            messages: merge(
              w.messages.filter((m) => m.id !== local.id),
              [sent],
            ),
          }
        : w,
    );
    void qc.invalidateQueries({ queryKey: ["chat_list"] });
    return sent;
  } catch (e) {
    qc.setQueryData<ChatWindow>(key, (w) =>
      w
        ? {
            ...w,
            messages: w.messages.map((m) =>
              m.id === local.id ? ({ ...local, local: "failed" } as LocalMessage) : m,
            ),
          }
        : w,
    );
    throw e;
  }
}

/** Повторить неотправленное (тот же client_id — база не задвоит). */
export function retryMessage(qc: QueryClient, m: LocalMessage, authorId: string) {
  return sendMessage(
    qc,
    {
      chatId: m.chat_id,
      content: m.content as ChatDoc | null,
      text: m.text,
      replyTo: null,
      attachments: m.attachments,
      authorId,
    },
    m.clientId,
  );
}

export function dropLocal(qc: QueryClient, m: LocalMessage) {
  qc.setQueryData<ChatWindow>(messagesKey(m.chat_id), (w) =>
    w ? { ...w, messages: w.messages.filter((x) => x.id !== m.id) } : w,
  );
}

// ---- Прочие действия ------------------------------------------------------------

export async function editMessage(qc: QueryClient, id: string, content: ChatDoc, text: string) {
  putMessage(
    qc,
    normalize(
      await rpc<ChatMessage>("chat_edit", { p_message: id, p_content: content, p_text: text }),
    ),
  );
}

export async function deleteMessage(qc: QueryClient, m: ChatMessage) {
  await rpc("chat_delete_message", { p_message: m.id });
  await refreshMessage(qc, m.chat_id, m.seq);
  void qc.invalidateQueries({ queryKey: ["chat_list"] });
  void qc.invalidateQueries({ queryKey: ["chat_pinned", m.chat_id] });
}

export async function toggleReaction(qc: QueryClient, m: ChatMessage, emoji: string, me: string) {
  const had = m.reactions.find((r) => r.emoji === emoji)?.mine ?? false;
  // Сразу на экране, ответ базы — поправит.
  const reactions = had
    ? m.reactions
        .map((r) =>
          r.emoji === emoji
            ? { ...r, count: r.count - 1, mine: false, users: r.users.filter((u) => u !== me) }
            : r,
        )
        .filter((r) => r.count > 0)
    : m.reactions.some((r) => r.emoji === emoji)
      ? m.reactions.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, mine: true, users: [...r.users, me] } : r,
        )
      : [...m.reactions, { emoji, count: 1, mine: true, users: [me] }];
  putMessage(qc, { ...m, reactions });
  try {
    putMessage(
      qc,
      normalize(
        await rpc<ChatMessage>("chat_react", { p_message: m.id, p_emoji: emoji, p_on: !had }),
      ),
    );
  } catch (e) {
    putMessage(qc, m);
    throw e;
  }
}

export async function pinMessage(qc: QueryClient, m: ChatMessage, on: boolean) {
  await rpc("chat_pin", { p_message: m.id, p_on: on });
  await refreshMessage(qc, m.chat_id, m.seq);
  await qc.invalidateQueries({ queryKey: ["chat_pinned", m.chat_id] });
}

/** Прочитано до seq (не назад). Список и счётчики — сразу. */
export async function markRead(qc: QueryClient, chatId: string, seq: number) {
  const list = qc.getQueryData<ChatRow[]>(chatListQuery.queryKey);
  const row = list?.find((c) => c.id === chatId);
  if (row && row.last_read_seq >= seq) return;
  qc.setQueryData<ChatRow[]>(chatListQuery.queryKey, (rows) =>
    rows?.map((c) =>
      c.id === chatId
        ? {
            ...c,
            last_read_seq: Math.max(c.last_read_seq, seq),
            unread: seq >= c.last_seq ? 0 : c.unread,
            mentions: seq >= c.last_seq ? 0 : c.mentions,
          }
        : c,
    ),
  );
  await rpc("chat_mark_read", { p_chat: chatId, p_seq: seq });
  void qc.invalidateQueries({ queryKey: ["chat_unread"] });
  void qc.invalidateQueries({ queryKey: ["notif_items"] });
}

export async function markAllRead(qc: QueryClient, chatIds: string[]) {
  await rpc("chat_mark_all_read", { p_chats: chatIds });
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["chat_list"] }),
    qc.invalidateQueries({ queryKey: ["chat_unread"] }),
    qc.invalidateQueries({ queryKey: ["notif_items"] }),
  ]);
}

export const openDirect = (userId: string) => rpc<string>("chat_open_direct", { p_user: userId });
export const openSelf = () => rpc<string>("chat_open_self");
export const createGroup = (title: string, members: string[], description?: string) =>
  rpc<string>("chat_create_group", {
    p_title: title,
    p_members: members,
    p_description: description ?? null,
  });

// ---- Каналы и состав из оргструктуры (2026-11-08_zzzzz_chat_channels.sql) ----------

/** Что человек может привязать: всю компанию (announce) и эти подразделения. */
export const chatSourceOptionsQuery = queryOptions({
  queryKey: ["chat_source_options"],
  queryFn: () => rpc<{ announce: boolean; units: string[] }>("chat_source_options"),
  staleTime: 5 * 60_000,
});

/** Можно ли человеку привязывать состав: вся компания или хоть одно подразделение. */
export function useSourceOptions() {
  const { data } = useQuery(chatSourceOptionsQuery);
  return {
    announce: !!data?.announce,
    units: data?.units ?? [],
    any: !!data?.announce || (data?.units.length ?? 0) > 0,
  };
}

export const chatSourcesQuery = (chatId: string) =>
  queryOptions({
    queryKey: ["chat_sources", chatId],
    queryFn: () =>
      rpc<{ sources: ChatSource[]; can_edit: boolean }>("chat_sources_get", { p_chat: chatId }),
    staleTime: 30_000,
  });

export const createChatEx = (p: {
  title: string;
  description?: string;
  channel?: boolean;
  members: string[];
  sources: ChatSource[];
}) => rpc<string>("chat_create_ex", { p });

export async function saveChatSources(qc: QueryClient, chatId: string, sources: ChatSource[]) {
  await rpc("chat_sources_save", { p_chat: chatId, p_sources: sources });
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["chat_sources", chatId] }),
    qc.invalidateQueries({ queryKey: ["chat_members", chatId] }),
    qc.invalidateQueries({ queryKey: ["chat_list"] }),
  ]);
}

/** «Прочитал» у поста канала — сразу в переписке. */
export async function ackMessage(qc: QueryClient, m: ChatMessage) {
  putMessage(qc, normalize(await rpc<ChatMessage>("chat_ack", { p_message: m.id })));
  void qc.invalidateQueries({ queryKey: ["chat_list"] });
  void qc.invalidateQueries({ queryKey: ["chat_unread"] });
}

export type AckList = {
  acked: { user_id: string; at: string }[];
  pending: string[];
  reminded_at: string | null;
};

export const ackListQuery = (messageId: string) =>
  queryOptions({
    queryKey: ["chat_acks", messageId],
    queryFn: () => rpc<AckList>("chat_ack_list", { p_message: messageId }),
  });

export const remindAck = (messageId: string) =>
  rpc<number>("chat_ack_remind", { p_message: messageId });

export async function searchMessages(query: string, chatId?: string) {
  return (
    (await rpc<ChatSearchHit[] | null>("chat_search", {
      p_query: query,
      p_chat: chatId ?? null,
      p_limit: 50,
    })) ?? []
  ).map((h) => ({ ...h, seq: Number(h.seq) }));
}

export { rpc as chatRpc };

/** Ошибки базы — по-русски. */
export function chatErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    chat_forbidden: "Нет доступа к этому чату",
    chat_message_empty: "Пустое сообщение",
    chat_message_too_long: "Сообщение слишком длинное",
    chat_post_admins_only: "В этой группе пишут только администраторы",
    chat_admin_only: "Это могут только администраторы группы",
    chat_owner_only: "Это может только владелец группы",
    chat_edit_forbidden: "Изменить можно только своё сообщение",
    chat_delete_forbidden: "Удалить это сообщение нельзя",
    chat_title_invalid: "Название — от 1 до 100 символов",
    chat_user_unknown: "Этого человека нет на портале",
    chat_file_invalid: "Файл не подходит",
    chat_too_many_files: "Не больше 20 файлов в сообщении",
    chat_too_many_folders: "Не больше 20 папок",
    chat_folder_title_invalid: "Название папки — до 40 символов",
    chat_too_many_reactions: "Слишком много разных реакций",
    chat_auto_member:
      "Этот участник — из подразделения или «всей компании»: состав меняется в оргструктуре",
    chat_sources_forbidden: "Привязать можно только свои подразделения (вся компания — по праву)",
    chat_sources_invalid: "Проверьте состав из оргструктуры",
    chat_ack_remind_soon: "Напоминать можно не чаще раза в час",
    chat_ack_not_needed: "У этого сообщения нет отметки «Прочитал»",
  };
  for (const [k, v] of Object.entries(map)) if (msg.includes(k)) return v;
  return msg;
}
