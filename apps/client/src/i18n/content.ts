import type { Locale, TranslatedLocale } from "./locales";

/**
 * Переводы контента из админки (db/migrations/2026-10-12_zzzzzz_content_translations.sql):
 * русский — в обычных колонках строки, остальные языки — в колонке
 * translations: {"en": {"title": "…"}, "ka": {…}}. Строка приходит со всеми
 * языками сразу, поэтому смена языка не делает запросов.
 *
 * Колонка есть у news, services, memberships, workouts, trainers,
 * studio_app_settings, studios — в select этих таблиц её добавлять
 * (`translations`), иначе клиент увидит русский текст.
 */
export type ContentTranslations = Partial<Record<TranslatedLocale, Record<string, unknown>>>;

export type Localizable = { translations?: ContentTranslations | null } | null | undefined;

/** Порядок языков: свой → английский → русский (прежние колонки). */
const FALLBACK: Record<Locale, TranslatedLocale[]> = {
  ru: [],
  en: ["en"],
  ka: ["ka", "en"],
};

function filled(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.trim() !== "");
  return false;
}

/**
 * Строка на языке клиента: поля из translations поверх русских. Пустой
 * перевод не затирает: берётся следующий язык цепочки.
 */
export function localizeRow<T extends Localizable>(row: T, locale: Locale): T {
  if (!row || locale === "ru") return row;
  const translations = row.translations;
  if (!translations || typeof translations !== "object") return row;
  let result: T | null = null;
  // С конца цепочки: свой язык перекрывает английский.
  for (const lang of [...FALLBACK[locale]].reverse()) {
    const fields = translations[lang];
    if (!fields || typeof fields !== "object") continue;
    for (const [field, value] of Object.entries(fields)) {
      if (!filled(value) || !(field in row)) continue;
      result ??= { ...row };
      (result as Record<string, unknown>)[field] = Array.isArray(value)
        ? value.filter((v) => typeof v === "string" && v.trim() !== "")
        : value;
    }
  }
  return result ?? row;
}
