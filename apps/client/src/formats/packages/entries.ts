import type { WorkoutDrawerData } from "@/components/workout-drawer";
import { currentT, localizeRow, type ContentTranslations, type Translator } from "@/i18n";
import { mediaUrl } from "@/lib/media";
import { untypedDb } from "@/lib/untyped-db";
import {
  chunks,
  groupSubstitutions,
  replacedOf,
  type EntrySubstitution,
  type SubstitutionRow,
} from "./substitutions";

/**
 * Занятие расписания пакетного формата — как его выбирают расписание и
 * главная (одна карточка в обоих местах, решение владельца 2026-10-11).
 * Цвет тренировки — workouts.color (полоска слева), без типа и иконки.
 */
export type PackTrainer = {
  id: string;
  full_name: string | null;
  photo_url: string | null;
  /** Средний рейтинг (numeric — приходит строкой) и число оценок. */
  rating_avg?: number | string | null;
  rating_count?: number | null;
  /** Переводы имени (src/i18n/content.ts). */
  translations?: ContentTranslations | null;
};

export type PackEntry = {
  id: string;
  studio_id: string;
  /**
   * group — тренировка; diagnostic — диагностика тела (2026-10-15): клиент
   * видит только свои, на карточке — «Диагностика» и чёрная полоска.
   */
  kind?: string | null;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  booked_count: number;
  workout: {
    id: string;
    name: string;
    color: string | null;
    description: string | null;
    photo_url: string | null;
    capacity: number | null;
    translations?: ContentTranslations | null;
  } | null;
  trainers: { trainer: PackTrainer | null }[] | null;
  /**
   * Замены тренера (schedule_entry_substitutions, 2026-10-13): тренер
   * занятия trainer_id заменяет replaced. Догружаются отдельно —
   * attachSubstitutions.
   */
  substitutions?: EntrySubstitution<PackTrainer>[];
};

/** select для schedule_entries (и вложенного entry в schedule_bookings). */
export const PACK_ENTRY_SELECT =
  "id, studio_id, kind, starts_at, ends_at, capacity, booked_count, workout:workouts(id, name, color, description, photo_url, capacity, translations), trainers:schedule_entry_trainers(trainer:trainers(id, full_name, photo_url, rating_avg, rating_count, translations))";

/**
 * Замены тренеров к занятиям — отдельным запросом, а не в PACK_ENTRY_SELECT:
 * если таблицы замен в базе ещё нет (клиент выкатился раньше миграции) или
 * запрос не прошёл, расписание показывается как раньше, без пометок.
 */
export async function attachSubstitutions<T extends PackEntry>(entries: T[]): Promise<T[]> {
  const ids = entries.map((e) => e.id);
  if (ids.length === 0) return entries;
  try {
    const parts = await Promise.all(
      chunks(ids, 100).map((part) =>
        untypedDb
          .from("schedule_entry_substitutions")
          .select(
            "entry_id, trainer_id, replaced:trainers(id, full_name, photo_url, rating_avg, rating_count, translations)",
          )
          .in("entry_id", part),
      ),
    );
    if (parts.some((r) => r.error || !r.data)) return entries;
    const byEntry = groupSubstitutions(
      parts.flatMap((r) => r.data as SubstitutionRow<PackTrainer>[]),
    );
    return entries.map((e) => (byEntry.has(e.id) ? { ...e, substitutions: byEntry.get(e.id) } : e));
  } catch {
    return entries;
  }
}

/** Кого заменяет тренер занятия; не замена — null. */
export function replacedTrainer(e: PackEntry, trainerId: string): PackTrainer | null {
  return replacedOf(e.substitutions, trainerId);
}

export function entryTrainers(e: PackEntry): PackTrainer[] {
  return (e.trainers ?? []).map((t) => t.trainer).filter((t): t is PackTrainer => !!t);
}

/** Средний рейтинг тренера; нет оценок — null. */
export function trainerRating(t: PackTrainer): number | null {
  if (t.rating_avg == null || !t.rating_count) return null;
  const n = Number(t.rating_avg);
  return Number.isFinite(n) ? n : null;
}

export function trainerPhoto(t: PackTrainer) {
  return mediaUrl(t.photo_url, "trainer-photos");
}

export function trainerInitials(name: string | null) {
  const parts = (name ?? "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Полоска диагностики — чёрная (решение владельца 2026-10-15). */
export const DIAGNOSTIC_COLOR = "#000000";

export function isDiagnostic(e: Pick<PackEntry, "kind">) {
  return e.kind === "diagnostic";
}

/** Цвет полоски: цвет тренировки (#rrggbb), без него — серый; диагностика — чёрный. */
export function entryColor(e: PackEntry): string | null {
  if (isDiagnostic(e)) return DIAGNOSTIC_COLOR;
  const c = e.workout?.color?.trim();
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/** Продолжительность в минутах. */
export function durationMinutes(e: { starts_at: string; ends_at: string }) {
  const ms = new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : null;
}

/** Свободных мест; null — без ограничения (вместимость пусто/0, как в записи). */
export function spotsLeft(e: PackEntry): number | null {
  const cap = e.capacity ?? e.workout?.capacity ?? null;
  if (cap == null || cap <= 0) return null;
  return Math.max(0, cap - e.booked_count);
}

/** «Свободно 5 мест» / «Мест нет»; без ограничения — null. */
export function spotsLabel(e: PackEntry, t: Translator = currentT()): string | null {
  const left = spotsLeft(e);
  if (left === null) return null;
  if (left === 0) return t("Мест нет");
  return t.plural(left, "Свободно {n} место|Свободно {n} места|Свободно {n} мест");
}

export function fmtTime(iso: string, t: Translator = currentT()) {
  return t.time(iso);
}

/**
 * Данные шторки тренировки — на языке клиента (переводы тренировки и
 * тренеров, src/i18n/content.ts). t — из компонента (useT()); по умолчанию —
 * текущий язык браузера.
 */
export function packEntryToDrawerData(e: PackEntry, t: Translator = currentT()): WorkoutDrawerData {
  const workout = localizeRow(e.workout, t.locale);
  const trainers = entryTrainers(e).map((tr) => localizeRow(tr, t.locale));
  const diagnostic = isDiagnostic(e);
  return {
    id: e.id,
    name: diagnostic ? t("Диагностика") : (workout?.name ?? t("Тренировка")),
    type: null,
    description: diagnostic ? diagnosticDescription(t) : (workout?.description ?? null),
    photo: mediaUrl(workout?.photo_url, "workout-photos"),
    trainerName:
      trainers
        .map((tr) => tr.full_name)
        .filter(Boolean)
        .join(", ") || null,
    trainerPhoto: trainers.map(trainerPhoto).find(Boolean) ?? null,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    color: entryColor(e),
    trainers: trainers.map((tr) => {
      const was = replacedTrainer(e, tr.id);
      const old = was ? localizeRow(was, t.locale) : null;
      return {
        id: tr.id,
        name: tr.full_name ?? t("Тренер"),
        photo: trainerPhoto(tr),
        rating: trainerRating(tr),
        replaced: old
          ? { id: old.id, name: old.full_name ?? t("Тренер"), photo: trainerPhoto(old) }
          : null,
      };
    }),
    spotsLabel: spotsLabel(e, t),
    spotsLeft: spotsLeft(e),
    studioId: e.studio_id,
  };
}

/**
 * Что такое диагностика тела — описание в окне диагностики и во вкладке
 * «Диагностика» расписания (текст владельца 2026-10-15, с разметкой).
 */
export function diagnosticDescription(t: Translator = currentT()) {
  return [
    t("Индивидуальная встреча с тренером, чтобы тренировки давали лучший результат."),
    "",
    "- " + t("Заполняем анкету: цели, здоровье, ограничения."),
    "- " + t("Делаем замеры и тест на баланс."),
    "- " +
      t(
        "Тренер составляет персональные рекомендации: с какой интенсивностью заниматься, на что обращать внимание и как восстанавливаться.",
      ),
    "",
    t(
      "По результатам вы получаете свою персональную диагностическую карту — страничку с целями, замерами и планом тренировок.",
    ),
  ].join("\n");
}
