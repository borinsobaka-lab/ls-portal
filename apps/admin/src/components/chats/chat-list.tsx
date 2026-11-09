/**
 * Список чатов (TASKS_CHATS_PLAN.md, 3.3; UI_REVIEW_CHATS_TASKS_CALENDAR.md,
 * 3.1): поиск сверху — сразу по названиям чатов, людям и словам во всех моих
 * чатах (бриф 2.18, Д.1), «+» (написать сотруднику, группа, чат
 * подразделения, канал — с пояснениями), под ним — папки строкой чипов (как
 * вкладки папок в Telegram; те же папки — в меню раздела). Первой строкой —
 * «Избранное» (заводится при первом открытии), дальше закреплённые и по
 * последнему сообщению; у строки — превью, время, счётчик цветом акцента
 * (без звука — серым), «@» при упоминании. Действия строки — «⋯» (при
 * наведении, на сенсорном экране — всегда) и то же правой кнопкой /
 * долгим нажатием: закрепить, без звука, прочитать, в папку.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  BellOff,
  Building2,
  CheckCheck,
  FolderInput,
  FolderPlus,
  Loader2,
  Megaphone,
  MessageSquarePlus,
  Pin,
  PinOff,
  Plus,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { ChatContextMenu, ChatMoreMenu, type ChatMenuItem } from "@/components/chats/action-menu";
import { ChatAvatar } from "@/components/chats/chat-avatar";
import { FolderDialog, NewChatDialog, type NewChatMode } from "@/components/chats/dialogs";
import { StaffAvatar } from "@/components/employee-photo";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  chatMatches,
  chatTime,
  chatTitle,
  isMuted,
  muteLabel,
  previewOf,
  snippetParts,
  systemText,
  unreadLabel,
} from "@/lib/chats/content";
import {
  chatErrorText,
  chatFoldersQuery,
  chatRpc,
  markAllRead,
  messagesKey,
  openDirect,
  openSelf,
  searchMessages,
  useChatList,
  useSourceOptions,
  type ChatWindow,
} from "@/lib/chats/data";
import { useFolderItems } from "@/lib/chats/folder-items";
import { FOLDER_HINT, folderFilter, type FolderKey } from "@/lib/chats/folders";
import { muteMenuItem } from "@/lib/chats/mute-menu";
import { shortName, usePeople } from "@/lib/chats/people";
import { mergeTopics, sortChats } from "@/lib/chats/topics";
import type { ChatFolder, ChatRow } from "@/lib/chats/types";
import { isOnline, matchPerson } from "@/lib/company";
import { cn } from "@/lib/utils";
import { BugReportButton } from "@/components/bug-report";

/** Пункты «+»: что создаём и чем отличается (3.1.4). */
const NEW_ITEMS: {
  mode: NewChatMode;
  label: string;
  hint: string;
  icon: typeof Users;
}[] = [
  {
    mode: "direct",
    label: "Написать сотруднику",
    hint: "Личная переписка один на один",
    icon: MessageSquarePlus,
  },
  { mode: "group", label: "Группа", hint: "Вы выбираете участников", icon: Users },
  {
    mode: "unit",
    label: "Чат подразделения",
    hint: "Все сотрудники отдела, состав обновляется сам",
    icon: Building2,
  },
  {
    mode: "channel",
    label: "Канал",
    hint: "Объявления, пишут только администраторы",
    icon: Megaphone,
  },
];

export function ChatList({
  activeId,
  folder,
  me,
  onOpen,
  onFolder,
}: {
  activeId: string | null;
  folder: FolderKey;
  me: string;
  onOpen: (chatId: string, seq?: number) => void;
  onFolder: (key: FolderKey) => void;
}) {
  const qc = useQueryClient();
  const { data: chats = [], isPending } = useChatList();
  const { data: folders = [] } = useQuery(chatFoldersQuery);
  const { name, people } = usePeople();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<NewChatMode | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Partial<ChatFolder> | null>(null);
  const sourceOpts = useSourceOptions();
  const query = useDebouncedValue(q.trim(), 300);
  const searching = q.trim().length > 0;

  // Темы групп — свёрнуты в строку группы (их список — в открытой группе).
  const titled = useMemo(
    () => sortChats(mergeTopics(chats)).map((c) => ({ chat: c, title: chatTitle(c, name) })),
    [chats, name],
  );
  const selfChat = chats.find((c) => c.kind === "self") ?? null;
  const visible = useMemo(() => {
    const keep = folderFilter(folder, folders);
    return titled.filter(({ chat }) => keep(chat) && chat.kind !== "self");
  }, [titled, folder, folders]);
  // «Избранное» — первой строкой в «Всех» и «Личных» (и в своей папке, если оно там).
  const showSelf = selfChat
    ? folderFilter(folder, folders)(selfChat)
    : folder === "all" || folder === "direct";

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
  const foundMessages = query.length >= 2 ? (messages.data ?? []) : [];
  const messagesLoading = query.length >= 2 && messages.isFetching && !messages.data;
  const nothingFound =
    searching &&
    !messagesLoading &&
    foundChats.length === 0 &&
    foundPeople.length === 0 &&
    foundMessages.length === 0;

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

  const openFavorites = async () => {
    try {
      const id = selfChat?.id ?? (await openSelf());
      if (!selfChat) await qc.invalidateQueries({ queryKey: ["chat_list"] });
      onOpen(id);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const action = async (fn: string, args: Record<string, unknown>, ok?: string) => {
    try {
      await chatRpc(fn, args);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["chat_list"] }),
        qc.invalidateQueries({ queryKey: ["chat_folders"] }),
        qc.invalidateQueries({ queryKey: ["chat_unread"] }),
      ]);
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const rowMenu = (chat: ChatRow): ChatMenuItem[] => {
    const items: ChatMenuItem[] = [
      chat.pinned_at
        ? {
            label: "Открепить чат",
            icon: PinOff,
            onSelect: () =>
              void action("chat_set_pinned", { p_chat: chat.id, p_on: false }, "Чат откреплён"),
          }
        : {
            label: "Закрепить чат",
            icon: Pin,
            onSelect: () =>
              void action(
                "chat_set_pinned",
                { p_chat: chat.id, p_on: true },
                "Чат закреплён наверху списка",
              ),
          },
    ];
    if (chat.kind !== "self") items.push(muteMenuItem(qc, chat));
    if (chat.unread > 0)
      items.push({
        label: "Отметить прочитанным",
        icon: CheckCheck,
        onSelect: () =>
          void markAllRead(qc, [
            chat.id,
            ...chats.filter((t) => t.parent_id === chat.id).map((t) => t.id),
          ]).catch((e) => toast.error(chatErrorText(e))),
      });
    items.push({
      label: "В папку",
      icon: FolderInput,
      separatorBefore: true,
      items: [
        ...folders.map((f) => {
          const inside = f.chat_ids.includes(chat.id);
          return {
            label: f.title,
            checked: inside,
            onSelect: () =>
              void action(
                "chat_folder_save",
                {
                  p_id: f.id,
                  p_title: f.title,
                  p_chat_ids: inside
                    ? f.chat_ids.filter((x) => x !== chat.id)
                    : [...f.chat_ids, chat.id],
                },
                inside ? `Убран из папки «${f.title}»` : `Добавлен в папку «${f.title}»`,
              ),
          };
        }),
        {
          label: "Новая папка…",
          icon: FolderPlus,
          separatorBefore: folders.length > 0,
          onSelect: () => setEditingFolder({ chat_ids: [chat.id] }),
        },
      ],
    });
    return items;
  };

  const renderRow = ({ chat, title }: { chat: ChatRow; title: string }) => {
    const raw = chat.last_message;
    // Последнее удалено — предыдущее из загруженной переписки (3.3.4).
    const last = raw
      ? previewOf(raw, qc.getQueryData<ChatWindow>(messagesKey(chat.id))?.messages)
      : null;
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
          : chat.kind === "group" ||
              chat.kind === "task" ||
              chat.kind === "project" ||
              chat.kind === "event"
            ? `${shortName(name(last.author_id))}: `
            : ""
        : "";
    const muted = isMuted(chat);
    const items = rowMenu(chat);
    return (
      <ChatContextMenu key={chat.id} items={items}>
        <div
          className={cn(
            "chat-touch-menu group/row relative flex items-center rounded-lg transition-colors",
            chat.id === activeId ? "bg-selected/8" : "hover:bg-muted",
          )}
        >
          <button
            type="button"
            onClick={() => onOpen(chat.id)}
            className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left"
          >
            <ChatAvatar chat={chat} title={title} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                {chat.kind === "group" &&
                  (chat.settings?.channel ? (
                    <span className="shrink-0" title="Канал" aria-label="Канал" role="img">
                      <Megaphone className="size-3.5 shrink-0 text-muted-foreground" />
                    </span>
                  ) : chat.settings?.auto ? (
                    <span
                      className="shrink-0"
                      title="Чат подразделения"
                      aria-label="Чат подразделения"
                      role="img"
                    >
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                    </span>
                  ) : (
                    <span className="shrink-0" title="Группа" aria-label="Группа" role="img">
                      <Users className="size-3.5 shrink-0 text-muted-foreground" />
                    </span>
                  ))}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    chat.unread ? "font-semibold" : "font-medium",
                  )}
                >
                  {title}
                </span>
                {muted && (
                  <span
                    className="shrink-0"
                    title={muteLabel(chat)}
                    aria-label={muteLabel(chat)}
                    role="img"
                  >
                    <BellOff className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {chatTime(chat.last_message_at ?? chat.created_at)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {chat.last_topic && (
                    <span className="text-foreground"># {chat.last_topic} · </span>
                  )}
                  {who}
                  {preview}
                </span>
                {chat.pinned_at && !chat.unread && (
                  <span className="shrink-0" title="Закреплён" aria-label="Закреплён" role="img">
                    <Pin className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                )}
                {chat.mentions > 0 && (
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded-full bg-chat-accent text-chat-accent-foreground"
                    title="Вас упомянули"
                    aria-label="Вас упомянули"
                  >
                    <AtSign className="size-3" />
                  </span>
                )}
                {chat.unread > 0 && (
                  <span
                    className={cn(
                      "min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-semibold",
                      muted
                        ? "bg-muted-foreground/70 text-white"
                        : "bg-chat-accent text-chat-accent-foreground",
                    )}
                    title={`Непрочитанных: ${chat.unread}`}
                  >
                    {unreadLabel(chat.unread)}
                  </span>
                )}
              </span>
            </span>
          </button>
          <ChatMoreMenu
            items={items}
            label={`Действия с чатом «${title}»`}
            reveal="row"
            triggerClassName="mr-1 pointer-fine:absolute pointer-fine:top-1 pointer-fine:right-1 pointer-fine:mr-0 pointer-fine:bg-muted"
          />
        </div>
      </ChatContextMenu>
    );
  };

  const favoritesRow = () =>
    selfChat ? (
      renderRow({ chat: selfChat, title: chatTitle(selfChat, name) })
    ) : (
      <button
        key="self"
        type="button"
        onClick={() => void openFavorites()}
        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
      >
        <ChatAvatar chat={{ id: "self", kind: "self", peer_id: null }} title="Избранное" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">Избранное</span>
          <span className="block truncate text-sm text-muted-foreground">
            Заметки и пересланное для себя
          </span>
        </span>
      </button>
    );

  const ownFolder = folders.find((f) => f.id === folder);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2 md:h-16 md:px-3 md:py-0">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Поиск: имя, чат или слова из сообщений"
          wrapperClassName="flex-1"
          aria-label="Поиск по чатам, людям и сообщениям"
        />
        <Popover open={newMenu} onOpenChange={setNewMenu}>
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
          <PopoverContent align="end" className="w-72 p-1">
            {NEW_ITEMS.filter(
              (it) =>
                (it.mode !== "unit" || sourceOpts.any) &&
                (it.mode !== "channel" || sourceOpts.announce),
            ).map((it) => (
              <ListItemButton
                key={it.mode}
                className="items-start py-2"
                onClick={() => {
                  setNewMenu(false);
                  setCreating(it.mode);
                }}
              >
                <it.icon className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-medium">{it.label}</span>
                  <span className="block text-xs text-muted-foreground">{it.hint}</span>
                </span>
              </ListItemButton>
            ))}
          </PopoverContent>
        </Popover>
        {/* На десктопе шапки портала у чатов нет — кнопка здесь, отдельно от «+». */}
        <BugReportButton variant="header" className="ml-1 max-md:hidden" />
      </div>

      {!searching && <ChatFolderChips folder={folder} onFolder={onFolder} />}

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
                        <span
                          className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-background"
                          title="В сети"
                        />
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
            {(foundMessages.length > 0 || messagesLoading) && (
              <section>
                <h3 className="px-2.5 pt-1 pb-1 text-xs font-semibold text-muted-foreground">
                  Сообщения
                </h3>
                {messagesLoading ? (
                  <Loader2 className="mx-auto my-3 size-4 animate-spin text-muted-foreground" />
                ) : (
                  foundMessages.map((h) => {
                    const chat = chats.find((c) => c.id === h.chat_id);
                    if (!chat) return null;
                    const group = chat.parent_id
                      ? chats.find((c) => c.id === chat.parent_id)
                      : null;
                    const title = group
                      ? `${chatTitle(group, name)} › ${chatTitle(chat, name)}`
                      : chatTitle(chat, name);
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
                            {(chat.kind === "group" || chat.kind === "topic") && (
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
            )}
            {nothingFound && (
              <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
                Ничего не найдено
              </p>
            )}
          </div>
        ) : isPending ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {showSelf && favoritesRow()}
            {visible.map(renderRow)}
            {visible.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {chats.filter((c) => c.kind !== "self").length === 0 && folder === "all" ? (
                  <>
                    Чатов пока нет.
                    <br />
                    <Button
                      variant="outline"
                      className="mt-3"
                      onClick={() => setCreating("direct")}
                    >
                      <MessageSquarePlus /> Написать сотруднику
                    </Button>
                  </>
                ) : ownFolder ? (
                  <>
                    В папке «{ownFolder.title}» пока нет чатов.
                    <br />
                    <Button
                      variant="outline"
                      className="mt-3"
                      onClick={() => setEditingFolder(ownFolder)}
                    >
                      <FolderPlus /> Добавить чаты в папку
                    </Button>
                  </>
                ) : (
                  <>
                    Пока пусто.
                    <br />
                    {FOLDER_HINT[folder] ?? ""}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <NewChatDialog
        mode={creating}
        onClose={() => setCreating(null)}
        onOpened={(id) => onOpen(id)}
      />
      <FolderDialog folder={editingFolder} onClose={() => setEditingFolder(null)} />
    </div>
  );
}

/**
 * Папки строкой чипов над списком (UI_REVIEW, 2.3): на всех экранах, на
 * телефоне до папки — одно касание. Правой кнопкой / долгим нажатием —
 * «Отметить всё прочитанным», у своей папки — «Изменить», «Удалить папку».
 */
function ChatFolderChips({
  folder,
  onFolder,
}: {
  folder: FolderKey;
  onFolder: (key: FolderKey) => void;
}) {
  const { items, readAll, removeFolder } = useFolderItems();
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<ChatFolder> | null>(null);
  return (
    <div
      role="tablist"
      aria-label="Папки чатов"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b px-2 py-2 [scrollbar-width:none] md:px-3"
    >
      {items.map((it) => {
        const active = it.key === folder;
        const menu: ChatMenuItem[] = [
          ...(it.unread > 0
            ? [
                {
                  label: "Отметить всё прочитанным",
                  icon: CheckCheck,
                  onSelect: () => readAll(it.key),
                },
              ]
            : []),
          ...(it.folder
            ? [
                { label: "Изменить", onSelect: () => setEditing(it.folder!) },
                {
                  label: "Удалить папку",
                  destructive: true,
                  onSelect: async () => {
                    const f = it.folder!;
                    const ok = await confirm({
                      title: `Удалить папку «${f.title}»?`,
                      description: "Чаты останутся — пропадёт только папка.",
                      confirmLabel: "Удалить папку",
                    });
                    if (ok) await removeFolder(f);
                  },
                },
              ]
            : []),
        ];
        return (
          <ChatContextMenu key={it.key} items={menu}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onFolder(it.key)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-selected text-selected-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {it.title}
              {it.unread > 0 && (
                <span
                  className={cn(
                    "min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold",
                    active
                      ? "bg-selected-foreground text-selected"
                      : "bg-chat-accent text-chat-accent-foreground",
                  )}
                >
                  {unreadLabel(it.unread)}
                </span>
              )}
            </button>
          </ChatContextMenu>
        );
      })}
      <FolderDialog folder={editing} onClose={() => setEditing(null)} />
      {confirmDialog}
    </div>
  );
}
