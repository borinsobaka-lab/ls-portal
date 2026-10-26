import { describe, expect, test } from "bun:test";

import { addMonthsISO, scheduleShortfall } from "./payments";

describe("график платежей", () => {
  test("недостача — в тетри, переплата — не недостача", () => {
    expect(scheduleShortfall(100, [50, 10, 15])).toBe(25);
    expect(scheduleShortfall(100, [33.33, 33.33, 33.34])).toBe(0);
    expect(scheduleShortfall(100, [60, 60])).toBe(0);
    expect(scheduleShortfall(100, [Number.NaN, 40])).toBe(60);
  });

  test("месяц вперёд прижимается к концу месяца", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2026-11-15", 2)).toBe("2027-01-15");
  });
});
