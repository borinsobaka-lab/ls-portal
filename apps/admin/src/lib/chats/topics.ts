/**
 * Темы в группах (db/migrations/2026-11-08_zzzzzzzzzzzzz_chat_topics.sql):
 * тема — отдельный чат `kind = 'topic'` с `parent_id` группы. `chat_list`
 * отдаёт темы строками; в списке чатов они сворачиваются в строку группы
 * (`mergeTopics`: непрочитанное — сумма, последнее сообщение — самое свежее
 * с названием темы), сами темы — в колонке тем открытой группы.
 */
import type { ChatRow } from "./types";

export const TOPIC_COLORS: Record<string, { label: string; hex: string }> = {
  blue: { label: "Синий", hex: "#3b82f6" },
  teal: { label: "Бирюзовый", hex: "#14b8a6" },
  green: { label: "Зелёный", hex: "#22c55e" },
  amber: { label: "Жёлтый", hex: "#f59e0b" },
  orange: { label: "Оранжевый", hex: "#f97316" },
  red: { label: "Красный", hex: "#ef4444" },
  pink: { label: "Розовый", hex: "#ec4899" },
  purple: { label: "Фиолетовый", hex: "#a855f7" },
  gray: { label: "Серый", hex: "#64748b" },
};
export const TOPIC_COLOR_KEYS = Object.keys(TOPIC_COLORS);
export const topicColor = (c: string | null | undefined) =>
  TOPIC_COLORS[c ?? ""]?.hex ?? TOPIC_COLORS.blue.hex;

/** Группа с включёнными темами. */
export const isForum = (c: Pick<ChatRow, "kind" | "settings">) =>
  c.kind === "group" && !!c.settings?.topics;

/** Темы группы: свежие сверху (как в Telegram), закрытые — ниже открытых. */
export function topicsOf<T extends ChatRow>(chats: T[], groupId: string): T[] {
  return chats
    .filter((c) => c.kind === "topic" && c.parent_id === groupId)
    .sort((a, b) => {
      const closed = Number(!!a.settings?.closed) - Number(!!b.settings?.closed);
      if (closed) return closed;
      return (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at);
    });
}

const loud = (c: Pick<ChatRow, "notify" | "muted_until">, now: Date) =>
  c.notify !== "none" && !(c.muted_until && new Date(c.muted_until) > now);

/**
 * Строки для списка чатов: без тем; у группы с темами непрочитанное и
 * упоминания — с темами (темы без звука — не в счёт), последнее сообщение
 * — самое свежее из «Общей» и тем, `last_topic` — его тема.
 */
export function mergeTopics(chats: ChatRow[], now = new Date()): ChatRow[] {
  const byGroup = new Map<string, ChatRow[]>();
  for (const c of chats) {
    if (c.kind !== "topic" || !c.parent_id) continue;
    const list = byGroup.get(c.parent_id) ?? [];
    list.push(c);
    byGroup.set(c.parent_id, list);
  }
  return chats
    .filter((c) => c.kind !== "topic")
    .map((c) => {
      const topics = byGroup.get(c.id);
      if (!topics?.length) return c;
      let unread = c.unread;
      let mentions = c.mentions;
      let lastAt = c.last_message_at;
      let last = c.last_message;
      let lastTopic: string | null = null;
      for (const t of topics) {
        if (loud(t, now)) unread += t.unread;
        mentions += t.mentions;
        if (t.last_message_at && (!lastAt || t.last_message_at > lastAt)) {
          lastAt = t.last_message_at;
          last = t.last_message;
          lastTopic = t.title;
        }
      }
      return {
        ...c,
        unread,
        mentions,
        last_message: last,
        last_message_at: lastAt,
        last_topic: lastTopic,
      };
    });
}

/** Порядок списка после свёртки: закреплённые, затем по последнему сообщению. */
export function sortChats(rows: ChatRow[]): ChatRow[] {
  return [...rows].sort((a, b) => {
    if (!!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1;
    if (a.pinned_at && b.pinned_at) return b.pinned_at.localeCompare(a.pinned_at);
    return (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at);
  });
}

/** Тему могут заводить: админы группы или (если разрешено) все. */
export const canCreateTopic = (g: Pick<ChatRow, "my_role" | "settings">) =>
  g.my_role !== "member" || g.settings?.topic_create === "all";

/** Правит тему (название, цвет, закрыть, удалить): её автор или админы группы. */
export const canManageTopic = (
  topic: Pick<ChatRow, "created_by">,
  group: Pick<ChatRow, "my_role"> | null | undefined,
  me: string,
) => topic.created_by === me || (!!group && group.my_role !== "member");
