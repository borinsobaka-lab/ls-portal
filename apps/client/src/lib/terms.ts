import { msg } from "@/i18n";
import { APP_FORMAT } from "@/lib/app-format";

/** Пакетное приложение (app.lady-stretch.one). */
export const IS_PACKAGES = APP_FORMAT === "packages";

/**
 * «Клуб» в текстах приложения: в пакетном — «студия» (решение владельца
 * 2026-10-11), в подписочном — по-прежнему «клуб». Падежи — для подстановки
 * в строки: `клиентов ${CLUB.gen}`.
 *
 * С переводом интерфейса (src/i18n) строку с «клубом» в t() не собирать из
 * CLUB — ключ словаря должен быть виден в коде целиком:
 * IS_PACKAGES ? t("Правила студии") : t("Правила клуба").
 */
export const CLUB = IS_PACKAGES
  ? { nom: "студия", gen: "студии", dat: "студии", prep: "студии", Nom: "Студия" }
  : { nom: "клуб", gen: "клуба", dat: "клубу", prep: "клубе", Nom: "Клуб" };

/**
 * Раздел записи на занятия: «Расписание» в пакетном, «Бронь» в подписочном.
 * Показывать переведённым: t(SCHEDULE_TITLE).
 */
export const SCHEDULE_TITLE = IS_PACKAGES ? msg("Расписание") : msg("Бронь");

export { APP_BRAND } from "@/lib/app-format";
