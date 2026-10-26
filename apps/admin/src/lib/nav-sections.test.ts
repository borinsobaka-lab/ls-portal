import { describe, expect, test } from "bun:test";

import { isKbToolPath } from "./nav-sections";

const BASE = "/kb/0b8f3c2e-1a2b-4c3d-9e8f-001122334455";

describe("isKbToolPath", () => {
  test("служебные страницы базы — на канве", () => {
    expect(isKbToolPath(`${BASE}/analytics`)).toBe(true);
    expect(isKbToolPath(`${BASE}/templates`)).toBe(true);
    expect(isKbToolPath(`${BASE}/trash/`)).toBe(true);
  });
  test("главная базы, папки и статьи — на белом", () => {
    expect(isKbToolPath("/kb")).toBe(false);
    expect(isKbToolPath(BASE)).toBe(false);
    expect(isKbToolPath(`${BASE}/0b8f3c2e-1a2b-4c3d-9e8f-001122334466`)).toBe(false);
  });
});
