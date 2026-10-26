/**
 * Повышает версию админки (src/lib/app-version.ts): 1.0 → 1.1 … 1.99 → 2.0.
 * Запускать перед каждой выкладкой админки:
 *   bun run version:bump        (из apps/admin)
 *   bun run version:admin       (из корня)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nextAdminVersion } from "../src/lib/app-version";

const file = fileURLToPath(new URL("../src/lib/app-version.ts", import.meta.url));
const source = readFileSync(file, "utf8");
const pattern = /export const ADMIN_VERSION = "([^"]+)";/;
const current = pattern.exec(source)?.[1];
if (!current) {
  console.error("ADMIN_VERSION не найдена в src/lib/app-version.ts");
  process.exit(1);
}
const next = nextAdminVersion(current);
writeFileSync(file, source.replace(pattern, `export const ADMIN_VERSION = "${next}";`));
console.log(`Версия админки: ${current} → ${next}`);
