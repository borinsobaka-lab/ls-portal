import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * У каждой страницы админки — свой скелетон загрузки (pendingComponent
 * роута из components/page-skeletons.tsx). Без него, пока грузится код
 * страницы или права сотрудника, на её месте окажется чужая раскладка —
 * запасной PageSkeleton. Новый раздел без скелетона этот тест не пропустит.
 * Правила — .interface-design/system.md, «Скелетоны».
 */

const ROUTES = join(import.meta.dir, "../routes/_authenticated");

// Без своего экрана: layout-роут (каркас) и редирект с «/».
const EXEMPT = new Set(["route.tsx", "index.tsx"]);

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageFiles(path);
    return name.endsWith(".tsx") && !EXEMPT.has(name) ? [path] : [];
  });
}

describe("скелетоны страниц", () => {
  const files = pageFiles(ROUTES);

  test("страницы найдены", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    test(`${relative(ROUTES, file)} — pendingComponent из page-skeletons`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/pendingComponent:\s*\w+PageSkeleton/);
      expect(source).toContain('from "@/components/page-skeletons"');
    });
  }
});
