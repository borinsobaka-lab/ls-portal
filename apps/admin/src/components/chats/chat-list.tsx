/**
 * Список чатов (TASKS_CHATS_PLAN.md, 3.3): поиск сверху — сразу по
 * названиям чатов, людям и словам во всех моих чатах (бриф 2.18, Д.1 —
 * главная боль), «Новый» (личный чат или группа), строки — закреплённые
 * первыми, затем по последнему сообщению; у строки — превью, время,
 * непрочитанные (без звука — серым), «@» при упоминании. Меню строки —
 * правой кнопкой: закрепить, звук, прочитать, в папку.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  BellOff,
  Check,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Pin,
  Plus,
  Users,
  Megaphone,
  Building2,
} from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/chats/chat-avatar";
import { NewChatDialog, type NewChatMode } from "@/components/chats/dialogs";
import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  chatMatches,
  chatTime,
  chatTitle,
  snippetParts,
  systemText,
  unreadLabel,
} from "@/lib/chats/content";
import {
  chatErrorText,
  chatFoldersQuery,
  chatRpc,
  markAllRead,
  openDirect,
  searchMessages,
  useChatList,
  useSourceOptions,
} from "@/lib/chats/data";
import { shortName, usePeople } from "@/lib/chats/people";
import { folderFilter, type FolderKey } from "@/lib/chats/folders";
import type { ChatRow } from "@/lib/chats/types";
import { isOnline, matchPerson } from "@/lib/company";
import { cn } from "@/lib/utils";
import { BugReportButton } from "@/components/bug-report";

const isMuted = (c: ChatRow) =>
  c.notify === "none" || (!!c.muted_until && new Date(c.muted_until) > new Date());

export function ChatList({
  activeId,
  folder,
  me,
  onOpen,
}: {
  activeId: string | null;
  folder: FolderKey;
  me: string;
  onOpen: (chatId: string, seq?: number) => void;
}) {
  const qc = useQueryClient();
  const { data: chats = [], isPending } = useChatList();
  const { data: folders = [] } = useQuery(chatFoldersQuery);
  const { name, people } = usePeople();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<NewChatMode | null>(null);
  const sourceOpts = useSourceOptions();
  const query = useDebouncedValue(q.trim(), 300);
  const searching = q.trim().length > 0;

  const titled = useMemo(
    () => chats.map((c) => ({ chat: c, title: chatTitle(c, name) })),
    [chats, name],
  );
  const visible = useMemo(() => {
    const keep = folderFilter(folder, folders);
    return titled.filter(({ chat }) => keep(chat));
  }, [titled, folder, folders]);

  const foundChats = searching ? titled.filter(({ title }) => chatMatches(title, q)) : [];
  const directPeers = new Set(chats.filter((c) => c.kind === "direct").map((c) => c.peer_id));
  const foundPeople = searching
    ? people
        .filter((p) => p.user_id !== me && !directPeers.has(p.user_id) && matchPerson(p, q))
        .slice(0, 8)
    : [];
  const messages = useQuery({
    queryKey: ["chat_search", "all", query],
    queryFn: () => searchMessages(query),
    enabled: query.length >= 2,
  });

  const openPerson = async (id: string) => {
    try {
      const chatId = await openDirect(id);
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      setQ("");
      onOpen(chatId);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const action = async (fn: string, args: Record<string, unknown>) => {
    try {
      await chatRpc(fn, args);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["chat_list"] }),
        qc.invalidateQueries({ queryKey: ["chat_folders"] }),
        qc.invalidateQueries({ queryKey: ["chat_unread"] }),
      ]);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const renderRow = ({ chat, title }: { chat: ChatRow; title: string }) => {
    const last = chat.last_message;
    const lastMine = last?.author_id === me;
    const preview = !last
      ? chat.kind === "self"
        ? "Заметки для себя"
        : "Нет сообщений"
      : last.kind === "system"
        ? systemText(last.system, last.author_id, (id) => name(id))
        : last.deleted
          ? "Сообщение удалено"
          : last.text;
    const who =
      last && last.kind !== "system" && !last.deleted
        ? lastMine
          ? "Вы: "
          : chat.kind === "group" || chat.kind === "task" || chat.kind === "project"
            ? `${shortName(name(last.author_id))}: `
            : ""
        : "";
    const muted = isMuted(chat);
    return (
      <ContextMenu key={chat.id}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onOpen(chat.id)}
            className={cn(
              "chat-touch-menu flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
              chat.id === activeId ? "bg-selected/8" : "hover:bg-muted",
            )}
          >
            <ChatAvatar chat={chat} title={title} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                {chat.kind === "group" &&
                  (chat.settings?.channel ? (
                    <Megaphone className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : chat.settings?.auto ? (
                    <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Users className="size-3.5 shrink-0 text-muted-foreground" />
                  ))}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    chat.unread ? "font-semibold" : "font-medium",
                  )}
                >
                  {title}
                </span>
                {muted && <BellOff className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {chatTime(chat.last_message_at ?? chat.created_at)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {who}
                  {preview}
                </span>
                {chat.pinned_at && !chat.unread && (
                  <Pin className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                {chat.mentions > 0 && (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-selected-foreground">
                    <AtSign className="size-3" />
                  </span>
                )}
                {chat.unread > 0 && (
                  <span
                    className={cn(
                      "min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-semibold text-white",
                      muted ? "bg-muted-foreground" : "bg-destructive",
                    )}
                  >
                    {unreadLabel(chat.unread)}
                  </span>
                )}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            onSelect={() =>
              void action("chat_set_pinned", { p_chat: chat.id, p_on: !chat.pinned_at })
            }
          >
            {chat.pinned_at ? "Открепить" : "Закрепить наверху"}
          </ContextMenuItem>
          {chat.kind !== "self" && (
            <ContextMenuItem
              onSelect={() =>
                void action("chat_set_notify", {
                  p_chat: chat.id,
                  p_notify: muted ? "all" : "mentions",
                  p_muted_until: null,
                })
              }
            >
              {muted ? "Включить уведомления" : "Без звука (кроме упоминаний)"}
            </ContextMenuItem>
          )}
          {chat.unread > 0 && (
            <ContextMenuItem onSelect={() => void markAllRead(qc, [chat.id])}>
              Отметить прочитанным
            </ContextMenuItem>
          )}
          {folders.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>В папку</ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-48">
                  {folders.map((f) => {
                    const inside = f.chat_ids.includes(chat.id);
                    return (
                      <ContextMenuItem
                        key={f.id}
                        className="gap-2"
                        onSelect={() =>
                          void action("chat_folder_save", {
                            p_id: f.id,
                            p_title: f.title,
                            p_chat_ids: inside
                              ? f.chat_ids.filter((x) => x !== chat.id)
                              : [...f.chat_ids, chat.id],
                          })
                        }
                      >
                        <span className="w-4">{inside && <Check className="size-4" />}</span>
                        {f.title}
                      </ContextMenuItem>
                    );
                  })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2 md:h-16 md:px-3 md:py-0">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Чаты, люди, слова в сообщениях"
          wrapperClassName="flex-1"
          aria-label="Поиск по чатам"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="icon"
              className="rounded-full bg-selected text-selected-foreground hover:bg-selected/90"
              aria-label="Новый чат"
              title="Новый чат"
            >
              <Plus />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm hover:bg-muted"
              onClick={() => setCreating("direct")}
            >
              <MessageSquarePlus className="size-4" /> Личный чат
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm hover:bg-muted"
              onClick={() => setCreating("group")}
            >
              <Users className="size-4" /> Группа
            </button>
            {sourceOpts.any && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm hover:bg-muted"
                onClick={() => setCreating("unit")}
              >
                <Building2 className="size-4" /> Чат подразделения
              </button>
            )}
            {sourceOpts.announce && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm hover:bg-muted"
                onClick={() => setCreating("channel")}
              >
                <Megaphone className="size-4" /> Канал
              </button>
            )}
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm hover:bg-muted"
              onClick={() =>
                void chatRpc<string>("chat_open_self").then(async (id) => {
                  await qc.invalidateQueries({ queryKey: ["chat_list"] });
                  onOpen(id);
                })
              }
            >
              <FolderPlus className="size-4" /> Избранное
            </button>
          </PopoverContent>
        </Popover>
        {/* На десктопе шапки портала у чатов нет — кнопка здесь. */}
        <BugReportButton variant="header" className="max-md:hidden" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {searching ? (
          <div className="space-y-3">
            {foundChats.length > 0 && (
              <section>
                <h3 className="px-2.5 pt-1 pb-1 text-xs font-semibold text-muted-foreground">
                  Чаты
                </h3>
                {foundChats.slice(0, 10).map(renderRow)}
              </section>
            )}
            {foundPeople.length > 0 && (
              <section>
                <h3 className="px-2.5 pt-1 pb-1 text-xs font-semibold text-muted-foreground">
                  Люди
                </h3>
                {foundPeople.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onClick={() => void openPerson(p.user_id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
                  >
                    <span className="relative">
                      <StaffAvatar
                        value={p.avatar_url}
                        name={p.full_name}
                        className="size-11 text-sm"
                      />
                      {isOnline(p.last_seen_at) && (
                        <span className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-background" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.full_name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {[p.position_name, p.units[0]?.name, p.cities[0]]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                ))}
              </section>
            )}
            <section>
              <h3 className="px-2.5 pt-1 pb-1 text-xs font-semibold text-muted-foreground">
                Сообщения
              </h3>
              {query.length < 2 ? (
                <p className="px-2.5 py-2 text-sm text-muted-foreground">
                  Наберите хотя бы 2 буквы
                </p>
              ) : messages.isFetching && !messages.data ? (
                <Loader2 className="mx-auto my-3 size-4 animate-spin text-muted-foreground" />
              ) : (messages.data ?? []).length === 0 ? (
                <p className="px-2.5 py-2 text-sm text-muted-foreground">Не нашли в сообщениях</p>
              ) : (
                (messages.data ?? []).map((h) => {
                  const chat = chats.find((c) => c.id === h.chat_id);
                  if (!chat) return null;
                  const title = chatTitle(chat, name);
                  return (
                    <button
                      key={h.message_id}
                      type="button"
                      onClick={() => onOpen(h.chat_id, h.seq)}
                      className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
                    >
                      <ChatAvatar chat={chat} title={title} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="flex gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {title}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {chatTime(h.created_at)}
                          </span>
                        </span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">
                          {chat.kind === "group" && (
                            <span className="text-foreground">
                              {shortName(name(h.author_id))}:{" "}
                            </span>
                          )}
                          {snippetParts(h.snippet).map((p, i) =>
                            p.hit ? (
                              <mark
                                key={i}
                                className="rounded bg-amber-200/70 px-0.5 text-foreground"
                              >
                                {p.text}
                              </mark>
                            ) : (
                              <span key={i}>{p.text}</span>
                            ),
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </section>
          </div>
        ) : isPending ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {chats.length === 0 ? (
              <>
                Чатов пока нет.
                <br />
                <Button variant="outline" className="mt-3" onClick={() => setCreating("direct")}>
                  <MessageSquarePlus /> Написать коллеге
                </Button>
              </>
            ) : (
              "В этой папке чатов нет"
            )}
          </div>
        ) : (
          visible.map(renderRow)
        )}
      </div>
      <NewChatDialog
        mode={creating}
        onClose={() => setCreating(null)}
        onOpened={(id) => onOpen(id)}
      />
    </div>
  );
}
