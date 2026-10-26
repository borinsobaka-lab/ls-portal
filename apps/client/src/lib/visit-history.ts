import type { ContentTranslations } from "@/i18n";

/**
 * История посещений клиента (главная → «История посещений»): прошедшие
 * занятия из журнала bookings_log — снимок занятия на момент записи, с
 * калориями (db/migrations/2026-10-12_zz_packages_app_fixes.sql). Журнал, а
 * не schedule_bookings + schedule_entries: занятие, отменённое студией, и
 * персональное клиенту по RLS не видны, а в журнале они есть.
 *
 * Здесь — только чистая логика (тесты — visit-history.test.ts); запрос —
 * visitHistoryQuery в src/lib/home-queries.ts.
 */

/** Статус в истории: посетил / отменено / пропущено / ещё не отмечено сотрудником. */
export type VisitStatus = "attended" | "cancelled" | "no_show" | "unmarked";

/** Статусы журнала, которые показываются в истории (лист ожидания — нет). */
export const HISTORY_LOG_STATUSES = [
  "attended",
  "completed",
  "no_show",
  "cancelled",
  "rejected",
  "booked",
] as const;

export type VisitTrainer = {
  id: string;
  full_name: string | null;
  translations?: ContentTranslations | null;
};

export type VisitWorkout = {
  id: string;
  name: string;
  type?: string | null;
  color?: string | null;
  translations?: ContentTranslations | null;
};

export type VisitRow = {
  id: string;
  entry_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  /** Снимок названия тренировки на момент записи (по-русски). */
  workout_name: string | null;
  workout_type: string | null;
  duration_min: number | null;
  calories: number | null;
  /** Тренировка с переводами — догружается по workout_id, если видна клиенту. */
  workout: VisitWorkout | null;
  /** Тренеры занятия — догружаются по entry_id, если занятие видно клиенту. */
  trainers: VisitTrainer[];
  /** Диагностика тела (пакетное): подпись «Диагностика тела», не тренировка. */
  diagnostic?: boolean;
};

/** Статус журнала → статус истории; лист ожидания и неизвестное — null. */
export function visitStatus(status: string): VisitStatus | null {
  switch (status) {
    case "attended":
    case "completed":
      return "attended";
    case "no_show":
      return "no_show";
    case "cancelled":
    case "rejected":
      return "cancelled";
    case "booked":
      return "unmarked";
    default:
      return null;
  }
}

/** Продолжительность в минутах: снимок журнала, без него — по времени занятия. */
export function visitMinutes(v: Pick<VisitRow, "duration_min" | "starts_at" | "ends_at">) {
  if (v.duration_min && v.duration_min > 0) return v.duration_min;
  const ms = new Date(v.ends_at).getTime() - new Date(v.starts_at).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : null;
}

/** Группы по месяцам (ключ — 1-е число месяца, локальное время), новые сверху. */
export function groupVisitsByMonth<T extends { starts_at: string }>(rows: T[]) {
  const groups = new Map<number, T[]>();
  for (const r of rows) {
    const d = new Date(r.starts_at);
    const key = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([ts, items]) => ({
      ts,
      items: items.sort(
        (a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime(),
      ),
    }));
}
