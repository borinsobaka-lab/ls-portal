/**
 * Версия админки (решение владельца 2026-10-17): «1.0», «1.1» … «1.99», затем
 * «2.0» и так далее — как у клиентского приложения, но своя. **Каждая выкладка
 * админки (merge в main с правками apps/admin или db/ — их пересобирает
 * club40-admin) повышает версию** — `bun run version:bump` в apps/admin
 * (scripts/bump-version.ts переписывает строку ниже). Показывается в рейке
 * под «Выходом» (components/rail-account.tsx).
 */
export const ADMIN_VERSION = "1.23";

/** Следующая версия: 1.0 → 1.1, 1.9 → 1.10, 1.99 → 2.0. */
export function nextAdminVersion(version: string): string {
  const m = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new Error(`Неверная версия: «${version}» (ожидается «1.0»)`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return minor >= 99 ? `${major + 1}.0` : `${major}.${minor + 1}`;
}
