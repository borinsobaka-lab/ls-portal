import type { StudioFormat } from "@/lib/studio-formats";

/**
 * Фильтр «Клубы» дашборда: показатели считаются суммарно по выбранным
 * клубам, а выбрать можно только клубы одного формата — аналитика у
 * форматов будет расходиться. Варианты: один клуб, несколько, все клубы
 * формата. Без выбора (null) — клуб из шапки. Без React (тест —
 * dashboard-clubs.test.ts).
 */

export type ClubLite = { id: string; name: string; format: StudioFormat };

/** Клуб по умолчанию: выбранный в шапке, если дашборд в нём открыт, иначе первый. */
export function defaultClubId(clubs: ClubLite[], activeId: string | null): string | null {
  return clubs.find((c) => c.id === activeId)?.id ?? clubs[0]?.id ?? null;
}

/**
 * Выбранные клубы: сохранённый выбор без недоступных и чужого формата
 * (формат — у первого); пусто или не выбрано — клуб по умолчанию.
 */
export function resolveClubIds(
  clubs: ClubLite[],
  activeId: string | null,
  chosen: string[] | null,
): string[] {
  const byId = new Map(clubs.map((c) => [c.id, c]));
  const valid = (chosen ?? []).filter((id) => byId.has(id));
  const format = valid.length ? byId.get(valid[0])!.format : null;
  const same = valid.filter((id) => byId.get(id)!.format === format);
  if (same.length) return clubs.filter((c) => same.includes(c.id)).map((c) => c.id);
  const fallback = defaultClubId(clubs, activeId);
  return fallback ? [fallback] : [];
}

/**
 * Отметить / снять клуб. Клуб другого формата заменяет выбор целиком;
 * последний клуб снять нельзя — показатели всегда хотя бы по одному.
 */
export function toggleClub(clubs: ClubLite[], selected: string[], id: string): string[] {
  const club = clubs.find((c) => c.id === id);
  if (!club) return selected;
  const current = clubs.filter((c) => selected.includes(c.id));
  if (current.length && current[0].format !== club.format) return [id];
  if (selected.includes(id)) {
    const rest = selected.filter((x) => x !== id);
    return rest.length ? rest : selected;
  }
  return clubs.filter((c) => c.id === id || selected.includes(c.id)).map((c) => c.id);
}

/**
 * «Все клубы формата»: отметить все; если уже отмечены все — оставить один
 * (клуб по умолчанию, если он этого формата, иначе первый).
 */
export function toggleFormat(
  clubs: ClubLite[],
  selected: string[],
  format: StudioFormat,
  activeId: string | null,
): string[] {
  const ofFormat = clubs.filter((c) => c.format === format).map((c) => c.id);
  const all = ofFormat.length > 0 && ofFormat.every((id) => selected.includes(id));
  if (!all) return ofFormat;
  const keep = ofFormat.includes(activeId ?? "") ? activeId! : ofFormat[0];
  return [keep];
}

/** Подпись поля: название клуба, «Все клубы формата» или «N клуба». */
export function clubsLabel(clubs: ClubLite[], selected: string[], allLabel: string): string {
  const chosen = clubs.filter((c) => selected.includes(c.id));
  if (chosen.length === 0) return "—";
  if (chosen.length === 1) return chosen[0].name;
  const sameFormat = clubs.filter((c) => c.format === chosen[0].format);
  if (sameFormat.length === chosen.length) return allLabel;
  const n = chosen.length;
  const word = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "клуба" : "клубов";
  return `${n} ${word}`;
}
