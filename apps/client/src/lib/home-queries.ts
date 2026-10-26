import { queryOptions } from "@tanstack/react-query";

import { PACK_ENTRY_SELECT, attachSubstitutions, type PackEntry } from "@/formats/packages/entries";
import { chunks } from "@/formats/packages/substitutions";
import type { ContentTranslations } from "@/i18n";
import { untypedDb } from "@/lib/untyped-db";
import { IS_PACKAGES } from "@/lib/terms";
import {
  HISTORY_LOG_STATUSES,
  type VisitRow,
  type VisitTrainer,
  type VisitWorkout,
} from "@/lib/visit-history";

type Trainer = {
  id: string;
  full_name: string | null;
  photo_url: string | null;
  translations?: ContentTranslations | null;
};

export type MyBooking = {
  entry_id: string;
  entry: {
    id: string;
    starts_at: string;
    ends_at: string;
    workout: {
      name: string;
      type: string | null;
      description: string | null;
      photo_url: string | null;
      translations?: ContentTranslations | null;
    } | null;
    trainers: { trainer: Trainer | null }[] | null;
  } | null;
};

/**
 * Предстоящие записи клиента — блок «Тренировки» на главной. Вынесен из
 * routes/index.tsx, чтобы каркас (__root.tsx) запрашивал его сразу после
 * входа, параллельно с проверкой анкеты, а не после неё.
 */
export function homeBookingsQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["home-bookings", userId],
    queryFn: async (): Promise<MyBooking[]> => {
      // Явный фильтр по user_id: RLS позволяет тренеру видеть все брони студии,
      // и без него у сотрудника в клиентском приложении чужие записи выглядели
      // бы как его собственные.
      // Только предстоящие (через !inner-связь с занятием) — без всей истории
      // броней; групповые неотменённые — как в расписании. Пакетное — и свои
      // диагностики (2026-10-15): отдельная карточка «Диагностика».
      const { data, error } = await untypedDb
        .from("schedule_bookings")
        .select(
          IS_PACKAGES
            ? // Пакетное — карточка как в расписании: цвет, места, фото тренеров.
              `entry_id, entry:schedule_entries!inner(${PACK_ENTRY_SELECT})`
            : "entry_id, entry:schedule_entries!inner(id, starts_at, ends_at, workout:workouts(name, type, description, photo_url, translations), trainers:schedule_entry_trainers(trainer:trainers(id, full_name, photo_url, translations)))",
        )
        .eq("user_id", userId)
        .eq("status", "booked")
        .gte("entry.starts_at", new Date().toISOString())
        .in("entry.kind", IS_PACKAGES ? ["group", "diagnostic"] : ["group"])
        .is("entry.cancelled_at", null)
        .limit(50);
      if (error) throw error;
      const rows = (data as unknown as MyBooking[] | null) ?? [];
      if (!IS_PACKAGES) return rows;
      // Пакетное: пометка «Замена» у тренера — как в расписании.
      const entries = await attachSubstitutions(
        rows.flatMap((r) => (r.entry ? [r.entry as unknown as PackEntry] : [])),
      );
      const byId = new Map(entries.map((e) => [e.id, e]));
      return rows.map((r) =>
        r.entry ? { ...r, entry: (byId.get(r.entry.id) ?? r.entry) as MyBooking["entry"] } : r,
      );
    },
    enabled: !!userId,
  });
}

type VisitLogRow = Omit<VisitRow, "workout" | "trainers"> & { workout_id: string | null };

/**
 * История посещений (главная → «История посещений», src/lib/visit-history.ts):
 * прошедшие занятия клиента из журнала bookings_log, новые сверху. Название
 * тренировки с переводами и тренеры — отдельными запросами: если они не
 * прошли (или занятие клиенту не видно — отменено студией, персональное),
 * остаются снимок названия из журнала и пустой тренер.
 */
export function visitHistoryQuery(userId: string | null) {
  return queryOptions({
    queryKey: ["visit-history", userId],
    queryFn: async (): Promise<VisitRow[]> => {
      // Явный фильтр по user_id: тренеру RLS отдаёт весь журнал студии.
      const { data, error } = await untypedDb
        .from("bookings_log")
        .select(
          "id, entry_id, workout_id, workout_name, workout_type, starts_at, ends_at, status, duration_min, calories",
        )
        .eq("user_id", userId)
        .lt("starts_at", new Date().toISOString())
        .in("status", HISTORY_LOG_STATUSES)
        .order("starts_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      const rows = (data as VisitLogRow[] | null) ?? [];

      const workoutIds = [...new Set(rows.flatMap((r) => (r.workout_id ? [r.workout_id] : [])))];
      const entryIds = [...new Set(rows.flatMap((r) => (r.entry_id ? [r.entry_id] : [])))];
      const [workouts, trainers, diagnostics] = await Promise.all([
        fetchByIds(workoutIds, async (part) => {
          const res = await untypedDb
            .from("workouts")
            .select("id, name, type, color, translations")
            .in("id", part);
          return (res.data as VisitWorkout[] | null) ?? [];
        }),
        fetchByIds(entryIds, async (part) => {
          const res = await untypedDb
            .from("schedule_entry_trainers")
            .select("entry_id, trainer:trainers(id, full_name, translations)")
            .in("entry_id", part);
          return (res.data as { entry_id: string; trainer: VisitTrainer | null }[] | null) ?? [];
        }),
        userId ? fetchMyDiagnosticEntryIds(userId) : Promise.resolve(new Set<string>()),
      ]);
      const workoutById = new Map(workouts.map((w) => [w.id, w]));
      const trainersByEntry = new Map<string, VisitTrainer[]>();
      for (const row of trainers) {
        if (!row.trainer) continue;
        const arr = trainersByEntry.get(row.entry_id) ?? [];
        arr.push(row.trainer);
        trainersByEntry.set(row.entry_id, arr);
      }
      return rows.map(({ workout_id, ...r }) => ({
        ...r,
        workout: (workout_id && workoutById.get(workout_id)) || null,
        trainers: (r.entry_id && trainersByEntry.get(r.entry_id)) || [],
        diagnostic: !!r.entry_id && diagnostics.has(r.entry_id),
      }));
    },
    enabled: !!userId,
  });
}

/**
 * Занятия-диагностики тела, на которые клиент записан (пакетное, 2026-10-15):
 * в журнале bookings_log вида занятия нет, а диагностика — не тренировка
 * (история посещений подписывает её, статистика не считает). Свои
 * диагностики клиенту видны (RLS «… own diagnostic»); сбой или база без
 * миграции — пусто.
 */
export async function fetchMyDiagnosticEntryIds(userId: string): Promise<Set<string>> {
  if (!IS_PACKAGES) return new Set();
  try {
    const { data, error } = await untypedDb
      .from("schedule_bookings")
      .select("entry_id, entry:schedule_entries!inner(kind)")
      .eq("user_id", userId)
      .eq("entry.kind", "diagnostic");
    if (error || !data) return new Set();
    return new Set((data as { entry_id: string }[]).map((r) => r.entry_id));
  } catch {
    return new Set();
  }
}

/** Догрузка по id частями; сбой — пустой список (история показывается и без этого). */
async function fetchByIds<T>(ids: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  if (ids.length === 0) return [];
  try {
    return (await Promise.all(chunks(ids, 100).map(load))).flat();
  } catch {
    return [];
  }
}
