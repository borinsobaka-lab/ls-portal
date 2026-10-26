// Числовой промежуток фильтра (components/number-range-filter.tsx).

/** Границы промежутка строками полей ввода; пустая — без границы. */
export type NumberRange = { min: string; max: string };

export const EMPTY_NUMBER_RANGE: NumberRange = { min: "", max: "" };

/** Граница как целое ≥ 0; пустая или не число — null (без границы). */
export function rangeBound(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
