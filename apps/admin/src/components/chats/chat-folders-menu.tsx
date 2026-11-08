/**
 * Меню раздела «Чаты» в боковой панели — папки (бриф 2.6, боль № 27):
 * «Все чаты», «Личные», «Группы» и свои папки с числом чатов с
 * непрочитанным; правой кнопкой — «Прочитать всё» (Д.3), у своей —
 * «Изменить» и «Удалить»; внизу — «Новая папка». Папка — в адресе `?f=`.
 */
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderPlus, MessagesSquare, User, Users } from "lucide-react";
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
import { CountBadge } from "@/components/ui/status-chip";
import {
  chatErrorText,
  chatFoldersQuery,
  chatRpc,
  markAllRead,
  useChatList,
} from "@/lib/chats/data";
import { folderFilter, folderUnread, SYSTEM_FOLDERS, type FolderKey } from "@/lib/chats/folders";
import type { ChatFolder } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

const ICONS = { all: MessagesSquare, direct: User, group: Users } as const;

export function ChatFoldersMenu({ onNavigate }: { onNavigate?: () => void }) {
  const qc = useQueryClient();
  const { data: chats = [] } = useChatList();
  const { data: folders = [] } = useQuery(chatFoldersQuery);
  const { confirm, confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<Partial<ChatFolder> | null>(null);
  const location = useRouterState({ select: (s) => s.location });
  const current = ((location.search as { f?: string }).f ?? "all") as FolderKey;
  const chatPath = location.pathname.startsWith("/chats/") ? location.pathname : "/chats";

  const items: { key: FolderKey; title: string; folder?: ChatFolder }[] = [
    ...SYSTEM_FOLDERS,
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
    <nav
      aria-label="Папки чатов"
      className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
    >
      <p className="px-2 pt-1 pb-1 text-[13px] text-white/50">Папки</p>
      {items.map((it) => {
        const unread = folderUnread(chats, folderFilter(it.key, folders));
        const Icon = ICONS[it.key as keyof typeof ICONS] ?? Folder;
        const active = current === it.key;
        return (
          <ContextMenu key={it.key}>
            <ContextMenuTrigger asChild>
              <Link
                to={chatPath}
                search={it.key === "all" ? {} : { f: it.key }}
                onClick={onNavigate}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-white hover:bg-white/10",
                  active && "bg-white/10 font-semibold",
                )}
              >
                <Icon className={cn("size-[18px] shrink-0", active && "text-brand-on-dark")} />
                <span className="min-w-0 flex-1 truncate">{it.title}</span>
                {unread > 0 && <CountBadge count={unread} />}
              </Link>
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
      <button
        type="button"
        onClick={() => setEditing({})}
        className="mt-1 flex h-9 items-center gap-2 rounded-md px-2 text-sm text-white/70 hover:bg-white/10 hover:text-white"
      >
        <FolderPlus className="size-[18px]" /> Новая папка
      </button>
      <FolderDialog folder={editing} onClose={() => setEditing(null)} />
      {confirmDialog}
    </nav>
  );
}
