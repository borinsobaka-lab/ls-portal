/**
 * Подписи ответов анкеты клиентского приложения (member_profiles): карточка
 * клиента (вкладка «Анкета») и «Маркетинг» на дашборде.
 */

/** Цель тренировок (primary_goal, enum fitness_goal). */
export const GOAL_LABELS: Record<string, string> = {
  weight_loss: "Снизить вес",
  muscle_strength: "Сила / мышцы",
  endurance: "Выносливость и форма",
  energy_wellbeing: "Энергия и самочувствие",
  stress_habit: "Снять стресс, привычка",
  event_prep: "Подготовка к событию",
  // Анкета пакетных студий (db/migrations/2026-10-11_packages_onboarding.sql).
  flexibility: "Стать гибче",
  stress_relief: "Снять напряжение и стресс",
  body_shape: "Подтянуть фигуру",
  other: "Другое",
};

/**
 * Цели, которые предлагает анкета приложения формата клуба (фильтр «Цель
 * клиента» в «Клиентах»): у пакетного приложения свои, подписочное — прежние.
 */
export function goalOptions(format: string | null | undefined): string[] {
  return format === "packages"
    ? ["flexibility", "stress_relief", "body_shape", "other"]
    : [
        "weight_loss",
        "muscle_strength",
        "endurance",
        "energy_wellbeing",
        "stress_habit",
        "event_prep",
      ];
}

/** «Откуда вы о нас узнали?» (referral_source, apps/client onboarding). */
export const REFERRAL_LABELS: Record<string, string> = {
  instagram: "Instagram / соцсети",
  referral: "Рекомендация друга",
  walk_by: "Проходил(а) мимо",
  search: "Поиск / карты",
  other: "Другое",
};
