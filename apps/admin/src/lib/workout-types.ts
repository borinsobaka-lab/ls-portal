export type DayType = "strength" | "cardio" | "hybrid" | "recovery";

export const DAY_TYPES: { value: DayType; label: string }[] = [
  { value: "strength", label: "Силовая" },
  { value: "cardio", label: "Кардио" },
  { value: "hybrid", label: "Гибрид" },
  { value: "recovery", label: "Восстановление" },
];

// Заливка карточки занятия — оттенок 700: белый текст на 500-х давал
// 2,5–4,2:1 (зелёный хуже всех), на 700-х — от 5,5:1. Точка и hex (полоска,
// графики) — прежние 500-е: это не фон под текстом.
export const DAY_TYPE_COLORS: Record<
  DayType,
  { dot: string; bg: string; text: string; border: string; hex: string }
> = {
  strength: {
    dot: "bg-blue-500",
    bg: "bg-blue-700",
    text: "text-white",
    border: "border-blue-800",
    hex: "#3b82f6",
  },
  cardio: {
    dot: "bg-red-500",
    bg: "bg-red-700",
    text: "text-white",
    border: "border-red-800",
    hex: "#ef4444",
  },
  hybrid: {
    dot: "bg-violet-500",
    bg: "bg-violet-700",
    text: "text-white",
    border: "border-violet-800",
    hex: "#8b5cf6",
  },
  recovery: {
    dot: "bg-emerald-500",
    bg: "bg-emerald-700",
    text: "text-white",
    border: "border-emerald-800",
    hex: "#10b981",
  },
};

export function dayTypeLabel(v: string | null | undefined) {
  return DAY_TYPES.find((t) => t.value === v)?.label ?? "—";
}

export function dayTypeColor(v: string | null | undefined) {
  if (v && v in DAY_TYPE_COLORS) {
    return DAY_TYPE_COLORS[v as DayType];
  }
  return null;
}

/**
 * Палитра цветов тренировок пакетного формата (полоска на карточке занятия).
 * `basic` — 10 самых непохожих: новой тренировке предлагается первый свободный
 * из них, чтобы соседние тренировки не получали почти одинаковые оттенки.
 * Можно выбрать и свой цвет — `workouts.color`, #rrggbb.
 */
export const WORKOUT_COLORS: { hex: string; label: string; basic?: true }[] = [
  { hex: "#ef4444", label: "Красный", basic: true },
  { hex: "#b91c1c", label: "Тёмно-красный" },
  { hex: "#f43f5e", label: "Малиновый" },
  { hex: "#f97316", label: "Оранжевый", basic: true },
  { hex: "#f59e0b", label: "Янтарный" },
  { hex: "#eab308", label: "Жёлтый", basic: true },
  { hex: "#84cc16", label: "Салатовый" },
  { hex: "#22c55e", label: "Зелёный", basic: true },
  { hex: "#15803d", label: "Тёмно-зелёный" },
  { hex: "#14b8a6", label: "Бирюзовый", basic: true },
  { hex: "#06b6d4", label: "Циан" },
  { hex: "#0ea5e9", label: "Голубой", basic: true },
  { hex: "#3b82f6", label: "Синий", basic: true },
  { hex: "#1e40af", label: "Тёмно-синий" },
  { hex: "#6366f1", label: "Индиго" },
  { hex: "#8b5cf6", label: "Фиолетовый", basic: true },
  { hex: "#a855f7", label: "Пурпурный" },
  { hex: "#ec4899", label: "Розовый", basic: true },
  { hex: "#92400e", label: "Коричневый" },
  { hex: "#78716c", label: "Серый", basic: true },
];

export const isWorkoutColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
