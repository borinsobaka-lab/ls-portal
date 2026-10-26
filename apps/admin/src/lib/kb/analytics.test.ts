import { describe, expect, test } from "bun:test";

import {
  dayLabels,
  formatAgo,
  formatDuration,
  formatUpdatedAgo,
  percentText,
  plural,
  share,
} from "./analytics";

describe("аналитика чтения", () => {
  test("время чтения", () => {
    expect(formatDuration(0)).toBe("0 мин");
    expect(formatDuration(45)).toBe("45 с");
    expect(formatDuration(89)).toBe("1 мин");
    expect(formatDuration(12 * 60)).toBe("12 мин");
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe("2 ч 5 мин");
    expect(formatDuration(2 * 3600)).toBe("2 ч");
  });

  test("когда — по календарным дням", () => {
    const now = new Date(2026, 9, 25, 10, 0);
    expect(formatAgo(null, now)).toBe("никогда");
    expect(formatAgo(new Date(2026, 9, 25, 0, 5).toISOString(), now)).toBe("сегодня");
    expect(formatAgo(new Date(2026, 9, 24, 23, 50).toISOString(), now)).toBe("вчера");
    expect(formatAgo(new Date(2026, 9, 20, 12, 0).toISOString(), now)).toBe("5 дн. назад");
    expect(formatAgo(new Date(2026, 7, 1).toISOString(), now)).toContain("2026");
  });

  test("доли без деления на ноль", () => {
    expect(share(1, 0)).toBe(0);
    expect(percentText(2, 3)).toBe("67%");
    expect(percentText(0, 0)).toBe("—");
  });

  test("склонение", () => {
    const f: [string, string, string] = ["статья", "статьи", "статей"];
    expect(plural(1, f)).toBe("1 статья");
    expect(plural(4, f)).toBe("4 статьи");
    expect(plural(11, f)).toBe("11 статей");
    expect(plural(22, f)).toBe("22 статьи");
    expect(plural(25, f)).toBe("25 статей");
  });

  test("подписи дня", () => {
    const d = dayLabels("2026-10-25");
    expect(d.tick).toContain("25");
    expect(d.label).toContain("25");
  });

  test("«Обновлено …» в шапке статьи", () => {
    const now = new Date(2026, 9, 25, 10, 0);
    expect(formatUpdatedAgo(new Date(2026, 9, 25, 0, 5).toISOString(), now)).toBe("сегодня");
    expect(formatUpdatedAgo(new Date(2026, 9, 24, 12, 0).toISOString(), now)).toBe("вчера");
    expect(formatUpdatedAgo(new Date(2026, 9, 14, 12, 0).toISOString(), now)).toBe("11 дней назад");
    expect(formatUpdatedAgo(new Date(2026, 9, 22, 12, 0).toISOString(), now)).toBe("3 дня назад");
    expect(formatUpdatedAgo(new Date(2026, 9, 4, 12, 0).toISOString(), now)).toBe("21 день назад");
  });
});
