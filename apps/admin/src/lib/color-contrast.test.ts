import { describe, expect, test } from "bun:test";

import { contrastRatio, parseHex, readableOn, textOnTint } from "./color-contrast";

describe("color-contrast", () => {
  test("parseHex", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#1A2027")).toEqual([26, 32, 39]);
    expect(parseHex("var(--brand)")).toBeNull();
  });

  test("contrastRatio: белый на чёрном — 21", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
  });

  test("readableOn: тёмно-красный бренд на меню осветляется до 3:1", () => {
    const out = readableOn("#c8102e", "#1a2027");
    expect(out).not.toBe("#c8102e");
    expect(contrastRatio(parseHex(out)!, parseHex("#1a2027")!)).toBeGreaterThanOrEqual(3);
  });

  test("readableOn: розовый по умолчанию не меняется", () => {
    expect(readableOn("#f763fc", "#1a2027")).toBe("#f763fc");
  });

  test("readableOn: розовый на белом затемняется до 4.5:1 для текста", () => {
    const out = readableOn("#f763fc", "#ffffff", 4.5);
    expect(contrastRatio(parseHex(out)!, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
  });

  test("readableOn: не hex — как есть", () => {
    expect(readableOn("var(--brand)", "#1a2027")).toBe("var(--brand)");
  });

  test("textOnTint: на бледной заливке — тёмный, на насыщенной синей — белый", () => {
    expect(textOnTint("#f763fc", 0.3)).toBe("dark");
    expect(textOnTint("#f763fc", 1)).toBe("dark");
    expect(textOnTint("#1d4ed8", 1)).toBe("light");
  });
});
