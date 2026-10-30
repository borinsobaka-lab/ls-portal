import { describe, expect, test } from "bun:test";

import {
  feedbackUrl,
  formatReviewDate,
  pyFixed,
  ratingBars,
  ratingStars,
  ratingText,
  rvDefaultPeriod,
  rvInitials,
  rvPeriod,
  staffMatches,
} from "./view";

describe("подписи «Отзывов» — как у них в app.py", () => {
  test("период: текущий месяц по Москве, перевёрнутый — местами", () => {
    // 31 октября 22:30 UTC — в Москве уже 1 ноября.
    expect(rvDefaultPeriod(Date.UTC(2026, 9, 31, 22, 30))).toEqual({
      from: "2026-11-01",
      to: "2026-11-01",
    });
    expect(rvDefaultPeriod(Date.UTC(2026, 9, 15, 12))).toEqual({
      from: "2026-10-01",
      to: "2026-10-15",
    });
    expect(rvPeriod("2026-10-20", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-20" });
    expect(rvPeriod("2026-10-01", "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  test("дата оценки — их format_review_date (месяц в именительном)", () => {
    expect(formatReviewDate("2026-09-01")).toBe("1 сентябрь 2026");
    expect(formatReviewDate("2026-12-31")).toBe("31 декабрь 2026");
    expect(formatReviewDate("2026-02-30")).toBe("2026-02-30");
    expect(formatReviewDate("01.09.2026")).toBe("01.09.2026");
  });

  test("числа — round() Python: ровно посередине — к чётному", () => {
    expect(pyFixed(2.25, 1)).toBe("2.2");
    expect(pyFixed(0.125, 2)).toBe("0.12");
    expect(pyFixed(2.675, 2)).toBe("2.67");
    expect(pyFixed(4.45, 1)).toBe("4.5");
    expect(pyFixed(5, 1)).toBe("5.0");
    expect(ratingStars(4.5)).toBe("★★★★");
    expect(ratingStars(3.5)).toBe("★★★★");
    expect(ratingStars(0)).toBe("★");
    expect(ratingText(5)).toBe("5");
    expect(ratingText(4.5)).toBe("4.5");
  });

  test("инициалы, распределение, поиск сотрудника, ссылка", () => {
    expect(rvInitials("иванова анна петровна", "К")).toBe("ИА");
    expect(rvInitials("  ", "К")).toBe("К");
    expect(
      ratingBars([
        { rating: 5, count: 8 },
        { rating: 3, count: 2 },
        { rating: 4.5, count: 1 },
      ]),
    ).toEqual([
      { value: 5, count: 8, percent: 100 },
      { value: 4, count: 0, percent: 0 },
      { value: 3, count: 2, percent: 25 },
      { value: 2, count: 0, percent: 0 },
      { value: 1, count: 0, percent: 0 },
    ]);
    expect(ratingBars([])[0]).toEqual({ value: 5, count: 0, percent: 0 });
    expect(staffMatches("Иванова Анна Менеджер", "")).toBe(true);
    expect(staffMatches("Иванова Анна Менеджер", "менедж")).toBe(true);
    expect(staffMatches("Иванова Анна Менеджер", "ivanova")).toBe(true);
    expect(staffMatches("Щукина Юлия", "schukina yu")).toBe(true);
    expect(staffMatches("Иванова Анна", "петрова")).toBe(false);
    expect(feedbackUrl("https://portal.example", "abc")).toBe(
      "https://portal.example/analytics-feedback/abc",
    );
  });
});
