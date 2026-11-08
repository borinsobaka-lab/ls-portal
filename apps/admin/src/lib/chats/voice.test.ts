import { describe, expect, test } from "bun:test";

import { EMOJI_GROUPS } from "./emoji-data";
import { parseEmojiGroups, pushRecent, searchEmoji } from "./emoji";
import {
  attachmentsLabel,
  buildWaveform,
  formatVoiceTime,
  holdGesture,
  nextVoiceRate,
  pickVoiceMime,
  resampleWaveform,
  voiceFileName,
} from "./voice";

describe("голосовые", () => {
  test("формат записи: что умеет браузер", () => {
    expect(pickVoiceMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickVoiceMime((m) => m.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickVoiceMime(() => false)).toBe("");
    expect(voiceFileName(new Date(2026, 10, 8, 9, 5), "audio/mp4")).toBe(
      "Голосовое 2026-11-08 09-05.m4a",
    );
    expect(voiceFileName(new Date(2026, 10, 8, 9, 5), "audio/webm")).toMatch(/\.webm$/);
  });

  test("время", () => {
    expect(formatVoiceTime(0)).toBe("0:00");
    expect(formatVoiceTime(7.9)).toBe("0:07");
    expect(formatVoiceTime(72.4)).toBe("1:12");
    expect(formatVoiceTime(725)).toBe("12:05");
  });

  test("волна: пики кусков, нормировка, нижний предел", () => {
    expect(buildWaveform([])).toEqual([]);
    expect(buildWaveform([0.1, 0.5, 0.2, 0.25], 2)).toEqual([100, 50]);
    expect(buildWaveform([0, 0, 0], 3)).toEqual([4, 4, 4]);
    expect(buildWaveform([0.5], 3)).toEqual([100, 100, 100]);
    expect(resampleWaveform(undefined, 3)).toEqual([30, 30, 30]);
    expect(resampleWaveform([0, 100], 4)).toEqual([4, 4, 100, 100]);
  });

  test("жест удержания", () => {
    expect(holdGesture(-10, -5)).toBe("hold");
    expect(holdGesture(-95, 0)).toBe("cancel");
    expect(holdGesture(5, -80)).toBe("lock");
    expect(holdGesture(-70, -80)).toBe("hold");
  });

  test("подписи и скорость", () => {
    expect(attachmentsLabel([{ mime: "audio/webm", voice: true }])).toBe("Голосовое сообщение");
    expect(attachmentsLabel([{ mime: "audio/mpeg" }])).toBe("Файл");
    expect(attachmentsLabel([{ mime: "image/png" }])).toBe("Фото");
    expect(attachmentsLabel([])).toBe("");
    expect([1, 1.5, 2].map(nextVoiceRate)).toEqual([1.5, 2, 1]);
  });
});

describe("эмодзи", () => {
  const groups = parseEmojiGroups(EMOJI_GROUPS);

  test("весь набор: разделы и сотни эмодзи", () => {
    expect(groups.map((g) => g.key)).toEqual([
      "smileys",
      "people",
      "nature",
      "food",
      "travel",
      "activities",
      "objects",
      "symbols",
      "flags",
    ]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBeGreaterThan(1500);
    expect(groups[0].items[0].emoji).toBe("😀");
  });

  test("поиск по-русски и по-английски, по началу слова", () => {
    const hit = (q: string) => searchEmoji(groups, q).map((x) => x.emoji);
    expect(hit("смеется до слез")).toContain("😂");
    expect(hit("ржач")).toContain("😂");
    expect(hit("lol")).toContain("😂");
    expect(hit("сердц")).toContain("❤️");
    expect(hit("Огонь")[0]).toBe("🔥");
    expect(hit("флаг россия")).toContain("🇷🇺");
    expect(hit("ёлка").length + hit("елка").length).toBeGreaterThan(0);
    expect(hit("   ")).toEqual([]);
    expect(hit("абракадабра")).toEqual([]);
  });

  test("недавние — свежие сверху, без повторов", () => {
    expect(pushRecent(["👍", "🔥"], "🔥")).toEqual(["🔥", "👍"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});
