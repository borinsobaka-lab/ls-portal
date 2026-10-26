/**
 * Форматы студий (studios.format, db/migrations/2026-10-09_studio_formats.sql).
 * Подробно — STUDIO_FORMATS.md: что общее, что у формата своё, как добавлять
 * разделы.
 *
 * Для каждого формата — своё клиентское приложение (одна кодовая база
 * apps/client, сборка с VITE_APP_FORMAT), у каждого свой адрес.
 */
export const STUDIO_FORMATS = ["subscription", "packages"] as const;
export type StudioFormat = (typeof STUDIO_FORMATS)[number];

export const STUDIO_FORMAT_LABEL: Record<StudioFormat, string> = {
  subscription: "Зал с подписочной моделью",
  packages: "Зал с пакетами тренировок",
};

/**
 * Адрес клиентского приложения формата — build-переменные
 * VITE_SUBSCRIPTION_APP_URL / VITE_PACKAGES_APP_URL (пусто — приложение
 * формата не развёрнуто).
 */
export const STUDIO_FORMAT_APP_URL: Record<StudioFormat, string> = {
  subscription: (import.meta.env.VITE_SUBSCRIPTION_APP_URL ?? "").replace(/\/+$/, ""),
  packages: (import.meta.env.VITE_PACKAGES_APP_URL ?? "").replace(/\/+$/, ""),
};

/** Цвет новой студии — прежний фирменный розовый (он же --brand в styles.css). */
export const DEFAULT_BRAND_COLOR = "#f763fc";

export const isBrandColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
