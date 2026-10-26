/**
 * Тренеры занятия и замены (пакетные клубы, 2026-10-13): правка списка
 * тренеров в окне занятия и что сохранить в базу. Замена —
 * schedule_entry_substitutions: тренер занятия (trainer_id) заменяет
 * replaced_trainer_id; клиенты видят её в приложении. «Редактировать» —
 * просто другой тренер, без следа в приложении.
 */

/** Замена у тренера занятия, как её отдаёт select (связь 1:1 — объект или массив). */
export type SubstitutionRow = {
  replaced_trainer_id: string;
  replaced: { full_name: string } | null;
};

export type EntryTrainerLink = {
  trainer_id: string;
  substitution?: SubstitutionRow | SubstitutionRow[] | null;
};

/** Тренер занятия → кого он заменяет. */
export type SubsMap = Record<string, { id: string; name: string | null }>;

/** Тренеры занятия по порядку и их замены. */
export type TrainerAssignment = { ids: string[]; subs: SubsMap };

export function substitutionsOf(links: EntryTrainerLink[] | null | undefined): SubsMap {
  const subs: SubsMap = {};
  for (const x of links ?? []) {
    const sub = Array.isArray(x.substitution) ? x.substitution[0] : x.substitution;
    if (sub)
      subs[x.trainer_id] = { id: sub.replaced_trainer_id, name: sub.replaced?.full_name ?? null };
  }
  return subs;
}

/**
 * Тренеры для копии занятия: замена разовая — в копию идёт тот, кого
 * заменили, а не заменяющий.
 */
export function regularTrainerIds(links: EntryTrainerLink[] | null | undefined): string[] {
  const subs = substitutionsOf(links);
  return Array.from(new Set((links ?? []).map((x) => subs[x.trainer_id]?.id ?? x.trainer_id)));
}

export type PickMode = "replace" | "edit" | "add";

/**
 * Выбрали тренера id в строке index:
 * - add — новый тренер в конец списка;
 * - edit — другой тренер на месте прежнего; если прежний сам был заменой, новый
 *   заменяет того же (иначе замена молча пропала бы);
 * - replace — замена: новый тренер вместо прежнего; замена замены — всё ещё
 *   вместо первого; выбрали того, кого заменяли, — замены больше нет.
 */
export function pickTrainer(
  state: TrainerAssignment,
  index: number,
  id: string,
  mode: PickMode,
  nameOf: (id: string) => string | null,
): TrainerAssignment {
  if (mode === "add") {
    if (state.ids.includes(id)) return state;
    return { ids: [...state.ids, id], subs: state.subs };
  }
  const old = state.ids[index];
  if (old === undefined || id === old || state.ids.includes(id)) return state;
  const subs = { ...state.subs };
  delete subs[old];
  const original = state.subs[old] ?? { id: old, name: nameOf(old) };
  if (mode === "replace" && original.id !== id) subs[id] = original;
  if (mode === "edit" && state.subs[old] && state.subs[old].id !== id) subs[id] = state.subs[old];
  return { ids: state.ids.map((t, i) => (i === index ? id : t)), subs };
}

/**
 * «Отменить замену»: на место заменяющего возвращается прежний тренер; если
 * прежний и так стоит на занятии — заменяющий просто уходит.
 */
export function undoSubstitution(state: TrainerAssignment, index: number): TrainerAssignment {
  const id = state.ids[index];
  const original = id !== undefined ? state.subs[id] : undefined;
  if (!original) return state;
  const subs = { ...state.subs };
  delete subs[id];
  return {
    ids: state.ids.includes(original.id)
      ? state.ids.filter((_, i) => i !== index)
      : state.ids.map((t, i) => (i === index ? original.id : t)),
    subs,
  };
}

/** Убрать тренера с занятия (вместе с его заменой). */
export function removeTrainer(state: TrainerAssignment, index: number): TrainerAssignment {
  const id = state.ids[index];
  if (id === undefined) return state;
  const subs = { ...state.subs };
  delete subs[id];
  return { ids: state.ids.filter((_, i) => i !== index), subs };
}

/**
 * Что записать в базу при сохранении: какие связи тренеров снять и добавить
 * (только разница — оставшиеся сохраняют замену; снятый тренер уносит её
 * сам, каскадом) и какие замены удалить и записать.
 */
export function trainerChanges(before: TrainerAssignment, after: TrainerAssignment) {
  const removed = before.ids.filter((t) => !after.ids.includes(t));
  const added = after.ids.filter((t) => !before.ids.includes(t));
  const dropSubs = after.ids.filter(
    (t) => before.ids.includes(t) && before.subs[t] && !after.subs[t],
  );
  const putSubs = after.ids
    .filter((t) => after.subs[t] && after.subs[t].id !== before.subs[t]?.id)
    .map((trainer_id) => ({ trainer_id, replaced_trainer_id: after.subs[trainer_id].id }));
  return { removed, added, dropSubs, putSubs };
}
