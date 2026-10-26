import { Ruler, Shapes, UserRound, Users } from "lucide-react";

import type { StudioFormat } from "@/lib/studio-formats";

/**
 * Типы занятий в расписании (schedule_entries.kind, 2026-10-11, оба формата
 * студий): групповое — по тренировке, клиенты записываются из приложения;
 * персональное — ведёт один тренер (ставка за персональную — «Зарплатные
 * ставки»); прочая активность — своё название, сотрудники по желанию
 * (тренеры и администраторы) и ставка, введённая вручную. Персональные и прочие клиенты в приложении не видят.
 * Диагностика тела (2026-10-15, только пакетные клубы) — как персональное:
 * тренер, время и клиент; клиент видит её в приложении, «Посетил» списывает
 * диагностику с абонемента.
 */
export type ActivityKind = "group" | "personal" | "diagnostic" | "other";

export const ACTIVITY_KINDS: {
  value: ActivityKind;
  label: string;
  /** Подпись во множественном числе — для фильтра. */
  plural: string;
  description: string;
  icon: typeof Users;
  /** Плашка иконки в выборе типа и в фильтре (полоска на карточке — своя). */
  color: string;
  /** Только для клубов этих форматов; без поля — у всех. */
  formats?: StudioFormat[];
}[] = [
  {
    value: "group",
    label: "Групповое занятие",
    plural: "Групповые",
    description: "Тренировка из раздела «Тренировки», клиенты записываются в приложении",
    icon: Users,
    color: "#3b82f6",
  },
  {
    value: "personal",
    label: "Персональное занятие",
    plural: "Персональные",
    description: "Тренер и время — ставка тренера за персональную тренировку",
    icon: UserRound,
    color: "#8b5cf6",
  },
  {
    value: "diagnostic",
    label: "Диагностика",
    plural: "Диагностики",
    description: "Тренер, время и клиент — спишется диагностика с абонемента клиента",
    icon: Ruler,
    color: "#0f172a",
    formats: ["packages"],
  },
  {
    value: "other",
    label: "Прочая активность",
    plural: "Прочие активности",
    description: "Своё название, сотрудники по желанию и ставка вручную",
    icon: Shapes,
    color: "#f59e0b",
  },
];

export const ACTIVITY_KIND_VALUES = ACTIVITY_KINDS.map((k) => k.value);

/** Типы занятий клуба этого формата (без формата — все). */
export function activityKindsFor(format: StudioFormat | null | undefined) {
  return ACTIVITY_KINDS.filter((k) => !k.formats || !format || k.formats.includes(format));
}

/** Один тренер и один клиент: персональное занятие и диагностика. */
export function isOneOnOne(kind: ActivityKind) {
  return kind === "personal" || kind === "diagnostic";
}

export function activityKind(v: ActivityKind) {
  return ACTIVITY_KINDS.find((k) => k.value === v) ?? ACTIVITY_KINDS[0];
}
