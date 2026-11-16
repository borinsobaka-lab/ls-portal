/**
 * Бренд портала: заголовки страниц, экран входа, страница ошибки. С
 * 2026-11-01 портал называется LadyFitPro (ребрендинг и новый домен
 * ladyfitpro.ru: в нём материалы обоих брендов франшизы — Lady Stretch и
 * Lady Jump). Письма — свой бренд (src/lib/auth-email.ts, EMAIL_BRAND /
 * MAIL_FROM_NAME).
 */
/**
 * Тестовый стенд «Аналитики» (DEPLOY.md, шаг 18; build-переменная
 * `VITE_STAND=true`): своя база и свой адрес, чтобы разработчик аналитики
 * проверял правки до Pull Request. Метка — в названии вкладок и на экране
 * (`StandBadge`), чтобы стенд не путали с рабочим порталом.
 */
export const IS_STAND = import.meta.env.VITE_STAND === "true";

export const PORTAL_NAME = IS_STAND ? "LadyFitPro · стенд" : "LadyFitPro";
export const PORTAL_TITLE = `Портал ${PORTAL_NAME}`;
