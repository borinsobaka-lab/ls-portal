import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { localizeRow, type Localizable } from "./content";
import { type Locale, readDocumentLocale, writeDocumentLocale } from "./locales";
import {
  type Translator,
  currentT,
  getTranslator,
  loadDictionary,
  setClientLocale,
} from "./translate";

type I18nValue = {
  locale: Locale;
  t: Translator;
  /** Сменить язык: подгружает словарь, потом переключает весь интерфейс. */
  setLocale: (locale: Locale) => Promise<void>;
};

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Язык интерфейса. Начальный — из cookie (на сервере — из запроса через
 * beforeLoad корня, в браузере — document.cookie); словарь к этому моменту
 * уже загружен: на сервере — в beforeLoad корня, в браузере — до гидратации
 * (hydrate в router.tsx).
 */
export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof document === "undefined") return initialLocale;
    // В браузере — cookie: её словарь загружен до гидратации. Обычно это
    // тот же язык, что у сервера; иначе (страница из кэша service worker'а
    // без сети) React перерисует расхождение сам.
    const cookieLocale = readDocumentLocale();
    setClientLocale(cookieLocale);
    return cookieLocale;
  });

  const setLocale = useCallback(async (next: Locale) => {
    await loadDictionary(next);
    writeDocumentLocale(next);
    setClientLocale(next);
    document.documentElement.lang = next;
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: getTranslator(locale), setLocale }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Вне провайдера (экран ошибки корня) — текущий язык без смены. */
function fallbackValue(): I18nValue {
  const t = currentT();
  return { locale: t.locale, t, setLocale: async () => {} };
}

export function useI18n(): I18nValue {
  return useContext(I18nContext) ?? fallbackValue();
}

/** Переводчик текущего языка: const t = useT(); t("Записаться"). */
export function useT(): Translator {
  return useI18n().t;
}

/**
 * Контент из админки на языке клиента: const loc = useLocalize();
 * loc(news).title. Строка должна прийти с колонкой translations
 * (src/i18n/content.ts).
 */
export function useLocalize() {
  const { locale } = useI18n();
  return useCallback(<T extends Localizable>(row: T) => localizeRow(row, locale), [locale]);
}
