import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { APP_FORMAT } from "@/lib/app-format";
import { untypedDb } from "@/lib/untyped-db";
import { msg, type ContentTranslations } from "@/i18n";

/**
 * Обратная связь (решение владельца 2026-10-15): своя форма вместо внешнего
 * сервиса. Обращение — строка `feedback` (db/migrations/2026-10-15_zz_feedback_in_app.sql),
 * его видят и отрабатывают сотрудники в админке («Обратная связь»).
 * Ключи тем и настроений — как в таблице и в админке.
 */

export const FEEDBACK_TOPICS = [
  { key: "training", emoji: "🏋️", label: msg("Тренировка") },
  { key: "staff", emoji: "👩‍💼", label: msg("Сотрудник") },
  { key: "cleanliness", emoji: "🧹", label: msg("Чистота и порядок") },
  { key: "app", emoji: "📱", label: msg("Приложение и запись") },
  { key: "idea", emoji: "💡", label: msg("Идея или предложение") },
  { key: "thanks", emoji: "😊", label: msg("Просто хочу сказать спасибо") },
  { key: "other", emoji: "❓", label: msg("Другое") },
] as const;

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number]["key"];

export const FEEDBACK_MOODS = [
  { key: "negative", emoji: "😞", label: msg("Негативно") },
  { key: "neutral", emoji: "😐", label: msg("Нейтрально") },
  { key: "positive", emoji: "😊", label: msg("Позитивно") },
] as const;

export type FeedbackMood = (typeof FEEDBACK_MOODS)[number]["key"];

/** Пределы полей — как проверка feedback_lengths_check в базе. */
export const FEEDBACK_LIMITS = { message: 4000, name: 200, contact: 200 } as const;

export type FeedbackStudio = {
  id: string;
  name: string;
  translations?: ContentTranslations | null;
};

/**
 * Студии формата приложения — выбор в форме. studios читается публично:
 * форма открывается и без входа (ссылка или QR-код клуба).
 */
export const feedbackStudiosQuery = queryOptions({
  queryKey: ["feedback-studios", APP_FORMAT],
  queryFn: async (): Promise<FeedbackStudio[]> => {
    const { data, error } = await supabase
      .from("studios")
      .select("id, name, translations")
      .eq("format", APP_FORMAT)
      .order("name");
    if (error) throw error;
    return (data as unknown as FeedbackStudio[] | null) ?? [];
  },
  staleTime: 5 * 60_000,
});

export type FeedbackDraft = {
  studioId: string;
  topic: FeedbackTopic;
  message: string;
  mood: FeedbackMood | null;
  name: string;
  contact: string;
};

/**
 * Отправить обращение. Без чтения строки обратно: читать feedback могут только
 * сотрудники. Статус, дату и источник (app/link) ставит база.
 */
export async function submitFeedback(d: FeedbackDraft): Promise<void> {
  const { error } = await untypedDb.from("feedback").insert({
    studio_id: d.studioId,
    topic: d.topic,
    message: d.message.trim(),
    mood: d.mood,
    client_name: d.name.trim() || null,
    client_contact: d.contact.trim() || null,
  });
  if (error) throw error;
}

/** Студия из ссылки (`?studio=<id>`): только id студии. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFeedbackSearch(search: Record<string, unknown>): { studio?: string } {
  const studio = search.studio;
  return typeof studio === "string" && UUID_RE.test(studio) ? { studio } : {};
}
