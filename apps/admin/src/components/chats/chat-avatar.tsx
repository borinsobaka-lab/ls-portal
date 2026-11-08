/**
 * Аватарка чата: личный — фото собеседника с точкой «в сети», группа —
 * инициалы названия на цвете по id, проект — папка на цвете по id, задача —
 * значок списка, «Избранное» — закладка.
 */
import { Bookmark, CalendarDays, FolderOpen, ListChecks, Users } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import { isOnline } from "@/lib/company";
import { usePeople } from "@/lib/chats/people";
import type { ChatRow } from "@/lib/chats/types";
import { cn } from "@/lib/utils";
import { avatarStyle } from "@/lib/avatar-color";

export function ChatAvatar({
  chat,
  title,
  size = "md",
}: {
  chat: Pick<ChatRow, "id" | "kind" | "peer_id">;
  title: string;
  size?: "sm" | "md";
}) {
  const { person } = usePeople();
  const box = size === "sm" ? "size-9 text-xs" : "size-11 text-sm";
  if (chat.kind === "self") {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-selected text-selected-foreground",
          box,
        )}
      >
        <Bookmark className={size === "sm" ? "size-4" : "size-5"} />
      </span>
    );
  }
  if (chat.kind === "project") {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold", box)}
        style={avatarStyle(chat.id)}
      >
        <FolderOpen className={size === "sm" ? "size-4" : "size-5"} />
      </span>
    );
  }
  if (chat.kind === "event") {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold", box)}
        style={avatarStyle(chat.id)}
      >
        <CalendarDays className={size === "sm" ? "size-4" : "size-5"} />
      </span>
    );
  }
  if (chat.kind === "task") {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-chat-accent-soft text-chat-accent",
          box,
        )}
      >
        <ListChecks className={size === "sm" ? "size-4" : "size-5"} />
      </span>
    );
  }
  if (chat.kind === "direct") {
    const p = person(chat.peer_id);
    return (
      <span className="relative shrink-0">
        <StaffAvatar value={p?.avatar_url} name={title} className={box} />
        {p && isOnline(p.last_seen_at) && (
          <span
            aria-label="в сети"
            className="absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2 ring-background"
          />
        )}
      </span>
    );
  }
  const letters = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold", box)}
      style={avatarStyle(chat.id)}
    >
      {letters || <Users className="size-4" />}
    </span>
  );
}
