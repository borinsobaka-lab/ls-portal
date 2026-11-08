import { describe, expect, test } from "bun:test";

import {
  absenceOn,
  absencePeriod,
  absenceText,
  addDaysISO,
  ageText,
  birthdayWhen,
  dayMonth,
  type Absence,
} from "./people-calendar";

const abs = (p: Partial<Absence>): Absence => ({
  id: "1",
  user_id: "u",
  kind: "vacation",
  starts_on: "2026-11-10",
  ends_on: "2026-11-20",
  note: null,
  can_edit: false,
  ...p,
});

describe("дни рождения и отсутствия", () => {
  test("даты и подписи", () => {
    expect(dayMonth("2026-11-15")).toBe("15 ноября");
    expect(dayMonth("03-08")).toBe("8 марта");
    expect(absencePeriod("2026-11-18", "2026-11-20")).toBe("18–20 ноября");
    expect(absencePeriod("2026-11-28", "2026-12-03")).toBe("28 ноября — 3 декабря");
    expect(absencePeriod("2026-11-25", "2026-11-25")).toBe("25 ноября");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(ageText(30)).toBe("30 лет");
    expect(ageText(41)).toBe("41 год");
    expect(ageText(22)).toBe("22 года");
    expect(ageText(12)).toBe("12 лет");
    expect(birthdayWhen("2026-11-12", "2026-11-12")).toBe("сегодня");
    expect(birthdayWhen("2026-11-13", "2026-11-12")).toBe("завтра");
    expect(birthdayWhen("2026-11-20", "2026-11-12")).toBe("в пятницу, 20 ноября");
  });

  test("отсутствие в день и в период, подпись", () => {
    const list = [
      abs({}),
      abs({ id: "2", kind: "dayoff", starts_on: "2026-11-25", ends_on: "2026-11-25" }),
    ];
    expect(absenceOn(list, "u", "2026-11-12")?.id).toBe("1");
    expect(absenceOn(list, "u", "2026-11-21")).toBeNull();
    expect(absenceOn(list, "u", "2026-11-21", "2026-11-30")?.id).toBe("2");
    expect(absenceOn(list, "x", "2026-11-12")).toBeNull();
    expect(absenceText(list[0], "2026-11-12")).toBe("в отпуске до 20 ноября");
    expect(absenceText(list[0], "2026-11-01")).toBe("в отпуске с 10 ноября по 20 ноября");
    expect(absenceText(list[1], "2026-11-01")).toBe("отгул 25 ноября");
  });
});
