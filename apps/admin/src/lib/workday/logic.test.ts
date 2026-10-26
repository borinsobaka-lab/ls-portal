import { describe, expect, test } from "bun:test";

import {
  formatDueTime,
  groupWorkday,
  isOverdue,
  moveId,
  tbilisiNow,
  timeInputValue,
  timeToMinutes,
  workdayErrorText,
  workdaySummary,
  type WorkdayItem,
} from "./logic";

const item = (
  id: string,
  section_id: string,
  due_time: string | null,
  sort_order = 0,
): WorkdayItem => ({
  id,
  studio_id: "s",
  section_id,
  title: id,
  details: null,
  due_time,
  sort_order,
});

describe("рабочий день", () => {
  test("день и время — по Тбилиси (UTC+4)", () => {
    expect(tbilisiNow(new Date("2026-10-25T21:30:00Z"))).toEqual({
      day: "2026-10-26",
      minutes: 90,
    });
    expect(tbilisiNow(new Date("2026-10-26T05:59:00Z"))).toEqual({
      day: "2026-10-26",
      minutes: 599,
    });
  });

  test("время пункта", () => {
    expect(timeToMinutes("10:00:00")).toBe(600);
    expect(timeToMinutes("9:05")).toBe(545);
    expect(timeToMinutes(null)).toBeNull();
    expect(timeToMinutes("25:00")).toBeNull();
    expect(formatDueTime("09:30:00")).toBe("9:30");
    expect(timeInputValue("9:05:00")).toBe("09:05");
    expect(timeInputValue(null)).toBe("");
  });

  test("просрочен — время прошло и нет отметки", () => {
    const i = item("a", "x", "10:00:00");
    expect(isOverdue(i, false, 600)).toBe(false);
    expect(isOverdue(i, false, 601)).toBe(true);
    expect(isOverdue(i, true, 900)).toBe(false);
    expect(isOverdue(item("b", "x", null), false, 1439)).toBe(false);
  });

  test("блоки по порядку, итог дня", () => {
    const groups = groupWorkday(
      {
        sections: [
          { id: "end", studio_id: "s", title: "Конец", sort_order: 2 },
          { id: "start", studio_id: "s", title: "Начало", sort_order: 1 },
        ],
        items: [
          item("light", "start", "10:00", 2),
          item("music", "start", "09:00", 1),
          item("trash", "end", "21:00", 1),
        ],
        checks: [
          {
            item_id: "music",
            day: "2026-10-26",
            checked_by: "u",
            checked_by_name: "Анна",
            checked_at: "",
          },
        ],
      },
      11 * 60,
    );
    expect(groups.map((g) => g.section.id)).toEqual(["start", "end"]);
    expect(groups[0].rows.map((r) => [r.id, !!r.check, r.overdue])).toEqual([
      ["music", true, false],
      ["light", false, true],
    ]);
    expect(workdaySummary(groups)).toEqual({ done: 1, total: 3, overdue: 1 });
  });

  test("сдвиг в порядке", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "c", 1)).toBeNull();
    expect(moveId(["a"], "x", 1)).toBeNull();
  });

  test("ошибки базы", () => {
    expect(
      workdayErrorText('new row violates row-level security policy for table "workday_items"'),
    ).toContain("владелец клуба");
    expect(workdayErrorText("workday_not_today")).toContain("сегодняшний");
    expect(workdayErrorText("что-то ещё")).toBe("что-то ещё");
  });
});
