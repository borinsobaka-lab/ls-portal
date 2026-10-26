/**
 * Мультиязычность клиентского приложения (2026-10-12): английский (по
 * умолчанию), грузинский, русский. Подробно — apps/client/CLAUDE.md,
 * «Языки».
 *
 * - строки интерфейса: const t = useT(); t("Записаться"); t.plural(n, "…|…|…");
 *   вне компонентов — currentT(); подписи в константах — msg("…") + t() при показе;
 * - даты и числа: t.date(d, {…}), t.time(d), t.number(n) (format.ts);
 * - контент из админки: const loc = useLocalize(); loc(row).title
 *   (в select — колонка translations).
 */
export * from "./locales";
export {
  msg,
  currentT,
  getTranslator,
  loadDictionary,
  type Translator,
  type Vars,
} from "./translate";
export { I18nProvider, useI18n, useT, useLocalize } from "./react";
export { localizeRow, type ContentTranslations, type Localizable } from "./content";
export { LocaleFlag } from "./flags";
