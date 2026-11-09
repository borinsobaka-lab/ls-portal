/**
 * Лента «Уведомлений» без React: группы по дням («Сегодня», «Вчера», «На
 * этой неделе», «Раньше»), вид уведомления по ключу, «Не беспокоить» до
 * утра в поясе человека. Тесты — notifications.test.ts.
 */
import { addDays, localDay, localTime, zoned } from "@/lib/tasks/logic";

export type NotifDayGroup = "today" | "yesterday" | "week" | "earlier";

export const NOTIF_DAY_GROUP_LABEL: Record<NotifDayGroup, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  week: "На этой неделе",
  earlier: "Раньше",
};

/** День недели ISO (1 — понедельник) дня «YYYY-MM-DD». */
function dow(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** К какой группе ленты относится момент (дни — в поясе человека). */
export function notifDayGroup(iso: string, tz: string, now = new Date()): NotifDayGroup {
  const day = localDay(new Date(iso), tz);
  const today = localDay(now, tz);
  if (day >= today) return "today";
  if (day === addDays(today, -1)) return "yesterday";
  const monday = addDays(today, 1 - dow(today));
  return day >= monday ? "week" : "earlier";
}

/** Строки ленты по группам дней, порядок строк сохраняется. */
export function groupNotifs<T extends { updated_at: string }>(
  items: T[],
  tz: string,
  now = new Date(),
): { group: NotifDayGroup; items: T[] }[] {
  const out: { group: NotifDayGroup; items: T[] }[] = [];
  for (const item of items) {
    const group = notifDayGroup(item.updated_at, tz, now);
    const last = out.at(-1);
    if (last && last.group === group) last.items.push(item);
    else out.push({ group, items: [item] });
  }
  return out;
}

export type NotifCategory = "chat" | "task" | "calendar" | "company" | "other";

/** Вид уведомления по ключу: «chat.direct» — чат, «task.review» — задача… */
export function notifCategory(kind: string): NotifCategory {
  const prefix = kind.split(".")[0];
  if (prefix === "chat") return "chat";
  if (prefix === "task") return "task";
  if (prefix === "cal") return "calendar";
  if (prefix === "company") return "company";
  return "other";
}

export const NOTIF_CATEGORY_LABEL: Record<NotifCategory, string> = {
  chat: "Чаты",
  task: "Задачи",
  calendar: "Календарь",
  company: "Компания",
  other: "Портал",
};

/** «До утра» — до 9:00 ближайшего утра в поясе человека. */
export function untilMorning(tz: string, now = new Date()): Date {
  const today = localDay(now, tz);
  const day = localTime(now, tz) < "09:00" ? today : addDays(today, 1);
  return zoned(day, "09:00", tz);
}
