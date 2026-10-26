import { describe, expect, test } from "bun:test";

import {
  MAX_PAYLOAD_BYTES,
  buildPushPayload,
  localizePush,
  normalizeActionUrl,
  type PushContent,
} from "./payload";

const push: PushContent = {
  id: "n1",
  title: "Скидка 20%",
  message: "Только до воскресенья",
  action_url: "memberships",
  translations: { en: { title: "20% off" }, ka: { title: "ფასდაკლება", message: "  " } },
};

describe("текст пуша на языке устройства", () => {
  test("язык → английский → русский, по каждому полю", () => {
    expect(localizePush(push, "ru")).toEqual({
      title: "Скидка 20%",
      body: "Только до воскресенья",
    });
    expect(localizePush(push, "en")).toEqual({ title: "20% off", body: "Только до воскресенья" });
    expect(localizePush(push, "ka")).toEqual({
      title: "ფასდაკლება",
      body: "Только до воскресенья",
    });
    // Неизвестный язык — как английский (язык приложения по умолчанию).
    expect(localizePush(push, "de").title).toBe("20% off");
    expect(localizePush({ ...push, translations: null }, "ka").title).toBe("Скидка 20%");
  });

  test("ссылка перехода", () => {
    expect(normalizeActionUrl(" schedule ")).toBe("/schedule");
    expect(normalizeActionUrl("/memberships")).toBe("/memberships");
    expect(normalizeActionUrl("//news")).toBe("/news");
    expect(normalizeActionUrl("https://instagram.com/x")).toBe("https://instagram.com/x");
    expect(normalizeActionUrl("")).toBeNull();
    expect(normalizeActionUrl(null)).toBeNull();
  });

  test("поля пуша и предел размера", () => {
    expect(JSON.parse(buildPushPayload(push, "en", "d1", "https://x/icon.png"))).toEqual({
      t: "20% off",
      b: "Только до воскресенья",
      u: "/memberships",
      n: "n1",
      d: "d1",
      i: "https://x/icon.png",
    });
    expect(JSON.parse(buildPushPayload(push, "ru", "d1", null)).i).toBeUndefined();

    const long = buildPushPayload(
      {
        ...push,
        title: "Я".repeat(400),
        message: "ქ".repeat(5000),
        action_url: "https://x/" + "a".repeat(2500),
      },
      "ru",
      "d1",
      null,
    );
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const parsed = JSON.parse(long);
    expect(Array.from(parsed.t as string).length).toBe(150);
    expect((parsed.t as string).endsWith("…")).toBe(true);
    expect(parsed.u).toStartWith("https://x/");
  });

  test("текст из одного символа и ссылка сверх предела — без зацикливания", () => {
    for (const message of ["!", "🎉", "Да"]) {
      const json = buildPushPayload(
        { ...push, title: "Т", message, action_url: "https://x/" + "a".repeat(3900) },
        "ru",
        "d1",
        null,
      );
      expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      const parsed = JSON.parse(json);
      // Текст ушёл, ссылка не влезла — пуш всё равно уходит (целиком — в ленте).
      expect(parsed.b).toBe("");
      expect(parsed.u).toBeNull();
    }
  });
});
