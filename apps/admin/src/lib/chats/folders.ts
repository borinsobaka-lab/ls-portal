/**
 * Папки чатов: системные «Все», «Личные» (и «Избранное»), «Группы» и свои
 * папки человека (chat_folders). Папка — в адресе `?f=`.
 */
import type { ChatFolder, ChatRow } from "./types";

export type FolderKey = "all" | "direct" | "group" | string;

export const SYSTEM_FOLDERS: { key: FolderKey; title: string }[] = [
  { key: "all", title: "Все чаты" },
  { key: "direct", title: "Личные" },
  { key: "group", title: "Группы" },
];

export function folderFilter(folder: FolderKey, folders: Pick<ChatFolder, "id" | "chat_ids">[]) {
  if (folder === "all") return () => true;
  if (folder === "direct") return (c: ChatRow) => c.kind !== "group";
  if (folder === "group") return (c: ChatRow) => c.kind === "group";
  const ids = new Set(folders.find((f) => f.id === folder)?.chat_ids ?? []);
  return (c: ChatRow) => ids.has(c.id);
}

/** Чатов с непрочитанным в папке (без звука — не в счёт). */
export function folderUnread(chats: ChatRow[], keep: (c: ChatRow) => boolean): number {
  return chats.filter(
    (c) =>
      keep(c) &&
      c.unread > 0 &&
      c.notify !== "none" &&
      !(c.muted_until && new Date(c.muted_until) > new Date()),
  ).length;
}
