/**
 * Переводы контента клиентского приложения (решение владельца 2026-10-12:
 * приложение — на английском по умолчанию, грузинском и русском).
 *
 * Русский текст — в прежних колонках строки (основной язык админки),
 * остальные языки — в колонке `translations` (jsonb,
 * db/migrations/2026-10-12_zzzzzz_content_translations.sql):
 *
 *   {"en": {"title": "…", "description": "…"}, "ka": {"title": "…"}}
 *
 * ключ — язык, внутри — те же имена полей, что у русских колонок; список
 * (memberships.benefits) — массив строк. Пустых строк в translations нет:
 * приложение берёт язык клиента → английский → русский, и пустой перевод
 * только мешал бы этой цепочке (`cleanTranslations` перед сохранением).
 *
 * Чистая логика без React — хук формы: hooks/use-content-translations.ts,
 * переключатель в шапке диалога: components/content-lang.tsx.
 */

export type ContentLang = "ru" | "en" | "ka";
/** Языки, которые хранятся в translations (русский — в своих колонках). */
export type TranslatedLang = Exclude<ContentLang, "ru">;

export const TRANSLATED_LANGS: TranslatedLang[] = ["en", "ka"];

export const CONTENT_LANGS: {
  value: ContentLang;
  /** Полное название — на самом языке. */
  label: string;
  /** Короткая подпись в переключателе. */
  short: string;
  /** Название по-русски, в падеже «на …». */
  onLang: string;
}[] = [
  { value: "ru", label: "Русский", short: "RUS", onLang: "русском" },
  { value: "en", label: "English", short: "ENG", onLang: "английском" },
  { value: "ka", label: "ქართული", short: "GEO", onLang: "грузинском" },
];

export type TranslationValue = string | string[];
export type TranslationFields = Record<string, TranslationValue>;
export type ContentTranslations = Partial<Record<TranslatedLang, TranslationFields>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * translations из строки БД (или undefined, если колонку не выбрали): только
 * en/ka, только строки и списки строк. Пустые значения оставляем — их уберёт
 * `cleanTranslations` при сохранении.
 */
export function parseTranslations(raw: unknown): ContentTranslations {
  if (!isRecord(raw)) return {};
  const result: ContentTranslations = {};
  for (const lang of TRANSLATED_LANGS) {
    const fields = raw[lang];
    if (!isRecord(fields)) continue;
    const parsed: TranslationFields = {};
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string") parsed[field] = value;
      else if (Array.isArray(value))
        parsed[field] = value.filter((v): v is string => typeof v === "string");
    }
    result[lang] = parsed;
  }
  return result;
}

/** Значение без пустого: строка — обрезанная, список — без пустых пунктов. */
function cleanValue(value: TranslationValue): TranslationValue | null {
  if (typeof value === "string") return value.trim() || null;
  const items = value.map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

/** Для сохранения: без пустых строк, пустых списков и пустых языков. */
export function cleanTranslations(t: ContentTranslations): ContentTranslations {
  const result: ContentTranslations = {};
  for (const lang of TRANSLATED_LANGS) {
    const fields = t[lang];
    if (!fields) continue;
    const cleaned: TranslationFields = {};
    for (const [field, value] of Object.entries(fields)) {
      const v = cleanValue(value);
      if (v != null) cleaned[field] = v;
    }
    if (Object.keys(cleaned).length > 0) result[lang] = cleaned;
  }
  return result;
}

/** Заполнен ли на языке хоть один перевод (отметка в переключателе). */
export function hasTranslation(t: ContentTranslations, lang: TranslatedLang): boolean {
  const fields = t[lang];
  return !!fields && Object.values(fields).some((v) => cleanValue(v) != null);
}

/** Перевод поля строкой ("" — не заполнен или там список). */
export function translationText(t: ContentTranslations, lang: TranslatedLang, field: string) {
  const v = t[lang]?.[field];
  return typeof v === "string" ? v : "";
}

/** Перевод поля списком ([] — не заполнен или там строка). */
export function translationList(t: ContentTranslations, lang: TranslatedLang, field: string) {
  const v = t[lang]?.[field];
  return Array.isArray(v) ? v : [];
}

/** Новый объект переводов с полем `field` на языке `lang`. */
export function withTranslation(
  t: ContentTranslations,
  lang: TranslatedLang,
  field: string,
  value: TranslationValue,
): ContentTranslations {
  return { ...t, [lang]: { ...t[lang], [field]: value } };
}

/** Что увидит клиент, если поле на этом языке пустое. */
export function fallbackText(lang: TranslatedLang): string {
  return lang === "ka"
    ? "Пустое поле — клиент увидит английский текст, а если его нет — русский."
    : "Пустое поле — клиент увидит русский текст.";
}
