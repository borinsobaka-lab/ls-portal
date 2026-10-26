import { describe, expect, test } from "bun:test";
import { rangeBound } from "./number-range";

describe("rangeBound", () => {
  test("целое ≥ 0 — граница, пустое и не число — без границы", () => {
    expect(rangeBound("0")).toBe(0);
    expect(rangeBound(" 5 ")).toBe(5);
    expect(rangeBound("")).toBeNull();
    expect(rangeBound("  ")).toBeNull();
    expect(rangeBound("-1")).toBeNull();
    expect(rangeBound("2.5")).toBeNull();
    expect(rangeBound("abc")).toBeNull();
  });
});
