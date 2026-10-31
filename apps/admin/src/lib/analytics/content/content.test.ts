import { describe, expect, test } from "bun:test";

import { contentRandomId } from "../server/vk-content.server";
import {
  CONTENT_TIMEZONES,
  contentImagesProblem,
  contentLocalTime,
  contentPostUrl,
  contentRenderBody,
  contentUploadType,
  contentZoneLabel,
} from "./rules";

describe("контент-план (их content.py)", () => {
  test("постоянный random_id публикации — как их _stable_random_id", () => {
    expect(contentRandomId(1, 7)).toBe("5397784247934374717");
    expect(contentRandomId(42, 1000)).toBe("2564401849760202863");
  });
  test("картинки формы: до 10, до 24 МБ, JPG/PNG/WEBP/GIF по типу и расширению, не пустые", () => {
    const f = (name: string, type: string, size = 10) => ({ name, type, size });
    expect(
      contentImagesProblem([
        f("a.jpg", "image/jpeg"),
        f("b.JPEG", "image/jpeg"),
        f("c.webp", "image/webp"),
      ]),
    ).toBeNull();
    expect(contentImagesProblem(Array.from({ length: 11 }, () => f("a.png", "image/png")))).toBe(
      "К одному посту можно прикрепить не больше 10 изображений.",
    );
    expect(contentImagesProblem([f("a.png", "image/png", 25 * 1024 * 1024)])).toBe(
      "Общий размер изображений не должен превышать 24 МБ.",
    );
    expect(contentImagesProblem([f("a.jpg", "image/png")])).toBe(
      "Можно прикрепить только изображения JPG, PNG, WEBP или GIF.",
    );
    expect(contentImagesProblem([f("a.bmp", "image/bmp")])).toBe(
      "Можно прикрепить только изображения JPG, PNG, WEBP или GIF.",
    );
    expect(contentImagesProblem([f("a.gif", "image/gif", 0)])).toBe(
      "Одно из изображений оказалось пустым.",
    );
  });
  test("ссылки группы в тексте, тип файла для VK, адрес поста", () => {
    expect(
      contentRenderBody(
        "А {ссылка_на_пробное} Б {ссылка_на_расписание} {ссылка_на_пробное}",
        "T",
        "S",
      ),
    ).toBe("А T Б S T");
    expect(contentUploadType("a.webp", "x")).toBe("image/webp");
    expect(contentUploadType("a.JPG", "x")).toBe("image/jpeg");
    expect(contentUploadType("noext", "image/png")).toBe("image/png");
    expect(contentPostUrl("216469945", "12")).toBe("https://vk.com/wall-216469945_12");
  });
  test("часовые пояса и локальное время публикации", () => {
    expect(CONTENT_TIMEZONES).toHaveLength(12);
    expect(contentZoneLabel("Europe/Samara")).toBe("UTC+4 · МСК+1 · Самара");
    expect(contentZoneLabel("X/Y")).toBe("X/Y");
    expect(contentLocalTime("2026-10-31T06:00:00Z", "Europe/Samara")).toBe("31.10 10:00");
    expect(contentLocalTime("2026-10-31T23:30:00Z", "Asia/Vladivostok")).toBe("01.11 09:30");
    expect(contentLocalTime(null, "Europe/Moscow")).toBe("—");
  });
});
