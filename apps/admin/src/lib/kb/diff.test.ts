import { describe, expect, test } from "bun:test";

import { diffLines, diffStats } from "./diff";
import { documentHeadings, documentLines } from "./document";

const p = (id: string, text: string) => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, styles: {} }],
  children: [],
});

describe("сравнение версий статьи", () => {
  test("строки документа: абзацы, таблица по рядам, файлы, упоминание", () => {
    const doc = [
      { id: "h", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Касса" }] },
      p("a", "Пересчитать наличные"),
      {
        id: "t",
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                [{ type: "text", text: "Зона" }],
                { content: [{ type: "text", text: "Зал" }] },
              ],
            },
          ],
        },
      },
      { id: "f", type: "pdf", props: { name: "regl.pdf" } },
      {
        id: "m",
        type: "paragraph",
        content: [
          { type: "text", text: "Спросить " },
          { type: "mention", props: { userId: "u", name: "Анна" } },
        ],
      },
    ];
    expect(documentLines(doc).map((l) => l.text)).toEqual([
      "Касса",
      "Пересчитать наличные",
      "Зона | Зал",
      "PDF: regl.pdf",
      "Спросить @Анна",
    ]);
    expect(
      documentHeadings([
        { id: "x", type: "heading", content: [{ type: "mention", props: { name: "Анна" } }] },
      ]),
    ).toEqual([{ id: "x", level: 1, text: "@Анна" }]);
  });

  test("добавленное, убранное и неизменное — по порядку", () => {
    const before = documentLines([p("1", "раз"), p("2", "два"), p("3", "три")]);
    const after = documentLines([
      p("1", "раз"),
      p("2", "два с половиной"),
      p("3", "три"),
      p("4", "четыре"),
    ]);
    const lines = diffLines(before, after);
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual([
      "same:раз",
      "del:два",
      "add:два с половиной",
      "same:три",
      "add:четыре",
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines(before, before))).toEqual({ added: 0, removed: 0 });
  });
});
