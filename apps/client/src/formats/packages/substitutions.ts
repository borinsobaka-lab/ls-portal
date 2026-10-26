/**
 * Замена тренера в приложении пакетов (2026-10-13): тренер занятия
 * (trainer_id) заменяет replaced — на карточке пометка «Замена», в окне
 * тренировки прежний тренер неактивным. Строки — schedule_entry_substitutions
 * (замены заводит админка); здесь только разбор ответа, без запросов.
 */

export type SubstitutionRow<T> = {
  entry_id: string;
  trainer_id: string;
  /** Связь «многие к одному»; без схемы базы разбор select может дать массив. */
  replaced: T | T[] | null;
};

export type EntrySubstitution<T> = { trainer_id: string; replaced: T | null };

/** Замены по занятиям: entry_id → [{ trainer_id, replaced }]. */
export function groupSubstitutions<T>(
  rows: SubstitutionRow<T>[],
): Map<string, EntrySubstitution<T>[]> {
  const byEntry = new Map<string, EntrySubstitution<T>[]>();
  for (const r of rows) {
    const replaced = Array.isArray(r.replaced) ? (r.replaced[0] ?? null) : r.replaced;
    byEntry.set(r.entry_id, [
      ...(byEntry.get(r.entry_id) ?? []),
      { trainer_id: r.trainer_id, replaced },
    ]);
  }
  return byEntry;
}

/** Кого заменяет тренер занятия; не замена (или прежний тренер не виден) — null. */
export function replacedOf<T>(
  substitutions: EntrySubstitution<T>[] | undefined,
  trainerId: string,
): T | null {
  return substitutions?.find((s) => s.trainer_id === trainerId)?.replaced ?? null;
}

/** id занятий порциями: длинный список в одном запросе упёрся бы в длину адреса. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
