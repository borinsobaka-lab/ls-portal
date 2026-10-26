import { describe, expect, test } from "bun:test";

import {
  documentFilePaths,
  documentHeadings,
  documentIsEmpty,
  replaceDocumentFiles,
} from "./document";
import { formatFileSize } from "./files";

const text = (t: string) => [{ type: "text", text: t, styles: {} }];

describe("документ статьи", () => {
  test("оглавление — заголовки по порядку, и во вложенных блоках", () => {
    const doc = [
      { id: "h1", type: "heading", props: { level: 1 }, content: text("Открытие"), children: [] },
      {
        id: "p",
        type: "paragraph",
        content: text("текст"),
        children: [
          { id: "h2", type: "heading", props: { level: 2 }, content: text("Касса"), children: [] },
        ],
      },
      { id: "h3", type: "heading", props: { level: 3 }, content: [], children: [] },
    ];
    expect(documentHeadings(doc)).toEqual([
      { id: "h1", level: 1, text: "Открытие" },
      { id: "h2", level: 2, text: "Касса" },
    ]);
  });

  test("пустая статья — без текста и файлов", () => {
    expect(documentIsEmpty(null)).toBe(true);
    expect(documentIsEmpty([{ id: "a", type: "paragraph", content: [], children: [] }])).toBe(true);
    expect(
      documentIsEmpty([{ id: "a", type: "paragraph", content: text("x"), children: [] }]),
    ).toBe(false);
    expect(
      documentIsEmpty([
        { id: "a", type: "image", props: { url: "kbfile:a/b/c.png" }, children: [] },
      ]),
    ).toBe(false);
    expect(documentIsEmpty([{ id: "a", type: "divider", props: {}, children: [] }])).toBe(false);
  });
});

describe("размер файла", () => {
  test("по-человечески", () => {
    expect(formatFileSize(512)).toBe("512 Б");
    expect(formatFileSize(2048)).toBe("2 КБ");
    expect(formatFileSize(50 * 1024 * 1024)).toBe("50 МБ");
    expect(formatFileSize(12.4 * 1024 * 1024)).toBe("12,4 МБ");
  });
});

describe("файлы документа", () => {
  const doc = [
    { type: "image", props: { url: "kbfile:b/a/1.png", caption: "" }, children: [] },
    {
      type: "gallery",
      // Как у галереи: картинки — строкой JSON.
      props: {
        images: JSON.stringify([{ url: "kbfile:b/a/2.jpg" }, { url: "https://example.com/x.png" }]),
      },
      children: [{ type: "file", props: { url: "kbfile:b/a/1.png" }, children: [] }],
    },
  ];

  test("собирает пути без повторов, чужие адреса не трогает", () => {
    expect(documentFilePaths(doc)).toEqual(["b/a/1.png", "b/a/2.jpg"]);
  });

  test("заменяет пути на копии, остальное как было", () => {
    const next = replaceDocumentFiles(doc, new Map([["b/a/1.png", "templates/t/1.png"]]));
    expect(documentFilePaths(next)).toEqual(["templates/t/1.png", "b/a/2.jpg"]);
    const both = replaceDocumentFiles(doc, new Map([["b/a/2.jpg", "t/2.jpg"]]));
    expect(documentFilePaths(both)).toEqual(["b/a/1.png", "t/2.jpg"]);
    expect(JSON.stringify(next)).toContain("https://example.com/x.png");
    expect(documentFilePaths(doc)).toEqual(["b/a/1.png", "b/a/2.jpg"]);
  });
});
