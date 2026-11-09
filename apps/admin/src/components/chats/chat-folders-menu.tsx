/**
 * Меню раздела «Чаты» в боковой панели — папки (бриф 2.6, боль № 27;
 * UI_REVIEW_CHATS_TASKS_CALENDAR.md, 2.3 и 3.7): системные папки — всегда
 * (пустая объясняет, что сюда попадает), свои папки и «Новая папка». Те же
 * папки — строкой чипов над списком чатов (`ChatFolderChips` в
 * `chat-list.tsx`). У папки — «⋯» (при наведении, на сенсорном экране —
 * всегда) и то же правой кнопкой: «Отметить всё прочитанным», у своей —
 * «Изменить» и «Удалить папку». Папка — в адресе `?f=`.
 */
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { CheckCheck, Pencil, Trash2 } from "lucide-react";

import { ChatContextMenu, ChatMoreMenu, type ChatMenuItem } from "@/components/chats/action-menu";
import { FolderDialog } from "@/components/chats/dialogs";
import { useConfirm } from "@/components/confirm-dialog";
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
import { useFolderItems, type FolderItem } from "@/lib/chats/folder-items";
import { MAX_FOLDERS, type FolderKey } from "@/lib/chats/folders";
import type { ChatFolder } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

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
  const { items, folders, readAll, removeFolder } = useFolderItems();
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<ChatFolder> | null>(null);
  const location = useRouterState({ select: (s) => s.location });
  const current = ((location.search as { f?: string }).f ?? "all") as FolderKey;
  const chatPath = location.pathname.startsWith("/chats/") ? location.pathname : "/chats";

  const remove = async (f: ChatFolder) => {
    const ok = await confirm({
      title: `Удалить папку «${f.title}»?`,
      description: "Чаты останутся — пропадёт только папка.",
      confirmLabel: "Удалить папку",
    });
    if (ok) await removeFolder(f);
  };

  const menu = (it: FolderItem): ChatMenuItem[] => [
    ...(it.unread > 0
      ? [{ label: "Отметить всё прочитанным", icon: CheckCheck, onSelect: () => readAll(it.key) }]
      : []),
    ...(it.folder
      ? [
          { label: "Изменить", icon: Pencil, onSelect: () => setEditing(it.folder!) },
          {
            label: "Удалить папку",
            icon: Trash2,
            destructive: true,
            separatorBefore: it.unread > 0,
            onSelect: () => void remove(it.folder!),
          },
        ]
      : []),
  ];

  return (
    <SidebarContent aria-label="Папки чатов" className="sidebar-scroll gap-1">
      <SidebarNavGroup id="chats-folders" label="Папки">
        {items.map((it) => {
          const icon = ICONS[it.key as keyof typeof ICONS] ?? Folder;
          const active = current === it.key;
          const actions = menu(it);
          return (
            <ChatContextMenu key={it.key} items={actions}>
              <SidebarMenuItem className="group/row">
                <SidebarNavButton active={active}>
                  <Link
                    to={chatPath}
                    search={it.key === "all" ? {} : { f: it.key }}
                    onClick={onNavigate}
                    className={cn(SIDEBAR_NAV_LINK_CLASS, actions.length > 0 && "pr-8")}
                  >
                    <SidebarNavContent
                      icon={icon}
                      active={active}
                      title={it.title}
                      badge={it.unread}
                    />
                  </Link>
                </SidebarNavButton>
                <ChatMoreMenu
                  items={actions}
                  label={`Действия с папкой «${it.title}»`}
                  reveal="row"
                  align="start"
                  triggerClassName="absolute top-0.5 right-0.5 text-white/60 hover:bg-white/10 hover:text-white"
                />
              </SidebarMenuItem>
            </ChatContextMenu>
          );
        })}
        <SidebarMenuItem>
          {folders.length < MAX_FOLDERS ? (
            <SidebarNavButton active={false} className="text-white/70">
              <button type="button" onClick={() => setEditing({})}>
                <SidebarNavContent icon={AddFolder} active={false} title="Новая папка" />
              </button>
            </SidebarNavButton>
          ) : (
            <p className="px-2 py-1.5 text-xs text-white/50">
              Папок уже {MAX_FOLDERS} — больше нельзя. Удалите ненужную, чтобы завести новую.
            </p>
          )}
        </SidebarMenuItem>
      </SidebarNavGroup>
      <FolderDialog folder={editing} onClose={() => setEditing(null)} />
      {confirmDialog}
    </SidebarContent>
  );
}
