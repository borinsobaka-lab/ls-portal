/**
 * Задачи — запросы и кэш (RPC task_* из db/migrations/2026-11-08_zz_tasks.sql).
 *
 * - Список — ["tasks", "list", параметры], карточка — ["tasks", "card",
 *   номер], история — ["tasks", "history", id], счётчики —
 *   ["tasks", "counters"], фильтры — ["tasks", "filters"].
 * - После любой записи — invalidateTasks (весь ["tasks"]). Живое обновление:
 *   событие Realtime «task» в личной теме (lib/chats/realtime.ts) делает то
 *   же; нет соединения — опрос (список раз в 30 с, карточка раз в 15 с).
 * - Срок и «день» — в поясе человека (настройки уведомлений:
 *   portal_settings_get — timezone, workday_end); производственный
 *   календарь — work_calendar_range.
 */
import { keepPreviousData, queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useRealtimeConnected } from "@/lib/chats/realtime-state";
import { usePortalSettings } from "@/lib/notifications/data";
import { unwrap } from "@/lib/query";
import { addDays, localDay, filtersToParams, type WorkCalendar } from "./logic";
import type {
  Project,
  ProjectFull,
  Recurrence,
  SavedFilter,
  Subordinate,
  TaskCounters,
  TaskEvent,
  TaskFilters,
  TaskFull,
  TaskPlan,
  TaskRow,
  TaskTagInfo,
  TaskTemplate,
} from "./types";
import type { DayKind } from "./work-calendar";

export const TASK_BUCKET = "task-files";

export async function taskRpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  return (await unwrap<T>(supabase.rpc(fn, args))) as T;
}

export const invalidateTasks = (qc: QueryClient) => qc.invalidateQueries({ queryKey: ["tasks"] });

const normalize = <T extends TaskRow>(t: T): T => ({
  ...t,
  number: Number(t.number),
  check_total: Number(t.check_total),
  check_done: Number(t.check_done),
  files_count: Number(t.files_count),
});

// ---- Чтение ----------------------------------------------------------------------

export const PAGE_SIZE = 100;

export function useTaskList(filters: TaskFilters, pages = 1) {
  const live = useRealtimeConnected();
  const params = filtersToParams(filters, 0, PAGE_SIZE * pages);
  return useQuery({
    queryKey: ["tasks", "list", params],
    queryFn: async () => {
      const r = await taskRpc<{ rows: TaskRow[]; has_more: boolean }>("task_list", { p: params });
      return { rows: r.rows.map(normalize), hasMore: r.has_more };
    },
    placeholderData: keepPreviousData,
    refetchInterval: live ? 120_000 : 30_000,
    meta: { errorMessage: "Не удалось загрузить задачи" },
  });
}

export const taskCardQuery = (number: number) =>
  queryOptions({
    queryKey: ["tasks", "card", number],
    queryFn: async () => normalize(await taskRpc<TaskFull>("task_get", { p_number: number })),
    retry: false,
  });

export function useTaskCard(number: number | null) {
  const live = useRealtimeConnected();
  return useQuery({
    ...taskCardQuery(number ?? 0),
    enabled: !!number,
    refetchInterval: live ? false : 15_000,
  });
}

export function useTaskHistory(taskId: string | null) {
  return useQuery({
    queryKey: ["tasks", "history", taskId],
    queryFn: () => taskRpc<TaskEvent[]>("task_history", { p_task: taskId }),
    enabled: !!taskId,
    meta: { errorMessage: "Не удалось загрузить историю" },
  });
}

export function useTaskCounters(enabled = true): TaskCounters {
  const live = useRealtimeConnected();
  const { data } = useQuery({
    queryKey: ["tasks", "counters"],
    queryFn: () => taskRpc<TaskCounters>("task_counters"),
    refetchInterval: live ? 120_000 : 30_000,
    refetchOnWindowFocus: true,
    enabled,
  });
  return data ?? { overdue: 0, review: 0, unseen: 0, badge: 0 };
}

export const taskFiltersQuery = queryOptions({
  queryKey: ["tasks", "filters"],
  queryFn: async () => (await taskRpc<SavedFilter[] | null>("task_filters_list")) ?? [],
  staleTime: 5 * 60_000,
});

/** Пояс и конец рабочего дня человека (по умолчанию Москва, 18:00). */
export function useTaskClock() {
  const { data } = usePortalSettings();
  return {
    tz: data?.timezone ?? "Europe/Moscow",
    workdayEnd: data?.workday_end ?? "18:00",
  };
}

/** Производственный календарь на полгода от сегодня (и месяц назад). */
export function useWorkCalendar(tz: string): WorkCalendar {
  const today = localDay(new Date(), tz);
  const from = addDays(today, -31);
  const to = addDays(today, 200);
  const { data } = useQuery({
    queryKey: ["tasks", "calendar", from.slice(0, 7)],
    queryFn: () =>
      taskRpc<{ day: string; kind: DayKind }[]>("work_calendar_range", { p_from: from, p_to: to }),
    staleTime: 6 * 60 * 60_000,
  });
  return useMemo(() => new Map((data ?? []).map((d) => [d.day, d.kind])), [data]);
}

// ---- Проекты, «Подчинённые», шаблоны, регулярные (веха 4) ---------------------------

export const projectsQuery = queryOptions({
  queryKey: ["tasks", "projects"],
  queryFn: async () =>
    ((await taskRpc<Project[] | null>("task_projects_list")) ?? []).map((p) => ({
      ...p,
      member_count: Number(p.member_count),
      open_count: Number(p.open_count),
      overdue_count: Number(p.overdue_count),
    })),
  staleTime: 60_000,
  meta: { errorMessage: "Не удалось загрузить проекты" },
});

/** Проекты, где я участник и которые не в архиве, — для выбора в формах. */
export function useMyProjects() {
  const { data = [] } = useQuery(projectsQuery);
  return useMemo(() => data.filter((p) => p.my_role && !p.archived_at), [data]);
}

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: ["tasks", "project", id],
    queryFn: () => taskRpc<ProjectFull>("task_project_get", { p_project: id }),
    retry: false,
  });

export const subordinatesQuery = queryOptions({
  queryKey: ["tasks", "subordinates"],
  queryFn: async () => (await taskRpc<Subordinate[] | null>("task_subordinates")) ?? [],
  meta: { errorMessage: "Не удалось загрузить подчинённых" },
});

export const templatesQuery = queryOptions({
  queryKey: ["tasks", "templates"],
  queryFn: async () => (await taskRpc<TaskTemplate[] | null>("task_templates_list")) ?? [],
  meta: { errorMessage: "Не удалось загрузить шаблоны" },
});

export const recurrencesQuery = queryOptions({
  queryKey: ["tasks", "recurrences"],
  queryFn: async () => (await taskRpc<Recurrence[] | null>("task_recurrences_list")) ?? [],
  meta: { errorMessage: "Не удалось загрузить регулярные задачи" },
});

// ---- Теги (2026-11-08_zzzzzzzzz_task_tags.sql) --------------------------------------

export const tagsQuery = queryOptions({
  queryKey: ["tasks", "tags"],
  queryFn: async () => (await taskRpc<TaskTagInfo[] | null>("task_tags_list")) ?? [],
  staleTime: 5 * 60_000,
});

/** Новый тег (или тот же по имени) — id. */
export async function createTag(qc: QueryClient, name: string, color: string | null) {
  const id = await taskRpc<string>("task_tag_save", { p_id: null, p_name: name, p_color: color });
  await qc.invalidateQueries({ queryKey: ["tasks", "tags"] });
  return id;
}

export const setTaskTags = (qc: QueryClient, t: Pick<TaskFull, "id" | "number">, ids: string[]) =>
  withCard(qc, t.number, () => taskRpc<TaskFull>("task_set_tags", { p_task: t.id, p_tags: ids }));

// ---- «Мой план» (2026-11-08_zzzzzzz_task_plan.sql) -----------------------------------

export const PLAN_KEY = ["tasks", "plan"] as const;

export function useTaskPlan() {
  const live = useRealtimeConnected();
  return useQuery({
    queryKey: PLAN_KEY,
    queryFn: async () => {
      const p = await taskRpc<TaskPlan>("task_plan_get");
      return { ...p, cards: p.cards.map((c) => ({ ...c, task: normalize(c.task) })) };
    },
    refetchInterval: live ? 120_000 : 30_000,
    meta: { errorMessage: "Не удалось загрузить план" },
  });
}

/** Колонка и порядок карточек после перетаскивания — сразу на экране. */
export async function placePlanCards(qc: QueryClient, column: string | null, taskIds: string[]) {
  qc.setQueryData<TaskPlan>(PLAN_KEY, (p) => {
    if (!p) return p;
    const order = new Map(taskIds.map((id, i) => [id, i]));
    return {
      ...p,
      cards: p.cards.map((c) =>
        order.has(c.task.id) ? { ...c, column_id: column, sort_order: order.get(c.task.id)! } : c,
      ),
    };
  });
  try {
    await taskRpc("task_plan_place", { p_column: column, p_tasks: taskIds });
  } finally {
    void qc.invalidateQueries({ queryKey: PLAN_KEY });
  }
}

export const planAction = async (qc: QueryClient, fn: string, args: Record<string, unknown>) => {
  const r = await taskRpc(fn, args);
  await qc.invalidateQueries({ queryKey: PLAN_KEY });
  return r;
};

// ---- Ошибки -----------------------------------------------------------------------

export function taskErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    task_not_found: "Задача не найдена или нет доступа",
    task_forbidden: "Это может только постановщик задачи",
    task_status_forbidden: "Это действие сейчас недоступно",
    task_title_invalid: "Название — от 1 до 300 символов",
    task_reason_required: "Напишите причину переноса срока",
    task_comment_required: "Напишите, что исправить",
    task_bad_assignee: "Выберите исполнителя",
    task_too_many_assignees: "Не больше 300 исполнителей за раз",
    task_no_deadline: "У задачи нет срока — поставьте время напоминания",
    task_bad_reminder: "Выберите время напоминания",
    task_too_many_reminders: "Не больше 10 напоминаний",
    task_item_invalid: "Пункт — от 1 до 1000 символов",
    task_too_many_items: "Не больше 200 пунктов в чек-листе",
    task_too_many_checklists: "Не больше 20 чек-листов",
    task_too_many_files: "Не больше 200 файлов у задачи",
    task_bad_file: "Файл не подходит",
    task_filter_invalid: "Название фильтра — до 60 символов",
    task_plan_column_invalid: "Название колонки — от 1 до 40 символов",
    task_tag_invalid: "Тег — от 1 до 40 символов",
    task_tag_exists: "Такой тег уже есть",
    task_tag_forbidden: "Этот тег правит тот, кто его завёл",
    task_too_many_tags: "Не больше 10 тегов у задачи",
    task_plan_too_many_columns: "Не больше 10 колонок",
    task_plan_column_not_found: "Колонка не найдена",
    task_result_required: "Сначала напишите результат — постановщик просил его",
    task_result_invalid: "Результат — до 5000 символов",
    task_parent_invalid: "Задача не может быть подзадачей самой себя или своей подзадачи",
    task_source_invalid: "Сообщение не найдено или вы не в этом чате",
    task_too_many_filters: "Не больше 30 фильтров",
    project_forbidden: "Это может только владелец или модератор проекта",
    task_project_move_forbidden:
      "Перенести задачу в проект может её постановщик или тот, кто ведёт её нынешний проект",
    project_not_found: "Проект не найден или закрыт",
    project_title_invalid: "Название проекта — от 1 до 120 символов",
    project_last_owner: "У проекта должен остаться владелец",
    project_unit_member:
      "Этот человек — из подразделения проекта: уберите его в оргструктуре или отвяжите подразделение",
    project_bad_role: "Такой роли нет",
    stage_title_invalid: "Название стадии — до 60 символов",
    too_many_stages: "Не больше 20 стадий",
    last_stage: "Последнюю стадию не удалить",
    template_forbidden: "Этот шаблон вам не изменить",
    template_name_invalid: "Название шаблона — до 120 символов",
    recurrence_invalid: "Проверьте расписание",
    recurrence_forbidden: "Это не ваша регулярная задача",
    too_many_recurrences: "Не больше 100 регулярных задач",
  };
  for (const [k, v] of Object.entries(map)) if (msg.includes(k)) return v;
  return msg;
}

// ---- Запись ------------------------------------------------------------------------

export type NewTask = {
  title: string;
  description?: unknown[] | null;
  deadline?: string | null;
  urgent?: boolean;
  requires_review?: boolean;
  assignees: string[];
  mode?: "shared" | "separate";
  coassignees?: string[];
  watchers?: string[];
  checklists?: { title: string; items: { text: string; assignee_id?: string | null }[] }[];
  files?: {
    path: string;
    name: string;
    mime: string;
    size: number;
    width?: number;
    height?: number;
  }[];
  reminder?: { remind_at?: string; before_minutes?: number } | null;
  project_id?: string | null;
  /** Теги — ставятся сразу после постановки. */
  tags?: string[];
  /** Подзадача к задаче. */
  parent_id?: string | null;
  /** Задача из сообщения чата. */
  source?: { chat_id: string; seq: number } | null;
  result_required?: boolean;
};

export async function createTask(qc: QueryClient, t: NewTask) {
  const r = await taskRpc<{ tasks: { id: string; number: number }[]; batch_id: string | null }>(
    "task_create",
    { p: t },
  );
  if (t.tags?.length)
    await Promise.all(
      r.tasks.map((x) => taskRpc("task_set_tags", { p_task: x.id, p_tags: t.tags })),
    );
  void invalidateTasks(qc);
  return { ...r, tasks: r.tasks.map((x) => ({ ...x, number: Number(x.number) })) };
}

/** Записать и положить свежую карточку в кэш. */
async function withCard(qc: QueryClient, number: number, run: () => Promise<TaskFull | void>) {
  const card = await run();
  if (card) qc.setQueryData(["tasks", "card", number], normalize(card));
  void invalidateTasks(qc);
}

export const updateTask = (
  qc: QueryClient,
  t: Pick<TaskFull, "id" | "number">,
  patch: Record<string, unknown>,
  reason?: string,
) =>
  withCard(qc, t.number, () =>
    taskRpc<TaskFull>("task_update", { p_task: t.id, p: patch, p_reason: reason ?? null }),
  );

export const setTaskStatus = (
  qc: QueryClient,
  t: Pick<TaskFull, "id" | "number">,
  action: string,
  comment?: string,
) =>
  withCard(qc, t.number, () =>
    taskRpc<TaskFull>("task_set_status", {
      p_task: t.id,
      p_action: action,
      p_comment: comment ?? null,
    }),
  );

export const setTaskResult = (qc: QueryClient, t: Pick<TaskFull, "id" | "number">, text: string) =>
  withCard(qc, t.number, () =>
    taskRpc<TaskFull>("task_set_result", { p_task: t.id, p_text: text }),
  );

export const taskAction = async (qc: QueryClient, fn: string, args: Record<string, unknown>) => {
  const r = await taskRpc(fn, args);
  void invalidateTasks(qc);
  return r;
};
