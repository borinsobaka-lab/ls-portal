// NPS-опросы приложения (решение владельца 2026-10-15): тексты и правила
// формы. Какой опрос показать, решает база (RPC my_nps_survey,
// db/migrations/2026-10-15_zz_nps_surveys.sql); запросы — lib/nps-data.ts,
// окно — components/nps-survey-dialog.tsx. Здесь — без запросов к базе
// (тест рядом).
import { msg } from "@/i18n";

export type NpsSurveyType = "first_lessons" | "first_month" | "before_renewal" | "after_return";

/** Опрос, положенный клиенту: вид и повод (once или id абонемента). */
export type NpsSurvey = { survey_type: NpsSurveyType; occasion: string };

/** Критик (0–6), нейтрал (7–8), промоутер (9–10). */
export type NpsGroup = "detractor" | "passive" | "promoter";

export const NPS_SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Длина комментария — как обрезает база. */
export const NPS_COMMENT_MAX = 2000;

export function npsGroup(score: number): NpsGroup {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

/** Уточняющий вопрос — по оценке. */
export const NPS_FOLLOW_UP: Record<NpsGroup, string> = {
  detractor: msg("Что именно вас расстроило? Расскажите подробнее."),
  passive: msg("Чего не хватает, чтобы вы поставили нам 10?"),
  promoter: msg("Что вам нравится больше всего?"),
};

/**
 * Заголовок и описание опроса. {brand} — название приложения (Lady Stretch
 * или Base40); «студия» / «клуб» — по формату приложения, как во всех текстах.
 */
export function npsSurveyTexts(
  type: NpsSurveyType,
  packages: boolean,
): { title: string; description: string } {
  switch (type) {
    case "first_lessons":
      return {
        title: msg("Как вам первые занятия?"),
        description: msg(
          "Вы уже попробовали {brand} — и нам очень важно узнать ваши первые впечатления. Это займёт меньше минуты.",
        ),
      };
    case "first_month":
      return {
        title: msg("Месяц занятий — расскажите, как вам?"),
        description: msg(
          "Вы занимаетесь с нами уже месяц. Поделитесь впечатлениями — это помогает нам становиться лучше для вас.",
        ),
      };
    case "before_renewal":
      return {
        title: msg("Ваше мнение важно для нас"),
        description: packages
          ? msg(
              "Мы рады, что вы с нами. Уделите минуту, чтобы рассказать о своём опыте — ваш отзыв помогает нам улучшать студию.",
            )
          : msg(
              "Мы рады, что вы с нами. Уделите минуту, чтобы рассказать о своём опыте — ваш отзыв помогает нам улучшать клуб.",
            ),
      };
    case "after_return":
      return {
        title: msg("Рады видеть вас снова!"),
        description: msg(
          "Вы вернулись — и это здорово. Расскажите, как вам занятия сейчас. Нам важно, чтобы каждое возвращение было лучше предыдущего.",
        ),
      };
  }
}

export function isNpsSurveyType(value: unknown): value is NpsSurveyType {
  return (
    value === "first_lessons" ||
    value === "first_month" ||
    value === "before_renewal" ||
    value === "after_return"
  );
}

/** Ответ RPC my_nps_survey → опрос или null (неизвестный вид — не показываем). */
export function parseNpsSurvey(data: unknown): NpsSurvey | null {
  if (!data || typeof data !== "object") return null;
  const { survey_type, occasion } = data as Record<string, unknown>;
  if (!isNpsSurveyType(survey_type) || typeof occasion !== "string" || !occasion) return null;
  return { survey_type, occasion };
}

/**
 * Ошибка формы при отправке (ключ перевода) или null: без оценки — выбрать
 * оценку, без ответа на уточняющий вопрос — ответить (он обязателен).
 */
export function npsFormError(score: number | null, comment: string): string | null {
  if (score === null) return msg("Пожалуйста, выберите оценку.");
  if (!comment.trim()) return msg("Пожалуйста, ответьте на вопрос выше.");
  return null;
}

/**
 * Новая оценка: комментарий стирается, только если сменился уточняющий
 * вопрос (другая группа); 9 → 10 ответ не теряет.
 */
export function commentAfterScoreChange(
  prev: number | null,
  next: number,
  comment: string,
): string {
  return prev !== null && npsGroup(prev) === npsGroup(next) ? comment : "";
}
