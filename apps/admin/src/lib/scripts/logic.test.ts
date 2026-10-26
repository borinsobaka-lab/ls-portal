import { describe, expect, test } from "bun:test";

import { buildCallStats, pct, runProgress } from "./call-stats";
import { fieldChanges, wordDiff } from "./diff";
import {
  adminNames,
  dateAfter,
  defaultFirstName,
  makeResolver,
  messageText,
  normalize,
  plural,
  resolveText,
  searchScripts,
  searchTerms,
  stripMarkup,
} from "./logic";
import type { CallNode, ScriptItem, ScriptSection, ScriptSettings } from "./types";

const item = (over: Partial<ScriptItem>): ScriptItem => ({
  id: "i",
  section_id: "s",
  title: "",
  kind: "chat",
  keywords: "",
  note: "",
  follow_up: "",
  variants: [{ label: "", messages: [{ label: "", ru: "", en: "", ka: "" }] }],
  position: 0,
  updated_at: null,
  updated_by: "",
  change_note: "",
  ...over,
});

const section = (items: ScriptItem[]): ScriptSection => ({
  id: "s",
  title: "Возражения",
  icon: "",
  position: 0,
  kind: "text",
  flow: null,
  flow_updated_at: null,
  flow_updated_by: "",
  flow_change_note: "",
  items,
});

const settings: ScriptSettings = {
  studios: [{ name: "Ваке", ru: "Ваке", en: "Vake", ka: "" }],
  admins: { u1: { ru: "Мари", en: "Mari", ka: "" } },
  variables: [
    { key: "цена", type: "text", description: "", ru: "14 ₾", en: "", ka: "", offset_days: 0 },
    { key: "слот", type: "date", description: "", ru: "", en: "", ka: "", offset_days: 1 },
  ],
  updated_at: null,
  updated_by: "",
};

describe("поиск", () => {
  test("ё и регистр не мешают, длина строки сохраняется", () => {
    expect(normalize("Ещё ЁЛКА")).toBe("еще елка");
    expect(normalize("Ещё").length).toBe(3);
  });

  test("название выше текста, все слова обязательны", () => {
    const sec = section([
      item({
        id: "a",
        title: "Недорого у нас",
        variants: [{ label: "", messages: [{ label: "", ru: "текст", en: "", ka: "" }] }],
      }),
      item({
        id: "b",
        title: "Дорого",
        variants: [{ label: "", messages: [{ label: "", ru: "цена", en: "", ka: "" }] }],
      }),
      item({ id: "c", title: "Адрес", note: "**дорого** добираться" }),
    ]);
    expect(searchScripts([sec], searchTerms("дорого")).map((h) => h.item.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(searchScripts([sec], searchTerms("дорого цена")).map((h) => h.item.id)).toEqual(["b"]);
    expect(searchScripts([sec], [])).toEqual([]);
  });
});

describe("переменные", () => {
  const resolve = makeResolver({
    settings,
    me: { id: "u1", fullName: "Гелашвили Мари" },
    lang: "ru",
    studio: "Ваке",
  });

  test("имя, клуб и свои переменные подставляются на языке текста", () => {
    expect(resolveText("Меня зовут {админ}, клуб {клуб}, пробное {цена}", resolve)).toBe(
      "Меня зовут Мари, клуб Ваке, пробное 14 ₾",
    );
    // Прежнее имя переменной из старых текстов.
    expect(resolveText("студия {студия}", resolve)).toBe("студия Ваке");
    expect(resolveText("Есть места на {слот}", resolve)).toBe(`Есть места на ${dateAfter(1)}`);
  });

  test("нечего подставить — остаётся в скобках и объясняет почему", () => {
    const en = makeResolver({
      settings,
      me: { id: "u1", fullName: null },
      lang: "ka",
      studio: "Ваке",
    });
    expect(en("цена")?.value).toBeNull();
    expect(en("клуб")?.why).toContain("грузинском");
    expect(resolveText("{нет_такой}", resolve)).toBe("{нет_такой}");
    // Пока настройки не пришли — не ошибка.
    expect(
      makeResolver({ settings: null, me: null, lang: "ru", studio: "" })("цена"),
    ).toBeUndefined();
  });

  test("имя по умолчанию — из «Фамилия Имя» профиля", () => {
    expect(defaultFirstName("Гелашвили Анна")).toBe("Анна");
    expect(defaultFirstName("Анна")).toBe("Анна");
    expect(adminNames(settings, "u2", "Петрова Нино").ru).toBe("Нино");
  });

  test("дата — ДД.ММ через N дней", () => {
    expect(dateAfter(1, new Date(2026, 11, 31))).toBe("01.01");
  });
});

test("нет перевода — показан другой язык с пометкой", () => {
  expect(messageText({ label: "", ru: "Привет", en: "", ka: "" }, "en")).toEqual({
    text: "Привет",
    lang: "ru",
    fallback: true,
  });
});

test("разметка подсказок не мешает поиску и копированию", () => {
  expect(
    stripMarkup(
      "**жирно** __подч__ [[копия]] [ссылка](script:0f0e0d0c-0000-0000-0000-000000000000)",
    ),
  ).toBe("жирно подч копия ссылка");
});

test("склонение", () => {
  expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, "скрипт", "скрипта", "скриптов"))).toEqual([
    "скрипт",
    "скрипта",
    "скриптов",
    "скриптов",
    "скрипт",
    "скрипта",
  ]);
});

describe("хронология", () => {
  test("только изменившиеся поля и слова", () => {
    const base = {
      title: "Дорого",
      kind: "chat" as const,
      section: "Возражения",
      note: "",
      follow_up: "",
      keywords: "",
      variants: [{ label: "", messages: [{ label: "", ru: "Цена 10", en: "", ka: "" }] }],
    };
    const fields = fieldChanges({
      id: "c",
      item_id: "i",
      item_title: "Дорого",
      action: "updated",
      before: base,
      after: {
        ...base,
        variants: [{ label: "", messages: [{ label: "", ru: "Цена 14", en: "", ka: "" }] }],
      },
      change_note: "",
      author: "",
      created_at: "",
    });
    expect(fields.map((f) => f.label)).toEqual(["Текст · RU"]);
    const d = wordDiff("Цена 10", "Цена 14");
    expect(d.before.filter((p) => p.changed).map((p) => p.text)).toEqual(["10"]);
    expect(d.after.filter((p) => p.changed).map((p) => p.text)).toEqual(["14"]);
  });
});

describe("статистика звонков", () => {
  const nodes: CallNode[] = [
    {
      id: "a",
      title: "Привет",
      group: "main",
      text: { ru: "", en: "", ka: "" },
      hint: "",
      client: "",
      answers: [{ label: "x", to: "b" }],
    },
    {
      id: "b",
      title: "Запись",
      group: "main",
      text: { ru: "", en: "", ka: "" },
      hint: "",
      client: "",
      answers: [],
    },
    {
      id: "o",
      title: "Дорого",
      group: "objection",
      text: { ru: "", en: "", ka: "" },
      hint: "",
      client: "",
      answers: [{ label: "y", to: "b" }],
    },
  ];

  test("воронка по этапам и дошедшие до конца", () => {
    const stats = buildCallStats(
      {
        sections: [{ id: "s", title: "Звонок", runs: 3, deleted: false }],
        section_id: "s",
        runs: 3,
        avg_steps: 1.67,
        reached: { a: 3, b: 1, o: 1 },
        ended: [
          { node_id: "a", title: "Привет", group: "main", count: 1 },
          { node_id: "b", title: "Запись", group: "main", count: 1 },
          { node_id: "o", title: "Дорого", group: "objection", count: 1 },
        ],
        seen: [],
      },
      nodes,
    );
    expect(stats.totals.completed).toBe(1);
    expect(stats.funnel.map((f) => [f.node_id, f.reached, f.ended_here])).toEqual([
      ["a", 3, 1],
      ["b", 1, 1],
    ]);
    expect(stats.ends.find((e) => e.node_id === "b")?.script_end).toBe(true);
    expect(pct(1, 3)).toBe("33%");
  });

  test("докуда дошёл звонок и сколько длился", () => {
    const p = runProgress(
      {
        id: "r",
        section_id: "s",
        user_id: "u",
        user_name: "",
        started_at: "2026-10-10T10:00:00Z",
        updated_at: "2026-10-10T10:01:00Z",
        ended_at: "2026-10-10T10:01:00Z",
        path: [
          { id: "a", title: "Привет", group: "main", answer: "x", at: "2026-10-10T10:00:00Z" },
          { id: "b", title: "Запись", group: "main", answer: "", at: "2026-10-10T10:00:45Z" },
        ],
      },
      nodes,
    );
    expect([p.reached, p.stages, p.script_end, p.live, p.seconds]).toEqual([2, 2, true, false, 45]);
  });
});
