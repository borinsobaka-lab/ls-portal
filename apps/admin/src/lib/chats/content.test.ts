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
    const row = (
      id: string,
      kind: "direct" | "group" | "self" | "task",
      unread: number,
      notify = "all",
    ) => ({ id, kind, unread, notify, muted_until: null }) as never;
    const chats = [
      row("a", "direct", 2),
      row("b", "group", 1),
      row("c", "self", 0),
      row("d", "group", 5, "none"),
      row("e", "task", 3),
    ];
    expect(chats.filter(folderFilter("direct", []))).toHaveLength(2);
    expect(chats.filter(folderFilter("group", []))).toHaveLength(2);
    expect(chats.filter(folderFilter("f1", [{ id: "f1", chat_ids: ["a", "d"] }]))).toHaveLength(2);
    expect(folderUnread(chats, folderFilter("all", []))).toBe(2);
    // Обсуждения задач — только в «Задачах», не во «Всех» и не в «Личных».
    expect(chats.filter(folderFilter("all", [])).map((c: { id: string }) => c.id)).not.toContain(
      "e",
    );
    expect(chats.filter(folderFilter("task", [])).map((c: { id: string }) => c.id)).toEqual(["e"]);
  });
});

describe("каналы и состав из оргструктуры", () => {
  test("канал — своя папка, не в «Группах»", async () => {
    const { folderFilter, isChannel } = await import("./folders");
    const chats = [
      { id: "g", kind: "group", settings: {} },
      { id: "c", kind: "group", settings: { channel: true } },
      { id: "d", kind: "direct", settings: {} },
    ] as never[];
    expect(chats.filter(folderFilter("channel", [])).map((c: { id: string }) => c.id)).toEqual([
      "c",
    ]);
    expect(chats.filter(folderFilter("group", [])).map((c: { id: string }) => c.id)).toEqual(["g"]);
    expect(isChannel({ kind: "direct", settings: { channel: true } })).toBe(false);
  });

  test("подписи источников и системной строки", async () => {
    const { sourceText, systemText } = await import("./content");
    expect(sourceText({ kind: "all", unit_id: null, scope: "all", with_subunits: true })).toBe(
      "Вся компания — все сотрудники",
    );
    expect(
      sourceText({
        kind: "unit",
        unit_id: "u",
        unit_name: "Отдел развития",
        scope: "heads",
        with_subunits: false,
      }),
    ).toBe("Отдел развития — руководители и заместители");
    expect(
      sourceText({
        kind: "unit",
        unit_id: "u",
        unit_name: "Казань",
        scope: "all",
        with_subunits: true,
      }),
    ).toBe("Казань — все сотрудники, с подразделениями ниже");
    expect(systemText({ type: "channel_created", title: "Новости" }, "a", () => "Анна")).toBe(
      "Анна создал(а) канал «Новости»",
    );
  });
});

describe("отложенные сообщения и адрес", () => {
  test("быстрые варианты «Отправить позже»", async () => {
    const { scheduleOptions } = await import("./content");
    // Чт 12 ноября 2026, 10:07 (время браузера).
    const thu = new Date(2026, 10, 12, 10, 7);
    const o = scheduleOptions(thu);
    expect(o.map((x) => x.label)).toEqual([
      "Через час, в 11:10",
      "Сегодня в 18:00",
      "Завтра в 9:00",
      "В понедельник в 9:00",
    ]);
    expect(o[3].at.getDay()).toBe(1);
    expect(o[3].at.getDate()).toBe(16);
    // Воскресенье вечером: «сегодня» уже нет, понедельник — это «завтра».
    const sun = new Date(2026, 10, 15, 20, 0);
    expect(scheduleOptions(sun).map((x) => x.label)).toEqual([
      "Через час, в 21:00",
      "Завтра в 9:00",
    ]);
  });

  test("подпись времени отложенного", async () => {
    const { scheduledLabel, toLocalInput } = await import("./content");
    const now = new Date(2026, 10, 12, 10, 0);
    expect(scheduledLabel(new Date(2026, 10, 12, 18, 0).toISOString(), now)).toBe(
      "сегодня в 18:00",
    );
    expect(scheduledLabel(new Date(2026, 10, 13, 9, 5).toISOString(), now)).toBe("завтра в 09:05");
    expect(scheduledLabel(new Date(2026, 10, 16, 9, 0).toISOString(), now)).toBe(
      "пн, 16 нояб. в 09:00",
    );
    expect(toLocalInput(new Date(2026, 0, 5, 7, 3))).toBe("2026-01-05T07:03");
  });

  test("папки и отложенные — в адресе", async () => {
    const { chatsSearch } = await import("./search-params");
    expect(chatsSearch({ f: "channel", m: "12", scheduled: "1" })).toEqual({
      f: "channel",
      m: 12,
      scheduled: true,
    });
    expect(chatsSearch({ f: "project" })).toEqual({ f: "project" });
    expect(chatsSearch({ f: "bad folder" })).toEqual({});
  });
});

describe("без звука", () => {
  const now = new Date(2026, 10, 9, 10, 0);
  const row = (notify: "all" | "mentions" | "none", muted_until: string | null = null) => ({
    notify,
    muted_until,
  });
  const later = new Date(2026, 10, 9, 11, 0).toISOString();
  const earlier = new Date(2026, 10, 9, 9, 0).toISOString();

  test("один признак «заглушен»: не «все» или тишина до времени в будущем", async () => {
    const { isMuted } = await import("./content");
    expect(isMuted(row("all"), now)).toBe(false);
    // «Только упоминания» — тоже без звука (раньше список видел только none).
    expect(isMuted(row("mentions"), now)).toBe(true);
    expect(isMuted(row("none"), now)).toBe(true);
    expect(isMuted(row("all", later), now)).toBe(true);
    expect(isMuted(row("all", earlier), now)).toBe(false);
  });

  test("подменю «Без звука»: на время — с прежними уведомлениями, навсегда — выключены", async () => {
    const { muteOptions } = await import("./content");
    const opts = muteOptions("all", now);
    expect(opts.map((o) => o.label)).toEqual(["На 1 час", "На 8 часов", "На 2 дня", "Навсегда"]);
    expect(opts[0].until?.getTime()).toBe(now.getTime() + 3_600_000);
    expect(opts[1].until?.getTime()).toBe(now.getTime() + 8 * 3_600_000);
    expect(opts[2].until?.getTime()).toBe(now.getTime() + 2 * 86_400_000);
    expect(opts.slice(0, 3).every((o) => o.notify === "all")).toBe(true);
    expect(opts[3]).toMatchObject({ notify: "none", until: null });
    // «Только упоминания» сохраняется: время вышло — снова только упоминания.
    expect(muteOptions("mentions", now)[0].notify).toBe("mentions");
    expect(muteOptions("none", now)[0].notify).toBe("all");
  });

  test("настройка и подписи", async () => {
    const { muteLabel, notifyChoice, untilLabel } = await import("./content");
    expect(notifyChoice(row("all"), now)).toBe("all");
    expect(notifyChoice(row("mentions"), now)).toBe("mentions");
    expect(notifyChoice(row("all", later), now)).toBe("none");
    expect(notifyChoice(row("mentions", earlier), now)).toBe("mentions");
    expect(untilLabel(new Date(2026, 10, 9, 18, 40), now)).toBe("до 18:40");
    expect(untilLabel(new Date(2026, 10, 10, 9, 5), now)).toBe("до завтра, 09:05");
    expect(untilLabel(new Date(2026, 10, 12, 9, 0), now)).toBe("до 12 нояб., 09:00");
    expect(muteLabel(row("all", later), now)).toBe("Без звука до 11:00");
    expect(muteLabel(row("none"), now)).toBe("Без звука");
    expect(muteLabel(row("mentions"), now)).toBe("Только упоминания");
    expect(muteLabel(row("all"), now)).toBe("");
  });

  test("папка не считает чаты «только упоминания» и заглушенные на время", async () => {
    const { folderFilter, folderUnread } = await import("./folders");
    const chats = [
      { id: "a", kind: "direct", unread: 1, notify: "all", muted_until: null },
      { id: "b", kind: "group", unread: 1, notify: "mentions", muted_until: null },
      { id: "c", kind: "group", unread: 1, notify: "all", muted_until: later },
    ] as never[];
    expect(folderUnread(chats, folderFilter("all", []), now)).toBe(1);
  });
});

describe("превью удалённого", () => {
  test("предыдущее сообщение из загруженной переписки", async () => {
    const { previewOf } = await import("./content");
    const last = { seq: 3, author_id: "a", kind: "text" as const, text: "", deleted: true };
    const msg = (seq: number, text: string, deleted = false) =>
      ({ id: `m${seq}`, seq, author_id: "b", kind: "text", text, deleted, content: null }) as never;
    expect(previewOf(last, [msg(1, "раз"), msg(2, "два"), msg(3, "", true)])).toMatchObject({
      seq: 2,
      text: "два",
    });
    // Переписка не загружена — «Сообщение удалено».
    expect(previewOf(last, undefined)).toBe(last);
    const alive = { ...last, deleted: false, text: "привет" };
    expect(previewOf(alive, undefined)).toBe(alive);
  });

  test("код базы без перевода — понятный текст", async () => {
    const { chatErrorText } = await import("./data");
    expect(chatErrorText(new Error("chat_something_new"))).toBe(
      "Не получилось. Попробуйте ещё раз",
    );
    expect(chatErrorText(new Error("chat_forbidden"))).toBe("Нет доступа к этому чату");
    expect(chatErrorText(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });
});
