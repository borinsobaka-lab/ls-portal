import { useState, type ChangeEvent } from "react";

import {
  cleanTranslations,
  hasTranslation,
  parseTranslations,
  translationList,
  translationText,
  withTranslation,
  type ContentLang,
  type ContentTranslations,
  type TranslatedLang,
} from "@/lib/content-i18n";

/** Поле с готовым onChange(value): FormattedTextarea. */
export type TextBinding = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

/** Поле с onChange(event): Input, Textarea. */
export type InputBinding = {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  placeholder?: string;
};

/** Список строк: BenefitsEditor. `ruHint` — русские пункты подсказкой (на en/ka). */
export type ListBinding = {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  ruHint?: string;
};

export type ContentTranslationsForm = {
  /** Язык, на котором сейчас правятся тексты формы. */
  lang: ContentLang;
  setLang: (lang: ContentLang) => void;
  /** Заполнен ли на языке хоть один перевод (точка в переключателе). */
  filled: (lang: TranslatedLang) => boolean;
  /**
   * Биндинги текстового поля: на ru — русское состояние формы как было, на
   * en/ka — translations[lang][field], плейсхолдер — русский текст.
   */
  text: (
    field: string,
    ru: string,
    setRu: (v: string) => void,
    placeholder?: string,
  ) => TextBinding;
  input: (
    field: string,
    ru: string,
    setRu: (v: string) => void,
    placeholder?: string,
  ) => InputBinding;
  list: (
    field: string,
    ru: string[],
    setRu: (v: string[]) => void,
    placeholder?: string,
  ) => ListBinding;
  /** translations для сохранения — без пустых строк и пустых языков. */
  cleaned: () => ContentTranslations;
};

/**
 * Переводы формы, состояние которых живёт снаружи (форма страницы с
 * черновиком — «Контакты и правила»). Язык редактирования — свой.
 */
export function useContentTranslationsValue(
  translations: ContentTranslations,
  onChange: (next: ContentTranslations) => void,
): ContentTranslationsForm {
  const [lang, setLang] = useState<ContentLang>("ru");

  const text = (
    field: string,
    ru: string,
    setRu: (v: string) => void,
    placeholder?: string,
  ): TextBinding =>
    lang === "ru"
      ? { value: ru, onChange: setRu, placeholder }
      : {
          value: translationText(translations, lang, field),
          onChange: (v) => onChange(withTranslation(translations, lang, field, v)),
          placeholder: ru.trim() || undefined,
        };

  return {
    lang,
    setLang,
    filled: (l) => hasTranslation(translations, l),
    text,
    input: (field, ru, setRu, placeholder) => {
      const b = text(field, ru, setRu, placeholder);
      return { ...b, onChange: (e) => b.onChange(e.target.value) };
    },
    list: (field, ru, setRu, placeholder) =>
      lang === "ru"
        ? { value: ru, onChange: setRu, placeholder }
        : {
            value: translationList(translations, lang, field),
            onChange: (v) => onChange(withTranslation(translations, lang, field, v)),
            placeholder: "Пункт перевода — и нажмите +",
            ruHint: ru.length > 0 ? `По-русски: ${ru.join(" · ")}` : undefined,
          },
    cleaned: () => cleanTranslations(translations),
  };
}

/**
 * Переводы формы диалога: `initial` — translations строки из БД (или
 * undefined у новой записи). Состояние — в самой форме, как и остальные
 * поля (форма монтируется заново с key при каждом открытии).
 */
export function useContentTranslations(initial: unknown): ContentTranslationsForm {
  const [translations, setTranslations] = useState(() => parseTranslations(initial));
  return useContentTranslationsValue(translations, setTranslations);
}
