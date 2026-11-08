/**
 * Папки чатов: системные «Все», «Личные» (и «Избранное»), «Каналы»
 * (когда есть), «Группы» (без каналов),
 * «Проекты» (чаты проектов, они и во «Всех»), «Встречи» (чаты встреч
 * календаря, и во «Всех»), «Задачи» (обсуждения задач —
 * только здесь, не во «Всех»: бриф, Д.2) и свои
 * папки человека (chat_folders). Папка — в адресе `?f=`.
 */
import type { ChatFolder, ChatRow } from "./types";

/** Канал — группа, где пишут админы и у постов «Прочитал». */
export const isChannel = (c: Pick<ChatRow, "kind" | "settings">) =>
  c.kind === "group" && !!c.settings?.channel;

export type FolderKey =
  | "all"
  | "direct"
  | "channel"
  | "group"
  | "project"
  | "event"
  | "task"
  | string;

export const SYSTEM_FOLDERS: { key: FolderKey; title: string }[] = [
  { key: "all", title: "Все чаты" },
  { key: "direct", title: "Личные" },
  { key: "channel", title: "Каналы" },
  { key: "group", title: "Группы" },
  { key: "project", title: "Проекты" },
  { key: "event", title: "Встречи" },
  { key: "task", title: "Задачи" },
];

export function folderFilter(folder: FolderKey, folders: Pick<ChatFolder, "id" | "chat_ids">[]) {
  if (folder === "all") return (c: ChatRow) => c.kind !== "task";
  if (folder === "direct") return (c: ChatRow) => c.kind === "direct" || c.kind === "self";
  if (folder === "channel") return (c: ChatRow) => isChannel(c);
  if (folder === "group") return (c: ChatRow) => c.kind === "group" && !isChannel(c);
  if (folder === "task") return (c: ChatRow) => c.kind === "task";
  if (folder === "project") return (c: ChatRow) => c.kind === "project";
  if (folder === "event") return (c: ChatRow) => c.kind === "event";
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
