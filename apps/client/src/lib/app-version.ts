/**
 * Версия клиентского приложения (решение владельца 2026-10-15): «1.0», «1.1»
 * … «1.99», затем «2.0» и так далее. Одна на обе сборки (app.base40.fit и
 * app.lady-stretch.one). **Каждая выкладка клиента (merge в main с правками
 * apps/client) повышает версию** — `bun run version:bump` в apps/client
 * (scripts/bump-version.ts переписывает строку ниже). Показывается в профиле,
 * «О приложении», и попадает в скопированную техническую информацию.
 */
export const APP_VERSION = "1.0";

/** Следующая версия: 1.0 → 1.1, 1.9 → 1.10, 1.99 → 2.0. */
export function nextAppVersion(version: string): string {
  const m = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new Error(`Неверная версия: «${version}» (ожидается «1.0»)`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return minor >= 99 ? `${major + 1}.0` : `${major}.${minor + 1}`;
}
