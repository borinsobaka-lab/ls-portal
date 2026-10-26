import { describe, expect, test } from "bun:test";

import { groupVisitsByMonth, visitMinutes, visitStatus } from "./visit-history";

describe("visitStatus", () => {
  test("статусы журнала → статусы истории", () => {
    expect(visitStatus("attended")).toBe("attended");
    expect(visitStatus("completed")).toBe("attended");
    expect(visitStatus("no_show")).toBe("no_show");
    expect(visitStatus("cancelled")).toBe("cancelled");
    expect(visitStatus("rejected")).toBe("cancelled");
    expect(visitStatus("booked")).toBe("unmarked");
    expect(visitStatus("waitlist")).toBeNull();
  });
});

describe("visitMinutes", () => {
  test("снимок журнала важнее времени занятия", () => {
    expect(
      visitMinutes({
        duration_min: 55,
        starts_at: "2026-10-01T10:00:00Z",
        ends_at: "2026-10-01T11:00:00Z",
      }),
    ).toBe(55);
  });
  test("без снимка — по времени занятия", () => {
    expect(
      visitMinutes({
        duration_min: null,
        starts_at: "2026-10-01T10:00:00Z",
        ends_at: "2026-10-01T10:45:00Z",
      }),
    ).toBe(45);
  });
});

describe("groupVisitsByMonth", () => {
  test("месяцы и занятия — новые сверху", () => {
    const groups = groupVisitsByMonth([
      { starts_at: "2026-09-10T10:00:00" },
      { starts_at: "2026-10-02T10:00:00" },
      { starts_at: "2026-10-12T10:00:00" },
    ]);
    expect(groups.map((g) => new Date(g.ts).getMonth())).toEqual([9, 8]);
    expect(groups[0].items.map((i) => i.starts_at)).toEqual([
      "2026-10-12T10:00:00",
      "2026-10-02T10:00:00",
    ]);
  });
});
