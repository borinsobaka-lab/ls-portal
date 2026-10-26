/**
 * Языки клиентского приложения (решение владельца 2026-10-12): английский —
 * по умолчанию (его видят при первом открытии), грузинский и русский.
 *
 * Исходный язык кода — русский: строки интерфейса пишутся по-русски внутри
 * t("…"), а английский и грузинский — словари «русский текст → перевод»
 * (src/i18n/dictionaries/). Русскому словарь не нужен.
 */
export type Locale = "en" | "ka" | "ru";

/** Языки со словарём (переводы с русского). */
export type TranslatedLocale = Exclude<Locale, "ru">;

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALES: {
  code: Locale;
  /** Название языка на нём самом — так его ищут в списке. */
  name: string;
  /** Тег для Intl (даты, числа): en-GB — 24-часовое время и «12 October». */
  intl: string;
}[] = [
  { code: "en", name: "English", intl: "en-GB" },
  { code: "ka", name: "ქართული", intl: "ka-GE" },
  { code: "ru", name: "Русский", intl: "ru-RU" },
];

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ka" || value === "ru";
}

export function intlLocale(locale: Locale): string {
  return LOCALES.find((l) => l.code === locale)?.intl ?? "en-GB";
}

/**
 * Выбранный язык хранится в cookie, а не в localStorage: сервер рендерит
 * первую страницу сразу на нём (без мелькания английского и без
 * расхождения при гидратации).
 */
export const LOCALE_COOKIE = "lang";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ~13 месяцев — предел браузеров

export function parseLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function readDocumentLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie.match(/(?:^|;\s*)lang=([^;]*)/);
  return parseLocale(match ? decodeURIComponent(match[1]) : null);
}

export function writeDocumentLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}
