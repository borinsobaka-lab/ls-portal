/**
 * Меню раздела «Чаты» в боковой панели — папки (бриф 2.6, боль № 27):
 * «Все чаты», «Личные», «Группы» и свои папки с числом чатов с
 * непрочитанным; правой кнопкой — «Прочитать всё» (Д.3), у своей —
 * «Изменить» и «Удалить»; внизу — «Новая папка». Папка — в адресе `?f=`.
 */
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FolderDialog } from "@/components/chats/dialogs";
import { useConfirm } from "@/components/confirm-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AddFolder,
  Calendar,
  ChatRoundDots,
  ClipboardCheck,
  Folder,
  FolderOpen,
  User,
  UserSpeakRounded,
  UsersGroupRounded,
} from "@/components/nav-icons";
import {
  SidebarNavButton,
  SidebarNavContent,
  SidebarNavGroup,
  SIDEBAR_NAV_LINK_CLASS,
} from "@/components/sidebar-nav";
import { SidebarContent, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  chatErrorText,
  chatFoldersQuery,
  chatRpc,
  markAllRead,
  useChatList,
} from "@/lib/chats/data";
import {
  folderFilter,
  folderUnread,
  isChannel,
  SYSTEM_FOLDERS,
  type FolderKey,
} from "@/lib/chats/folders";
import type { ChatFolder } from "@/lib/chats/types";

// Иконки — Solar, как во всех меню второго уровня (`sidebar-nav.tsx`).
const ICONS = {
  all: ChatRoundDots,
  direct: User,
  channel: UserSpeakRounded,
  group: UsersGroupRounded,
  project: FolderOpen,
  event: Calendar,
  task: ClipboardCheck,
} as const;

export function ChatFoldersMenu({ onNavigate }: { onNavigate?: () => void }) {
  const qc = useQueryClient();
  const { data: chats = [] } = useChatList();
  const { data: folders = [] } = useQuery(chatFoldersQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<ChatFolder> | null>(null);
  const location = useRouterState({ select: (s) => s.location });
  const current = ((location.search as { f?: string }).f ?? "all") as FolderKey;
  const chatPath = location.pathname.startsWith("/chats/") ? location.pathname : "/chats";

  // «Задачи» — когда есть хоть одно обсуждение задачи.
  const hasTaskChats = chats.some((c) => c.kind === "task");
  const hasProjectChats = chats.some((c) => c.kind === "project");
  const hasEventChats = chats.some((c) => c.kind === "event");
  const hasChannels = chats.some(isChannel);
  const items: { key: FolderKey; title: string; folder?: ChatFolder }[] = [
    ...SYSTEM_FOLDERS.filter(
      (f) =>
        (f.key !== "task" || hasTaskChats || current === "task") &&
        (f.key !== "project" || hasProjectChats || current === "project") &&
        (f.key !== "event" || hasEventChats || current === "event") &&
        (f.key !== "channel" || hasChannels || current === "channel"),
    ),
    ...folders.map((f) => ({ key: f.id, title: f.title, folder: f })),
  ];

  const readAll = (key: FolderKey) => {
    const ids = chats.filter(folderFilter(key, folders)).map((c) => c.id);
    void markAllRead(qc, ids).catch((e) => toast.error(chatErrorText(e)));
  };

  const remove = async (f: ChatFolder) => {
    const ok = await confirm({
      title: `Удалить папку «${f.title}»?`,
      description: "Чаты останутся — пропадёт только папка.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    try {
      await chatRpc("chat_folder_delete", { p_id: f.id });
      await qc.invalidateQueries({ queryKey: ["chat_folders"] });
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  return (
    <SidebarContent aria-label="Папки чатов" className="sidebar-scroll gap-1">
      <SidebarNavGroup id="chats-folders" label="Папки">
        {items.map((it) => {
          const unread = folderUnread(chats, folderFilter(it.key, folders));
          const icon = ICONS[it.key as keyof typeof ICONS] ?? Folder;
          const active = current === it.key;
          return (
            <ContextMenu key={it.key}>
              <ContextMenuTrigger asChild>
                <SidebarMenuItem>
                  <SidebarNavButton active={active}>
                    <Link
                      to={chatPath}
                      search={it.key === "all" ? {} : { f: it.key }}
                      onClick={onNavigate}
                      className={SIDEBAR_NAV_LINK_CLASS}
                    >
                      <SidebarNavContent
                        icon={icon}
                        active={active}
                        title={it.title}
                        badge={unread}
                      />
                    </Link>
                  </SidebarNavButton>
                </SidebarMenuItem>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => readAll(it.key)}>Прочитать всё</ContextMenuItem>
                {it.folder && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => setEditing(it.folder!)}>
                      Изменить
                    </ContextMenuItem>
                    <ContextMenuItem
                      className="text-destructive"
                      onSelect={() => void remove(it.folder!)}
                    >
                      Удалить папку
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        <SidebarMenuItem>
          <SidebarNavButton active={false} className="text-white/70">
            <button type="button" onClick={() => setEditing({})}>
              <SidebarNavContent icon={AddFolder} active={false} title="Новая папка" />
            </button>
          </SidebarNavButton>
        </SidebarMenuItem>
      </SidebarNavGroup>
      <FolderDialog folder={editing} onClose={() => setEditing(null)} />
      {confirmDialog}
    </SidebarContent>
  );
}
