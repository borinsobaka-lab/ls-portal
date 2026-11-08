import { describe, expect, test } from "bun:test";

import {
  chatMatches,
  chatTime,
  chatTitle,
  dayLabel,
  docMentions,
  docText,
  safeHref,
  snippetParts,
  systemText,
  textDoc,
  unreadLabel,
} from "./content";
import type { ChatDoc } from "./types";

const doc: ChatDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Привет, " },
        { type: "mention", attrs: { id: "u1", label: "Анна" } },
        { type: "text", text: "!", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "раз" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "два" }] }],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "цитата" }] }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "строка" },
        { type: "hardBreak" },
        { type: "mention", attrs: { id: "all", label: "все" } },
      ],
    },
  ],
};

describe("текст сообщения", () => {
  test("чистый текст и упоминания", () => {
    expect(docText(doc)).toBe("Привет, @Анна!\n• раз\n• два\n> цитата\nстрока\n@все");
    expect(docMentions(doc).sort()).toEqual(["all", "u1"]);
    expect(docText(null)).toBe("");
  });

  test("из обычного текста и обратно", () => {
    expect(docText(textDoc("a\nb"))).toBe("a\nb");
  });

  test("ссылки только безопасные", () => {
    expect(safeHref("https://x.ru")).toBe("https://x.ru");
    expect(safeHref("/kb/1")).toBe("/kb/1");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil")).toBeNull();
    expect(safeHref(5)).toBeNull();
  });
});

describe("подписи", () => {
  const name = (id: string) => ({ a: "Анна", b: "Борис" })[id] ?? "?";

  test("название чата", () => {
    expect(chatTitle({ kind: "self", title: null, peer_id: null }, name)).toBe("Избранное");
    expect(chatTitle({ kind: "direct", title: null, peer_id: "b" }, name)).toBe("Борис");
    expect(chatTitle({ kind: "group", title: "Отдел", peer_id: null }, name)).toBe("Отдел");
  });

  test("системные сообщения", () => {
    expect(systemText({ type: "added", users: ["b"] }, "a", name)).toBe("Анна добавил(а): Борис");
    expect(systemText({ type: "left", users: ["b"] }, "b", name)).toBe("Борис вышел(а) из группы");
    expect(systemText({ type: "created", title: "Отдел" }, "a", name)).toBe(
      "Анна создал(а) группу «Отдел»",
    );
  });

  test("время в списке и дни в переписке", () => {
    const now = new Date(2026, 10, 8, 15, 0);
    expect(chatTime(new Date(2026, 10, 8, 9, 5).toISOString(), now)).toBe("09:05");
    expect(chatTime(new Date(2026, 10, 7, 9, 5).toISOString(), now)).toBe("вчера");
    expect(chatTime(new Date(2026, 10, 4, 9, 5).toISOString(), now)).toBe("ср");
    expect(chatTime(new Date(2026, 9, 3).toISOString(), now)).toBe("3 окт.");
    expect(chatTime(new Date(2025, 9, 3).toISOString(), now)).toBe("3 окт. 2025");
    expect(dayLabel(new Date(2026, 10, 8, 1).toISOString(), now)).toBe("Сегодня");
    expect(dayLabel(new Date(2026, 10, 3).toISOString(), now)).toBe("3 ноября");
  });

  test("поиск по названию и фрагменты", () => {
    expect(chatMatches("Отдел развития", "разв")).toBe(true);
    expect(chatMatches("Алёна", "алена")).toBe(true);
    expect(chatMatches("Отдел", "казань")).toBe(false);
    expect(snippetParts("про ⟦рекламу⟧ и ⟦отчёт⟧.")).toEqual([
      { text: "про ", hit: false },
      { text: "рекламу", hit: true },
      { text: " и ", hit: false },
      { text: "отчёт", hit: true },
      { text: ".", hit: false },
    ]);
    expect(unreadLabel(150)).toBe("99+");
  });
});

describe("папки", () => {
  test("системные и свои, счётчик без звука не считает", async () => {
    const { folderFilter, folderUnread } = await import("./folders");
    const row = (id: string, kind: "direct" | "group" | "self", unread: number, notify = "all") =>
      ({ id, kind, unread, notify, muted_until: null }) as never;
    const chats = [
      row("a", "direct", 2),
      row("b", "group", 1),
      row("c", "self", 0),
      row("d", "group", 5, "none"),
    ];
    expect(chats.filter(folderFilter("direct", []))).toHaveLength(2);
    expect(chats.filter(folderFilter("group", []))).toHaveLength(2);
    expect(chats.filter(folderFilter("f1", [{ id: "f1", chat_ids: ["a", "d"] }]))).toHaveLength(2);
    expect(folderUnread(chats, folderFilter("all", []))).toBe(2);
  });
});
