/**
 * Куда вернуть сотрудника после входа (`/auth?redirect=…`; ставит guard
 * `_authenticated/route.tsx`, когда сессии нет): присланная ссылка на статью
 * открывается после входа. Только путь этой админки («/kb/…») — чужой адрес
 * (`//evil.example`, `https://…`, `/\evil.example`) отбрасывается, иначе
 * ссылкой на /auth можно было бы увести сотрудника на чужой сайт.
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return;
  if (value.includes("\\") || value.startsWith("/auth")) return;
  return value;
}
