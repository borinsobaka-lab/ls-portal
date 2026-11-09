/**
 * Пункт «Без звука ▸» / «Включить звук» — одинаковый в строке списка, шапке
 * чата и у темы (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 3.1.1): подменю «На 1 час /
 * На 8 часов / На 2 дня / Навсегда», как в Telegram.
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellOff, Volume2 } from "lucide-react";

import type { ChatMenuItem } from "@/components/chats/action-menu";
import { isMuted, muteLabel, muteOptions } from "./content";
import { chatErrorText, setChatNotify } from "./data";
import type { ChatRow } from "./types";

/** Поставить уведомления и сказать, что получилось. */
export function applyNotify(
  qc: QueryClient,
  chat: Pick<ChatRow, "id">,
  notify: ChatRow["notify"],
  until: Date | null,
) {
  void setChatNotify(qc, chat.id, notify, until).then(
    () => {
      const label = muteLabel({ notify, muted_until: until?.toISOString() ?? null });
      toast.success(label || "Звук включён");
    },
    (e: unknown) => toast.error(chatErrorText(e)),
  );
}

export function muteMenuItem(
  qc: QueryClient,
  chat: Pick<ChatRow, "id" | "notify" | "muted_until">,
): ChatMenuItem {
  if (isMuted(chat))
    return {
      label: "Включить звук",
      icon: Volume2,
      onSelect: () => applyNotify(qc, chat, "all", null),
    };
  return {
    label: "Без звука",
    icon: BellOff,
    items: muteOptions(chat.notify).map((o) => ({
      label: o.label,
      onSelect: () => applyNotify(qc, chat, o.notify, o.until),
    })),
  };
}
