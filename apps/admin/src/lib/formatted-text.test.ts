import { describe, expect, test } from "bun:test";

import { parseBlocks, stripFormatting } from "./formatted-text";

describe("parseBlocks", () => {
  test("старый текст без разметки — абзацы с переносами строк", () => {
    expect(parseBlocks("Первая строка\nвторая\n\nНовый абзац")).toEqual([
      { kind: "p", lines: ["Первая строка", "вторая"] },
      { kind: "p", lines: ["Новый абзац"] },
    ]);
  });

  test("заголовок, списки и абзац после списка", () => {
    expect(
      parseBlocks("## Что входит\n- 8 тренировок\n- 1 персональная\n1. раз\n2. два\n\nИтог"),
    ).toEqual([
      { kind: "h", text: "Что входит" },
      { kind: "ul", items: ["8 тренировок", "1 персональная"] },
      { kind: "ol", items: ["раз", "два"] },
      { kind: "p", lines: ["Итог"] },
    ]);
  });

  test("пустой список после пустых строк", () => {
    expect(parseBlocks("\n\n- a\n\n\n- b")).toEqual([
      { kind: "ul", items: ["a"] },
      { kind: "ul", items: ["b"] },
    ]);
  });
});

test("stripFormatting — текст для превью в одну строку", () => {
  expect(
    stripFormatting("## Пакет\n- **8** тренировок, [сайт](https://base40.fit) и *бонус*"),
  ).toBe("Пакет 8 тренировок, сайт и бонус");
});
