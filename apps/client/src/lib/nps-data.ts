import { queryOptions } from "@tanstack/react-query";

import { untypedDb } from "@/lib/untyped-db";
import { parseNpsSurvey, type NpsSurvey } from "@/lib/nps";

/**
 * NPS-опрос, положенный клиенту сейчас (RPC my_nps_survey,
 * db/migrations/2026-10-15_zz_nps_surveys.sql), или null. Ошибка (в том
 * числе база ещё без миграции) — тоже null: опрос не показывается, приложение
 * работает как раньше. Между запусками не сохраняется: срок опроса считает
 * база.
 */
export const npsSurveyQuery = (userId: string | null) =>
  queryOptions({
    queryKey: ["nps-survey", userId],
    queryFn: async (): Promise<NpsSurvey | null> => {
      const { data, error } = await untypedDb.rpc("my_nps_survey");
      if (error) return null;
      return parseNpsSurvey(data);
    },
    enabled: !!userId,
    staleTime: 5 * 60_000,
    meta: { persist: false },
  });

/** Окно опроса открылось (показ учитывается в частоте опросов). */
export async function markNpsSurveyShown(survey: NpsSurvey) {
  await untypedDb.rpc("nps_survey_shown", {
    p_survey_type: survey.survey_type,
    p_occasion: survey.occasion,
  });
}

/** Закрыт крестиком без ответа — этот опрос больше не показывается. */
export async function closeNpsSurvey(survey: NpsSurvey) {
  const { error } = await untypedDb.rpc("nps_survey_close", {
    p_survey_type: survey.survey_type,
    p_occasion: survey.occasion,
  });
  if (error) throw error;
}

/** Ответ: имя и клуб база берёт из карточки клиента. */
export async function submitNpsResponse(
  survey: NpsSurvey,
  answer: { score: number; comment: string; language: string },
) {
  const { error } = await untypedDb.rpc("submit_nps_response", {
    p_survey_type: survey.survey_type,
    p_occasion: survey.occasion,
    p_score: answer.score,
    p_comment: answer.comment.trim(),
    p_language: answer.language,
  });
  if (error) throw error;
}
