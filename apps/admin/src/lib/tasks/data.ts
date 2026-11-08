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
import type { SavedFilter, TaskCounters, TaskEvent, TaskFilters, TaskFull, TaskRow } from "./types";
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
    task_too_many_filters: "Не больше 30 фильтров",
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
};

export async function createTask(qc: QueryClient, t: NewTask) {
  const r = await taskRpc<{ tasks: { id: string; number: number }[]; batch_id: string | null }>(
    "task_create",
    { p: t },
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

export const taskAction = async (qc: QueryClient, fn: string, args: Record<string, unknown>) => {
  const r = await taskRpc(fn, args);
  void invalidateTasks(qc);
  return r;
};
