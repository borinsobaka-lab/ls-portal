// Общее для анкет обоих приложений (подписочной и пакетной): типы ответов
// member_profiles, заголовки вопросов, подписи. Компоненты —
// src/components/onboarding.tsx. Подписи — msg(), переводятся при показе: t(…).

import { msg } from "@/i18n";

export type Experience = "beginner" | "occasional" | "regular" | "advanced";
export type HealthFlag =
  | "back_joints"
  | "cardio_pressure"
  | "recent_injury"
  | "pregnancy"
  | "chronic"
  | "none";
export type PrefTime = "morning" | "day" | "evening";
export type Referral = "instagram" | "referral" | "walk_by" | "search" | "other";

export const STEP_TITLES: Record<
  "experience" | "activity" | "health" | "logistics" | "referral",
  { title: string; subtitle?: string }
> = {
  experience: { title: msg("Какой у вас опыт тренировок?") },
  activity: { title: msg("Сколько раз в неделю вы сейчас двигаетесь или тренируетесь?") },
  health: {
    title: msg("Есть что-то, о чём стоит знать тренеру?"),
    subtitle: msg(
      "Отметьте, если актуально — тренер скорректирует нагрузку. Это не заменяет консультацию врача.",
    ),
  },
  logistics: { title: msg("Как планируете заниматься?") },
  referral: { title: msg("Откуда вы о нас узнали?") },
};

export const FREQUENCY_LABEL = msg("Сколько раз в неделю хотите ходить?");
export const TIMES_LABEL = msg("Удобное время");
export const HEALTH_NOTES_LABEL = msg("Кратко опишите, что важно учесть");

/** Отмечено что-то, кроме «Ничего из перечисленного», — спросить подробности. */
export function hasHealthIssues(flags: HealthFlag[]) {
  return flags.some((f) => f !== "none");
}
