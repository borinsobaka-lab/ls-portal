import { describe, expect, test } from "bun:test";

import {
  cleanTranslations,
  hasTranslation,
  parseTranslations,
  translationList,
  translationText,
  withTranslation,
} from "./content-i18n";

describe("parseTranslations", () => {
  test("не объект — пусто", () => {
    expect(parseTranslations(null)).toEqual({});
    expect(parseTranslations(undefined)).toEqual({});
    expect(parseTranslations("en")).toEqual({});
    expect(parseTranslations([])).toEqual({});
  });

  test("только en/ka, строки и списки строк", () => {
    expect(
      parseTranslations({
        en: { title: "Hi", benefits: ["a", 1, "b"], count: 3 },
        ka: "x",
        de: { title: "Hallo" },
      }),
    ).toEqual({ en: { title: "Hi", benefits: ["a", "b"] } });
  });
});

describe("cleanTranslations", () => {
  test("убирает пустые строки, пустые пункты и пустые языки", () => {
    expect(
      cleanTranslations({
        en: { title: "  Title ", description: "   ", benefits: [" a ", "", "  "] },
        ka: { title: "", benefits: [" "] },
      }),
    ).toEqual({ en: { title: "Title", benefits: ["a"] } });
  });

  test("всё пусто — пустой объект", () => {
    expect(cleanTranslations({ en: {}, ka: { name: "" } })).toEqual({});
  });
});

describe("поля и отметки", () => {
  test("hasTranslation — хоть одно непустое поле", () => {
    const t = { en: { title: " " }, ka: { benefits: ["x"] } };
    expect(hasTranslation(t, "en")).toBe(false);
    expect(hasTranslation(t, "ka")).toBe(true);
  });

  test("withTranslation не трогает другие поля и языки", () => {
    const t = { en: { title: "A", description: "B" }, ka: { title: "C" } };
    const next = withTranslation(t, "en", "title", "A2");
    expect(next).toEqual({ en: { title: "A2", description: "B" }, ka: { title: "C" } });
    expect(t.en.title).toBe("A");
  });

  test("text/list — по типу значения", () => {
    const t = { en: { title: "A", benefits: ["x"] } };
    expect(translationText(t, "en", "title")).toBe("A");
    expect(translationText(t, "en", "benefits")).toBe("");
    expect(translationText(t, "ka", "title")).toBe("");
    expect(translationList(t, "en", "benefits")).toEqual(["x"]);
    expect(translationList(t, "en", "title")).toEqual([]);
  });
});
