/**
 * Папки чатов для меню раздела и строки чипов над списком (одни и те же):
 * системные — всегда (пустая папка объясняет, что сюда попадает), затем свои.
 * Счётчик — чаты с непрочитанным без звука (`folderUnread`), «Отметить всё
 * прочитанным» — и темы групп папки.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { chatErrorText, chatFoldersQuery, chatRpc, markAllRead, useChatList } from "./data";
import { folderFilter, folderUnread, SYSTEM_FOLDERS, type FolderKey } from "./folders";
import { mergeTopics } from "./topics";
import type { ChatFolder } from "./types";

export type FolderItem = { key: FolderKey; title: string; folder?: ChatFolder; unread: number };

export function useFolderItems() {
  const qc = useQueryClient();
  const { data: all = [] } = useChatList();
  // Темы — в строке своей группы: папки и счётчики считают группу один раз.
  const chats = useMemo(() => mergeTopics(all), [all]);
  const { data: folders = [] } = useQuery(chatFoldersQuery);

  const items: FolderItem[] = useMemo(
    () =>
      [
        ...SYSTEM_FOLDERS.map((f) => ({ key: f.key, title: f.title })),
        ...folders.map((f) => ({ key: f.id, title: f.title, folder: f })),
      ].map((it) => ({ ...it, unread: folderUnread(chats, folderFilter(it.key, folders)) })),
    [chats, folders],
  );

  /** Отметить прочитанными все чаты папки (с темами групп). */
  const readAll = (key: FolderKey) => {
    const groups = new Set(chats.filter(folderFilter(key, folders)).map((c) => c.id));
    const ids = all
      .filter((c) => groups.has(c.id) || (c.parent_id && groups.has(c.parent_id)))
      .map((c) => c.id);
    void markAllRead(qc, ids).then(
      () => toast.success("Всё в папке отмечено прочитанным"),
      (e: unknown) => toast.error(chatErrorText(e)),
    );
  };

  const removeFolder = async (f: ChatFolder) => {
    try {
      await chatRpc("chat_folder_delete", { p_id: f.id });
      await qc.invalidateQueries({ queryKey: ["chat_folders"] });
      toast.success(`Папка «${f.title}» удалена`);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  return { items, folders, readAll, removeFolder };
}
