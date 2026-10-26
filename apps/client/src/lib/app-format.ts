/**
 * Формат студий, для которого собрано приложение (studios.format; подробно —
 * STUDIO_FORMATS.md в корне репозитория).
 *
 * Одна кодовая база — два приложения: для «Зала с подписочной моделью» и для
 * «Зала с пакетами тренировок», у каждого свой адрес. Формат задаёт
 * build-переменная VITE_APP_FORMAT (в Coolify — Build Variable); без неё —
 * подписочный, как было до разделения.
 */
export type StudioFormat = "subscription" | "packages";

export const APP_FORMAT: StudioFormat =
  import.meta.env.VITE_APP_FORMAT === "packages" ? "packages" : "subscription";

/**
 * Адреса приложений форматов — build-переменные VITE_SUBSCRIPTION_APP_URL /
 * VITE_PACKAGES_APP_URL (те же, что у админки, studio-formats.ts). Без
 * переменной — заглушка (адрес нужен как URL, например для календаря).
 */
const appUrl = (value: string | undefined) =>
  (value || "https://app.example.com").replace(/\/+$/, "");

export const FORMAT_APP_URL: Record<StudioFormat, string> = {
  subscription: appUrl(import.meta.env.VITE_SUBSCRIPTION_APP_URL),
  packages: appUrl(import.meta.env.VITE_PACKAGES_APP_URL),
};

/**
 * Бренд приложения в заголовках страниц, описаниях и текстах: в пакетном —
 * Lady Stretch, в подписочном — Base40. Клиент Lady Stretch не должен видеть
 * Base40 нигде (решение владельца 2026-10-15). В t() — подстановкой {brand}.
 */
export const APP_BRAND = APP_FORMAT === "packages" ? "Lady Stretch" : "Base40";
