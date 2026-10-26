/**
 * Формат студий, для которого собрано приложение (studios.format; подробно —
 * STUDIO_FORMATS.md в корне репозитория).
 *
 * Одна кодовая база — два приложения: app.base40.fit для «Зала с подписочной
 * моделью» и отдельный адрес для «Зала с пакетами тренировок». Формат задаёт
 * build-переменная VITE_APP_FORMAT (в Coolify — Build Variable); без неё —
 * подписочный, как было до разделения.
 */
export type StudioFormat = "subscription" | "packages";

export const APP_FORMAT: StudioFormat =
  import.meta.env.VITE_APP_FORMAT === "packages" ? "packages" : "subscription";

/** Адреса приложений форматов. Те же значения — в studio-formats.ts админки. */
export const FORMAT_APP_URL: Record<StudioFormat, string> = {
  subscription: "https://app.base40.fit",
  packages: "https://app.lady-stretch.one",
};

/**
 * Бренд приложения в заголовках страниц, описаниях и текстах: в пакетном —
 * Lady Stretch, в подписочном — Base40. Клиент Lady Stretch не должен видеть
 * Base40 нигде (решение владельца 2026-10-15). В t() — подстановкой {brand}.
 */
export const APP_BRAND = APP_FORMAT === "packages" ? "Lady Stretch" : "Base40";
