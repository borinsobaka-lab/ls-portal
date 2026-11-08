/**
 * Аватарка чата: личный — фото собеседника с точкой «в сети», группа —
 * инициалы названия на цвете по id, «Избранное» — закладка.
 */
import { Bookmark, Users } from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import { isOnline } from "@/lib/company";
import { usePeople } from "@/lib/chats/people";
import type { ChatRow } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

const GROUP_COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-800",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-teal-100 text-teal-700",
  "bg-orange-100 text-orange-700",
  "bg-indigo-100 text-indigo-700",
];

function colorOf(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

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
          "flex shrink-0 items-center justify-center rounded-full bg-sky-500 text-white",
          box,
        )}
      >
        <Bookmark className={size === "sm" ? "size-4" : "size-5"} />
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
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        colorOf(chat.id),
        box,
      )}
    >
      {letters || <Users className="size-4" />}
    </span>
  );
}
