import { expect, test } from "bun:test";

import { safeRedirectPath } from "./auth-redirect";

test("после входа — только на страницу админки", () => {
  expect(safeRedirectPath("/kb/b1/n1")).toBe("/kb/b1/n1");
  expect(safeRedirectPath("/kb/b1/n1?edit=1#h2")).toBe("/kb/b1/n1?edit=1#h2");
  expect(safeRedirectPath("https://evil.example/")).toBeUndefined();
  expect(safeRedirectPath("//evil.example/kb")).toBeUndefined();
  expect(safeRedirectPath("/\\evil.example")).toBeUndefined();
  expect(safeRedirectPath("/auth?redirect=/kb")).toBeUndefined();
  expect(safeRedirectPath(undefined)).toBeUndefined();
  expect(safeRedirectPath(42)).toBeUndefined();
});
