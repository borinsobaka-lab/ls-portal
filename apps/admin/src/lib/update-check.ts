/**
 * Вышла ли новая версия портала (components/update-banner.tsx). Отдельно от
 * React — тест update-check.test.ts.
 */

/** Ошибка загрузки куска сборки — признак, что сервер уже на новой версии. */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(
    message,
  );
}

/** Версия сервера отличается от версии открытой страницы. */
export function isNewerVersion(current: string, server: unknown): boolean {
  return typeof server === "string" && server.trim() !== "" && server !== current;
}
