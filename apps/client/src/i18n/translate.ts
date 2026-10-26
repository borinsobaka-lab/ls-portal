import type { Dictionary } from "./dictionaries/types";
import { formatDate, formatNumber, formatTime } from "./format";
import {
  DEFAULT_LOCALE,
  type Locale,
  type TranslatedLocale,
  intlLocale,
  readDocumentLocale,
} from "./locales";

/**
 * Перевод строк интерфейса без React — ядро для useT() и для кода вне
 * компонентов.
 *
 * Словарь языка — отдельный чанк сборки (dynamic import): телефон скачивает
 * только словарь выбранного языка, русскому не нужен никакой. Загруженный
 * словарь лежит в памяти модуля; на сервере — общий для всех запросов (он
 * неизменяемый), а язык запроса передаётся явно (контекст React), не через
 * глобальную переменную.
 */

const LOADERS: Record<TranslatedLocale, () => Promise<{ default: Dictionary }>> = {
  en: () => import("./dictionaries/en"),
  ka: () => import("./dictionaries/ka"),
};

const loaded: Partial<Record<Locale, Dictionary>> = { ru: {} };
const pending: Partial<Record<Locale, Promise<Dictionary>>> = {};

/** Загрузить словарь языка (один раз; повторный вызов — тот же промис). */
export function loadDictionary(locale: Locale): Promise<Dictionary> {
  const ready = loaded[locale];
  if (ready) return Promise.resolve(ready);
  if (locale === "ru") return Promise.resolve({});
  const inflight = pending[locale];
  if (inflight) return inflight;
  const promise = LOADERS[locale]()
    .then((m) => {
      loaded[locale] = m.default;
      return m.default;
    })
    .finally(() => {
      delete pending[locale];
    });
  pending[locale] = promise;
  return promise;
}

export function isDictionaryLoaded(locale: Locale) {
  return !!loaded[locale];
}

export type Vars = Record<string, string | number>;

function interpolate(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

const reportedMissing = new Set<string>();
function lookup(locale: Locale, key: string): string {
  if (locale === "ru") return key;
  const dict = loaded[locale];
  const value = dict?.[key];
  if (value != null) return value;
  if (import.meta.env.DEV && dict && !reportedMissing.has(`${locale}:${key}`)) {
    reportedMissing.add(`${locale}:${key}`);
    console.warn(`[i18n] нет перевода (${locale}): ${JSON.stringify(key)}`);
  }
  // Нет перевода — русский оригинал (лучше, чем пустое место); проверка
  // словарей — `bun run i18n:check`.
  return key;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralIndex(locale: Locale, n: number): number {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale(locale));
    pluralRules.set(locale, rules);
  }
  const category = rules.select(n);
  if (locale === "ru") {
    // формы: 1 тренировка | 2 тренировки | 5 тренировок; дроби — как «2».
    return category === "one" ? 0 : category === "few" || category === "other" ? 1 : 2;
  }
  // en, ka: формы «один | несколько» (в грузинском после числа — обычно одна).
  return category === "one" ? 0 : 1;
}

export type Translator = {
  /** Строка интерфейса: t("Записаться"), t("Осталось {n} мест", { n }). */
  (key: string, vars?: Vars): string;
  /**
   * Число со словом: t.plural(n, "{n} тренировка|{n} тренировки|{n} тренировок").
   * Ключ словаря — вся строка с русскими формами через «|»; в переводе —
   * свои формы (английский: «{n} workout|{n} workouts»). {n} подставляется.
   */
  plural: (n: number, forms: string, vars?: Vars) => string;
  locale: Locale;
  /** Тег Intl (en-GB / ka-GE / ru-RU) — для localeCompare; даты и числа — t.date/t.time/t.number. */
  intl: string;
  /** Дата на языке клиента: t.date(d, { day: "numeric", month: "long" }) (src/i18n/format.ts). */
  date: (value: Date | string | number, options: Intl.DateTimeFormatOptions) => string;
  /** Время «19:00». */
  time: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  /** Число с разделителями языка: t.number(1200) → «1,200» / «1 200». */
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /**
   * Первая буква заглавной («пн» → «Пн»). В грузинском заглавных нет —
   * toUpperCase() дал бы буквы мтаврули, поэтому текст как есть.
   */
  capitalize: (text: string) => string;
};

const translators = new Map<Locale, Translator>();

/** Переводчик языка (кэшируется — одна и та же функция на язык). */
export function getTranslator(locale: Locale): Translator {
  const cached = translators.get(locale);
  if (cached) return cached;
  const t = ((key: string, vars?: Vars) => interpolate(lookup(locale, key), vars)) as Translator;
  t.plural = (n, forms, vars) => {
    const variants = lookup(locale, forms).split("|");
    const form = variants[Math.min(pluralIndex(locale, n), variants.length - 1)] ?? "";
    return interpolate(form, { n, ...vars });
  };
  t.locale = locale;
  t.intl = intlLocale(locale);
  t.date = (value, options) => formatDate(locale, value, options);
  t.time = (value, options) => formatTime(locale, value, options);
  t.number = (value, options) => formatNumber(locale, value, options);
  t.capitalize = (text) => (locale === "ka" ? text : text.charAt(0).toUpperCase() + text.slice(1));
  // До загрузки словаря не кэшируем: иначе запомнился бы переводчик без него.
  if (loaded[locale]) translators.set(locale, t);
  return t;
}

/**
 * Пометка строки для словаря без перевода на месте: списки вариантов,
 * подписи в константах модуля. Возвращает строку как есть, переводят её при
 * показе — t(option.label). Проверка словарей находит msg("…") так же, как
 * t("…").
 */
export function msg<S extends string>(text: S): S {
  return text;
}

// ---- Текущий язык вне React (только в браузере) ----

let clientLocale: Locale | null = null;

/** Ставит I18nProvider при смене языка (только в браузере). */
export function setClientLocale(locale: Locale) {
  clientLocale = locale;
}

/**
 * Переводчик текущего языка для кода вне компонентов (обработчики, запросы,
 * тосты). На сервере — язык по умолчанию: при рендере брать useT().
 */
export function currentT(): Translator {
  if (!clientLocale && typeof document !== "undefined") clientLocale = readDocumentLocale();
  return getTranslator(clientLocale ?? DEFAULT_LOCALE);
}
