/**
 * Повышает версию клиентского приложения (src/lib/app-version.ts): 1.0 → 1.1
 * … 1.99 → 2.0. Запускать перед каждой выкладкой клиента:
 *   bun run version:bump        (из apps/client)
 *   bun run version:client      (из корня)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nextAppVersion } from "../src/lib/app-version";

const file = fileURLToPath(new URL("../src/lib/app-version.ts", import.meta.url));
const source = readFileSync(file, "utf8");
const pattern = /export const APP_VERSION = "([^"]+)";/;
const current = pattern.exec(source)?.[1];
if (!current) {
  console.error("APP_VERSION не найдена в src/lib/app-version.ts");
  process.exit(1);
}
const next = nextAppVersion(current);
writeFileSync(file, source.replace(pattern, `export const APP_VERSION = "${next}";`));
console.log(`Версия приложения: ${current} → ${next}`);
