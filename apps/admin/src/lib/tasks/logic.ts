/**
 * Логика задач без React: подписи, кто что может (зеркало проверок базы —
 * task_set_status, task_update), сроки в поясе человека (TASKS_CHATS_PLAN.md,
 * 4.4: срок — момент времени, «день» — в поясе человека, не по Тбилиси),
 * быстрые сроки по рабочим дням, колонки «Сроков», подписи истории.
 */
import type { StatusTone } from "@/components/ui/status-chip-styles";

import type { SortGetters } from "@/lib/table-sort";

import { dayKind, type DayKind } from "./work-calendar";
import type {
  DeadlineRule,
  ProjectKind,
  ProjectRole,
  RecurrenceRule,
  RoleTab,
  TaskEvent,
  TaskFilters,
  TaskRole,
  TaskRow,
  TaskSort,
  TaskStatus,
} from "./types";

// ---- Подписи ------------------------------------------------------------------

export const STATUS_LABEL: Record<TaskStatus, string> = {
  new: "Новая",
  in_progress: "В работе",
  review: "На проверке",
  done: "Завершена",
  deferred: "Отложена",
  cancelled: "Отменена",
};

export const STATUS_TONE: Record<TaskStatus, StatusTone> = {
  new: "info",
  in_progress: "strong",
  review: "warning",
  done: "positive",
  deferred: "neutral",
  cancelled: "neutral",
};

export const STATUS_ORDER: TaskStatus[] = [
  "new",
  "in_progress",
  "review",
  "deferred",
  "done",
  "cancelled",
];

export const ROLE_LABEL: Record<TaskRole, string> = {
  creator: "Постановщик",
  assignee: "Исполнитель",
  coassignee: "Соисполнитель",
  watcher: "Наблюдатель",
  manager: "Руководитель",
  project: "Участник проекта",
  parent: "Участник родительской задачи",
};

/** Тип проекта; в базе «project» — подпись «Инициатива» (разбор интерфейса, 2.2). */
export const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  department: "Отдел",
  city: "Город",
  project: "Инициатива",
};

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Владелец",
  moderator: "Модератор",
  member: "Участник",
};

/** «Исполнитель меняет срок: Свободно / С причиной / Нельзя». */
export const DEADLINE_RULE_LABEL: Record<DeadlineRule, string> = {
  free: "Свободно",
  reason: "С причиной",
  forbid: "Нельзя",
};

/** Цвета проектов — спокойные, читаются белым текстом и точкой в меню. */
export const PROJECT_COLORS = [
  "#3e63dd",
  "#0d9488",
  "#16a34a",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#db2777",
  "#7c3aed",
  "#475569",
];

const WEEKDAY_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** «Каждый день в 09:00», «По пн, ср в 10:00», «Через 2 дня после закрытия». */
export function recurrenceText(rule: RecurrenceRule, time: string): string {
  const at = `в ${hhmm(time)}`;
  switch (rule.freq) {
    case "daily":
      return `Каждый день ${at}`;
    case "workdays":
      return `По рабочим дням ${at}`;
    case "weekly":
      return `По ${[...rule.weekdays]
        .sort()
        .map((d) => WEEKDAY_SHORT[d - 1])
        .join(", ")} ${at}`;
    case "monthly":
      return `Каждый месяц ${rule.monthday}-го ${at}`;
    case "after_close":
      return rule.after_days === 0
        ? `Сразу после закрытия прежней, ${at}`
        : `Через ${rule.after_days} ${plural(rule.after_days, "день", "дня", "дней")} после закрытия прежней, ${at}`;
  }
}

export const ROLE_TABS: { key: RoleTab; title: string; hint: string }[] = [
  { key: "do", title: "Делаю", hint: "Я исполнитель" },
  { key: "help", title: "Помогаю", hint: "Я соисполнитель" },
  { key: "assigned", title: "Поручил", hint: "Я постановщик, исполнитель — другой" },
  { key: "watch", title: "Наблюдаю", hint: "Я наблюдатель" },
  { key: "all", title: "Все мои", hint: "Все задачи с моим участием" },
];

/** Представления одних и тех же задач — переключатель на странице. */
export const TASK_VIEWS = [
  { key: "list", title: "Список", url: "/tasks" },
  { key: "deadlines", title: "Сроки", url: "/tasks/deadlines" },
  { key: "plan", title: "Мой план", url: "/tasks/plan" },
] as const;
export type TaskView = (typeof TASK_VIEWS)[number]["key"];

/** Пресет меню «Сегодня»: делаю, срок — сегодня. */
export const TODAY_PRESET: TaskFilters = { role: "do", deadline: "today" };

export const DEADLINE_FILTERS: { key: NonNullable<TaskFilters["deadline"]>; title: string }[] = [
  { key: "overdue", title: "Просрочены" },
  { key: "today", title: "Сегодня" },
  { key: "week", title: "Эта неделя" },
  { key: "none", title: "Без срока" },
  { key: "range", title: "Период" },
];

/** Напоминание себе: в момент срока или за N минут до него. */
export const REMINDER_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "Не напоминать" },
  { value: "0", label: "В момент срока" },
  { value: "15", label: "За 15 минут" },
  { value: "60", label: "За час" },
  { value: "180", label: "За 3 часа" },
  { value: "1440", label: "За день" },
];

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---- Кто что может -------------------------------------------------------------

export type StatusAction =
  | "start"
  | "complete"
  | "accept"
  | "return"
  | "defer"
  | "cancel"
  | "reopen";

export type TaskPerms = {
  boss: boolean;
  assignee: boolean;
  worker: boolean;
  /** Название, описание, срочность, проверка, участники. */
  edit: boolean;
  /** Срок: free — свободно, reason — с причиной, null — нельзя. */
  deadline: "free" | "reason" | null;
  /** Чек-листы и файлы. */
  work: boolean;
  delegate: boolean;
  member: boolean;
  actions: { action: StatusAction; label: string; primary?: boolean; danger?: boolean }[];
};

export function taskPerms(
  t: Pick<TaskRow, "my_roles" | "status" | "requires_review"> & { deadline_rule?: string },
): TaskPerms {
  const r = new Set(t.my_roles);
  const boss = r.has("creator") || r.has("manager");
  const assignee = r.has("assignee");
  const worker = boss || assignee || r.has("coassignee");
  const open = t.status === "new" || t.status === "in_progress" || t.status === "deferred";
  const closed = t.status === "done" || t.status === "cancelled";
  const actions: TaskPerms["actions"] = [];
  if (worker && (t.status === "new" || t.status === "deferred"))
    actions.push({ action: "start", label: "Начать" });
  if ((boss || assignee) && open)
    actions.push({
      action: "complete",
      label: t.requires_review && !boss ? "На проверку" : "Завершить",
      primary: true,
    });
  if (boss && t.status === "review")
    actions.push({ action: "accept", label: "Принять", primary: true });
  if (boss && (t.status === "review" || t.status === "done"))
    actions.push({
      action: "return",
      label: t.status === "review" ? "Вернуть" : "Вернуть в работу",
    });
  if (worker && (t.status === "new" || t.status === "in_progress"))
    actions.push({ action: "defer", label: "Отложить" });
  if ((boss || assignee) && closed) actions.push({ action: "reopen", label: "Возобновить" });
  if (boss && !closed) actions.push({ action: "cancel", label: "Отменить задачу", danger: true });
  const rule = t.deadline_rule ?? "reason";
  return {
    boss,
    assignee,
    worker,
    edit: boss,
    deadline: boss
      ? "free"
      : assignee && rule !== "forbid"
        ? rule === "free"
          ? "free"
          : "reason"
        : null,
    work: worker,
    delegate: boss || assignee,
    member: r.has("creator") || r.has("assignee") || r.has("coassignee") || r.has("watcher"),
    actions,
  };
}

export const isClosed = (s: TaskStatus) => s === "done" || s === "cancelled";

export function isOverdue(t: Pick<TaskRow, "deadline" | "status">, now = new Date()): boolean {
  return !!t.deadline && !isClosed(t.status) && new Date(t.deadline) < now;
}

export function memberIds(t: Pick<TaskRow, "members">, role: TaskRow["members"][number]["role"]) {
  return t.members.filter((m) => m.role === role).map((m) => m.user_id);
}

export const assigneeOf = (t: Pick<TaskRow, "members">) => memberIds(t, "assignee")[0] ?? null;
export const creatorOf = (t: Pick<TaskRow, "members">) => memberIds(t, "creator")[0] ?? null;

/** «86 задач: 60 готово, 20 в работе, 6 просрочено». */
export function batchText(b: NonNullable<TaskRow["batch"]>): string {
  const open = b.total - b.done - b.cancelled;
  const parts = [`${b.done} готово`, `${open} в работе`];
  if (b.overdue > 0) parts.push(`${b.overdue} просрочено`);
  return `${b.total} ${plural(b.total, "задача", "задачи", "задач")}: ${parts.join(", ")}`;
}

// ---- Время в поясе человека ------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(date: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** Дата «2026-11-14» в поясе. */
export const localDay = (date: Date, tz: string) => partsIn(date, tz).day;

/** Время «18:00» в поясе. */
export function localTime(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function offsetMinutes(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const [y, m, d] = p.day.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute);
  const floored = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

/** Момент времени «день + время» в поясе. */
export function zoned(day: string, time: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMinutes(new Date(guess), tz);
  let ts = guess - off1 * 60_000;
  const off2 = offsetMinutes(new Date(ts), tz);
  if (off2 !== off1) ts = guess - off2 * 60_000;
  return new Date(ts);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 1 — понедельник … 7 — воскресенье. */
export function isoDow(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export type WorkCalendar = ReadonlyMap<string, DayKind>;
export const isWorking = (day: string, cal: WorkCalendar) => dayKind(day, cal) !== "off";

export function nextWorkingDay(day: string, cal: WorkCalendar): string {
  let d = day;
  for (let i = 0; i < 40 && !isWorking(d, cal); i++) d = addDays(d, 1);
  return d;
}

/** Последний рабочий день недели дня (пн–вс), не раньше from; нет — null. */
function lastWorkingOfWeek(day: string, from: string, cal: WorkCalendar): string | null {
  for (let d = addDays(day, 7 - isoDow(day)); d >= from; d = addDays(d, -1)) {
    if (isWorking(d, cal)) return d;
  }
  return null;
}

/** «18:00:00» из базы → «18:00». */
export const hhmm = (t: string | null | undefined) => (t ?? "18:00").slice(0, 5);

const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAY[dow]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

export type QuickDeadline = { key: string; label: string; hint: string; date: Date };

/**
 * Быстрые сроки (план, 4.4) — по рабочим дням и концу рабочего дня
 * человека: «Сегодня» (прошёл конец дня — до 23:59), следующий рабочий
 * день, конец недели, через неделю (5 рабочих дней).
 */
export function quickDeadlines(
  now: Date,
  tz: string,
  workdayEnd: string,
  cal: WorkCalendar,
): QuickDeadline[] {
  const end = hhmm(workdayEnd);
  const today = localDay(now, tz);
  const todayEnd = zoned(today, end, tz) > now ? zoned(today, end, tz) : zoned(today, "23:59", tz);
  const next = nextWorkingDay(addDays(today, 1), cal);
  const weekEnd =
    lastWorkingOfWeek(today, today, cal) ??
    lastWorkingOfWeek(addDays(today, 7), today, cal) ??
    next;
  let plus5 = today;
  for (let i = 0; i < 5; i++) plus5 = nextWorkingDay(addDays(plus5, 1), cal);
  const at = (day: string) => zoned(day, end, tz);
  return [
    { key: "today", label: "Сегодня", hint: `до ${localTime(todayEnd, tz)}`, date: todayEnd },
    {
      key: "next",
      label: next === addDays(today, 1) ? "Завтра" : shortDay(next),
      hint: `${shortDay(next)}, ${end}`,
      date: at(next),
    },
    { key: "week", label: "Конец недели", hint: `${shortDay(weekEnd)}, ${end}`, date: at(weekEnd) },
    {
      key: "plus5",
      label: "Через 5 рабочих дней",
      hint: `${shortDay(plus5)}, ${end}`,
      date: at(plus5),
    },
  ];
}

/** «сегодня, 18:00», «завтра, 10:00», «пт 14.11, 18:00», «14.11.2027, 18:00». */
export function formatDeadline(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const day = localDay(d, tz);
  const today = localDay(now, tz);
  const time = localTime(d, tz);
  if (day === today) return `сегодня, ${time}`;
  if (day === addDays(today, 1)) return `завтра, ${time}`;
  if (day === addDays(today, -1)) return `вчера, ${time}`;
  const [y, m, dd] = day.split("-");
  if (y === today.slice(0, 4)) return `${shortDay(day)}, ${time}`;
  return `${dd}.${m}.${y}, ${time}`;
}

/** Дата и время по-русски для истории: «14.11.2026, 18:00». */
export function formatMoment(iso: string | null | undefined, tz: string): string {
  if (!iso) return "без срока";
  const d = new Date(iso);
  const [y, m, dd] = localDay(d, tz).split("-");
  return `${dd}.${m}.${y}, ${localTime(d, tz)}`;
}

// ---- «Сроки» -----------------------------------------------------------------------

export type ColumnKey = "overdue" | "today" | "tomorrow" | "week" | "next" | "later" | "none";

export const COLUMNS: { key: ColumnKey; title: string }[] = [
  { key: "overdue", title: "Просрочены" },
  { key: "today", title: "Сегодня" },
  { key: "tomorrow", title: "Завтра" },
  { key: "week", title: "Эта неделя" },
  { key: "next", title: "Следующая неделя" },
  { key: "later", title: "Позже" },
  { key: "none", title: "Без срока" },
];

export function deadlineColumn(deadline: string | null, now: Date, tz: string): ColumnKey {
  if (!deadline) return "none";
  const d = new Date(deadline);
  if (d < now) return "overdue";
  const day = localDay(d, tz);
  const today = localDay(now, tz);
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  const sunday = addDays(today, 7 - isoDow(today));
  if (day <= sunday) return "week";
  if (day <= addDays(sunday, 7)) return "next";
  return "later";
}

/**
 * Срок при переносе карточки в колонку: «Сегодня» — конец рабочего дня
 * (прошёл — 23:59), «Завтра» — завтра или ближайший рабочий, «Эта / Следующая
 * неделя» — последний рабочий день недели, «Без срока» — null. В «Просрочены»
 * и «Позже» не переносят — undefined.
 */
export function columnDeadline(
  key: ColumnKey,
  now: Date,
  tz: string,
  workdayEnd: string,
  cal: WorkCalendar,
): Date | null | undefined {
  const end = hhmm(workdayEnd);
  const today = localDay(now, tz);
  switch (key) {
    case "today":
      return zoned(today, end, tz) > now ? zoned(today, end, tz) : zoned(today, "23:59", tz);
    case "tomorrow":
      return zoned(nextWorkingDay(addDays(today, 1), cal), end, tz);
    case "week": {
      const day = lastWorkingOfWeek(today, addDays(today, 1), cal);
      return day ? zoned(day, end, tz) : undefined;
    }
    case "next": {
      const day = lastWorkingOfWeek(addDays(today, 7), addDays(today, 1), cal);
      return day ? zoned(day, end, tz) : undefined;
    }
    case "none":
      return null;
    default:
      return undefined;
  }
}

// ---- История ------------------------------------------------------------------------

export function eventText(e: TaskEvent, name: (id: string) => string, tz: string): string {
  const d = e.data ?? {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  switch (e.kind) {
    case "created":
      return d.batch_id ? "поставил(а) задачу (отдельно каждому)" : "поставил(а) задачу";
    case "title":
      return `переименовал(а): «${s("from")}» → «${s("to")}»`;
    case "description":
      return "изменил(а) описание";
    case "urgent":
      return d.to ? "отметил(а) срочной" : "снял(а) срочность";
    case "requires_review":
      return d.to
        ? "включил(а) «Принять работу после завершения»"
        : "выключил(а) «Принять работу после завершения»";
    case "deadline":
      return `срок: ${formatMoment(s("from") || null, tz)} → ${formatMoment(s("to") || null, tz)}`;
    case "status": {
      const from = STATUS_LABEL[s("from") as TaskStatus] ?? s("from");
      const to = STATUS_LABEL[s("to") as TaskStatus] ?? s("to");
      return `статус: ${from} → ${to}`;
    }
    case "delegated":
      return `передал(а) задачу: ${s("from") ? name(s("from")) : "—"} → ${name(s("to"))}`;
    case "members": {
      const list = (k: string) =>
        ((d[k] as { user_id: string; role: TaskRole }[] | undefined) ?? []).map(
          (m) => `${name(m.user_id)} (${ROLE_LABEL[m.role]?.toLowerCase() ?? m.role})`,
        );
      const added = list("added");
      const removed = list("removed");
      return [
        added.length ? `добавил(а): ${added.join(", ")}` : "",
        removed.length ? `убрал(а): ${removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    case "project": {
      const title = (k: string) => (d[k] as { title?: string } | null)?.title ?? "без проекта";
      return `проект: ${title("from")} → ${title("to")}`;
    }
    case "stage":
      return `стадия: ${s("from") || "—"} → ${s("to")}`;
    case "check":
      return `${d.done ? "отметил(а)" : "снял(а) отметку"}: «${s("text")}»`;
    case "files": {
      const added = (d.added as string[] | undefined) ?? [];
      const removed = (d.removed as string[] | undefined) ?? [];
      if (added.length)
        return `добавил(а) ${plural(added.length, "файл", "файла", "файлов")}: ${added.join(", ")}`;
      return `убрал(а) файл: ${removed.join(", ")}`;
    }
    case "subtask":
      return `добавил(а) подзадачу #${d.number} «${s("title")}»`;
    case "subtask_status":
      return `подзадача #${d.number} «${s("title")}» — ${
        s("to") === "cancelled" ? "отменена" : "завершена"
      }`;
    case "parent":
      return d.to ? `сделал(а) подзадачей #${d.to}` : `отвязал(а) от задачи #${d.from}`;
    case "result":
      return d.cleared ? "убрал(а) результат" : "написал(а) результат";
    case "tags": {
      const added = (d.added as string[] | undefined) ?? [];
      const removed = (d.removed as string[] | undefined) ?? [];
      return [
        added.length ? `добавил(а) теги: ${added.map((x) => `#${x}`).join(", ")}` : "",
        removed.length ? `убрал(а) теги: ${removed.map((x) => `#${x}`).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    case "result_required":
      return d.to
        ? "включил(а) «Требовать отчёт о результате»"
        : "выключил(а) «Требовать отчёт о результате»";
    default:
      return e.kind;
  }
}

/** Название задачи из сообщения чата: первая непустая строка, до 300 знаков. */
export function titleFromMessage(text: string): string {
  const t = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return t.length > 300 ? `${t.slice(0, 299).trimEnd()}…` : t;
}

// ---- «Мой план» -------------------------------------------------------------------------

type PlanItem = { column_id: string | null; sort_order: number; task: { id: string } };

/** Карточки колонки сверху вниз (null — «Не разобрано»). */
export function planColumnCards<T extends PlanItem>(cards: T[], column: string | null): T[] {
  return cards
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.column_id === column)
    .sort((a, b) => a.c.sort_order - b.c.sort_order || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Порядок колонки после переноса карточки `taskId` в `column` перед
 * `beforeId` (null — в конец): id карточек колонки сверху вниз.
 */
export function planMoveOrder(
  cards: PlanItem[],
  taskId: string,
  column: string | null,
  beforeId: string | null,
): string[] {
  const current = planColumnCards(cards, column).map((c) => c.task.id);
  if (beforeId === taskId && current.includes(taskId)) return current;
  const ids = current.filter((id) => id !== taskId);
  const at = beforeId ? ids.indexOf(beforeId) : -1;
  if (at < 0) ids.push(taskId);
  else ids.splice(at, 0, taskId);
  return ids;
}

// ---- Фильтры: адрес ↔ RPC -------------------------------------------------------------

const ROLE_KEYS = new Set<RoleTab>(["do", "help", "assigned", "watch", "all"]);
const STATUS_KEYS = new Set<TaskStatus>(STATUS_ORDER);
const DEADLINE_KEYS = new Set(DEADLINE_FILTERS.map((f) => f.key));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Фильтры из адреса (`validateSearch`) — только допустимые значения. */
export function parseTaskFilters(raw: Record<string, unknown>): TaskFilters {
  const f: TaskFilters = {};
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const role = str("role");
  if (role && ROLE_KEYS.has(role as RoleTab)) f.role = role as RoleTab;
  const status = str("status");
  if (status) {
    const list = status.split(",").filter((x): x is TaskStatus => STATUS_KEYS.has(x as TaskStatus));
    if (list.length) f.status = list;
  }
  const deadline = str("deadline");
  if (deadline && DEADLINE_KEYS.has(deadline as never))
    f.deadline = deadline as TaskFilters["deadline"];
  for (const k of ["dfrom", "dto", "cfrom", "cto"] as const) {
    const v = str(k);
    if (v && DAY_RE.test(v)) f[k] = v;
  }
  for (const k of ["creator", "assignee", "project", "tag"] as const) {
    const v = str(k);
    if (v && UUID_RE.test(v)) f[k] = v;
  }
  const q = str("q")?.slice(0, 200);
  if (q) f.q = q;
  const flag = (k: string) => raw[k] === true || raw[k] === "1" || raw[k] === 1;
  if (flag("done")) f.done = true;
  if (flag("mine")) f.mine = true;
  if (flag("all")) f.all = true;
  if (flag("team")) f.team = true;
  const sort = str("sort");
  if (sort === "urgent" || sort === "created") f.sort = sort;
  return f;
}

/** Параметры task_list. */
export function filtersToParams(f: TaskFilters, offset = 0, limit = 100): Record<string, unknown> {
  return {
    role: f.role ?? "all",
    statuses: f.status ?? [],
    show_done: !!f.done,
    deadline: f.deadline ?? null,
    deadline_from: f.deadline === "range" ? (f.dfrom ?? null) : null,
    deadline_to: f.deadline === "range" ? (f.dto ?? null) : null,
    creator: f.creator ?? null,
    assignee: f.assignee ?? null,
    created_from: f.cfrom ?? null,
    created_to: f.cto ?? null,
    q: f.q ?? "",
    checklist_mine: !!f.mine,
    scope: f.team ? "team" : f.all ? "all" : null,
    project: f.project ?? null,
    sort: f.sort ?? "deadline",
    tag: f.tag ?? null,
    limit,
    offset,
  };
}

/** Есть ли фильтры, кроме вкладки роли и порядка. */
export function hasExtraFilters(f: TaskFilters): boolean {
  return Object.entries(f).some(
    ([k, v]) => k !== "role" && k !== "sort" && v !== undefined && v !== false,
  );
}

/** Фильтры без пустых значений — для адреса и сохранения. */
export function cleanFilters(f: TaskFilters): TaskFilters {
  return Object.fromEntries(
    Object.entries(f).filter(
      ([, v]) => v !== undefined && v !== false && v !== "" && !(Array.isArray(v) && !v.length),
    ),
  ) as TaskFilters;
}

// ---- Шаблоны ------------------------------------------------------------------------

/**
 * Срок задачи из шаблона: через N рабочих дней от сегодня (0 — сегодня или
 * ближайший рабочий) к времени шаблона, иначе к концу рабочего дня — как
 * считает база для регулярных (work_add_days).
 */
export function templateDeadline(
  now: Date,
  tz: string,
  workdayEnd: string,
  cal: WorkCalendar,
  days: number | null | undefined,
  time?: string | null,
): Date | null {
  if (days === null || days === undefined || Number.isNaN(days)) return null;
  let day = nextWorkingDay(localDay(now, tz), cal);
  for (let i = 0; i < days; i++) day = nextWorkingDay(addDays(day, 1), cal);
  return zoned(day, hhmm(time || workdayEnd), tz);
}

/** Чек-лист в форме постановки и шаблона. */
export type DraftList = { title: string; items: { text: string; assignee_id?: string | null }[] };

/** Только заполненное — для записи. */
export function cleanLists(lists: DraftList[]): DraftList[] {
  return lists
    .map((l) => ({
      title: l.title.trim() || "Чек-лист",
      items: l.items.filter((i) => i.text.trim()).map((i) => ({ ...i, text: i.text.trim() })),
    }))
    .filter((l) => l.items.length > 0);
}

// ---- Разбор интерфейса (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 2026-11-09) ----------------

/** Фильтры отличаются от умолчаний (вкладка «Все мои» без фильтров) — их можно сохранить. */
export function filtersDiffer(f: TaskFilters): boolean {
  return (
    Object.keys(cleanFilters({ ...f, role: f.role === "all" ? undefined : f.role })).length > 0
  );
}

/** Сколько фильтров спрятано за кнопкой «Фильтры (N)». */
export function hiddenFilterCount(f: TaskFilters): number {
  return [
    f.creator,
    f.project,
    f.tag,
    f.deadline === "range",
    f.cfrom || f.cto,
    f.sort === "urgent",
    f.mine,
    f.all,
  ].filter(Boolean).length;
}

/**
 * Порядок списка с сервера по колонке сортировки: «№» и «Задача» — новые
 * первыми, остальные — по сроку; «Срочные — первыми» важнее.
 */
export function serverSort(column: string | null | undefined, urgent: boolean): TaskSort {
  if (urgent) return "urgent";
  return column === "number" || column === "title" ? "created" : "deadline";
}

export type QuickComplete = { label: string; needsResult: boolean; openSubtasks: number };

/**
 * Кружок «выполнить» в строке списка: можно ли завершить отсюда и что
 * спросить по дороге (отчёт о результате, открытые подзадачи). У задачи с
 * «Принять работу после завершения» исполнитель отправляет на проверку.
 */
export function quickComplete(
  t: Pick<
    TaskRow,
    | "my_roles"
    | "status"
    | "requires_review"
    | "result_required"
    | "has_result"
    | "subtasks_total"
    | "subtasks_done"
  >,
): QuickComplete | null {
  const a = taskPerms(t).actions.find((x) => x.action === "complete");
  if (!a) return null;
  return {
    label: a.label,
    needsResult: t.result_required && !t.has_result,
    openSubtasks: Math.max(0, t.subtasks_total - t.subtasks_done),
  };
}

/** Почему срок не меняется — подпись под сроком в карточке. */
export function deadlineLockHint(
  t: Pick<TaskRow, "my_roles"> & { deadline_rule?: DeadlineRule; project_id?: string | null },
): string {
  if (t.my_roles.includes("assignee") && t.deadline_rule === "forbid")
    return t.project_id
      ? "В этом проекте срок меняет только постановщик"
      : "Срок этой задачи меняет только постановщик";
  return "Срок меняет постановщик";
}

/** «Задача #12 поставлена» / «Поставлено 3 задачи». */
export function createdText(numbers: number[]): string {
  return numbers.length === 1
    ? `Задача #${numbers[0]} поставлена`
    : `Поставлено ${numbers.length} ${plural(numbers.length, "задача", "задачи", "задач")}`;
}

/** Расписание регулярной задачи — подписи выбора. */
export const RECURRENCE_FREQS: { value: RecurrenceRule["freq"]; label: string }[] = [
  { value: "daily", label: "Каждый день" },
  { value: "workdays", label: "По рабочим дням" },
  { value: "weekly", label: "По дням недели" },
  { value: "monthly", label: "Каждый месяц" },
  { value: "after_close", label: "Через N дней после закрытия прежней" },
];

/** Черновик расписания в форме (числа — строками полей). */
export type RuleDraft = {
  freq: RecurrenceRule["freq"];
  weekdays: number[];
  monthday: string;
  afterDays: string;
};

/** Черновик из правила; без правила — по дням недели, сегодняшний день. */
export function ruleDraft(rule?: RecurrenceRule | null, today = new Date()): RuleDraft {
  const dow = today.getDay() === 0 ? 7 : today.getDay();
  return {
    freq: rule?.freq ?? "weekly",
    weekdays: rule?.freq === "weekly" ? [...rule.weekdays] : [dow],
    monthday: String(rule?.freq === "monthly" ? rule.monthday : today.getDate()),
    afterDays: String(rule?.freq === "after_close" ? rule.after_days : 1),
  };
}

/** Правило из черновика; ошибка — null. */
export function buildRule(d: RuleDraft): RecurrenceRule | null {
  if (d.freq === "weekly")
    return d.weekdays.length ? { freq: "weekly", weekdays: [...d.weekdays].sort() } : null;
  if (d.freq === "monthly") {
    const n = Number(d.monthday);
    return Number.isInteger(n) && n >= 1 && n <= 31 ? { freq: "monthly", monthday: n } : null;
  }
  if (d.freq === "after_close") {
    const n = Number(d.afterDays);
    return d.afterDays.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 365
      ? { freq: "after_close", after_days: n }
      : null;
  }
  return { freq: d.freq };
}

/**
 * Срок шаблона «через N рабочих дней» от `from` до `to` — обратное к
 * work_add_days базы (и `templateDeadline`): выходной `from` сначала
 * сдвигается на ближайший рабочий.
 */
export function workdaysBetween(from: string, to: string, cal: WorkCalendar): number {
  let n = 0;
  for (let d = nextWorkingDay(from, cal); d < to && n < 365; ) {
    d = addDays(d, 1);
    if (isWorking(d, cal)) n++;
  }
  return n;
}

/** Сортировка таблицы задач по колонкам (внутри загруженных строк). */
export function taskSortGetters(name: (id: string) => string): SortGetters<TaskRow> {
  return {
    number: (t) => t.number,
    title: (t) => t.title,
    deadline: (t) => (t.deadline ? new Date(t.deadline) : null),
    assignee: (t) => {
      const id = assigneeOf(t);
      return id ? name(id) : null;
    },
    creator: (t) => {
      const id = creatorOf(t);
      return id ? name(id) : null;
    },
    status: (t) => STATUS_ORDER.indexOf(t.status),
  };
}
