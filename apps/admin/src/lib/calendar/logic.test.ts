import { describe, expect, test } from "bun:test";

import {
  calendarSearch,
  calErrorText,
  canJoinVideo,
  eventWhen,
  formPayload,
  formProblem,
  fromWallClock,
  newEventForm,
  reminderLabel,
  rruleText,
  wallClock,
  type EventForm,
} from "./logic";

const TZ = "Europe/Moscow";

describe("время в поясе для сетки", () => {
  test("стенное время и обратно", () => {
    expect(wallClock("2026-11-10T07:00:00Z", TZ)).toBe("2026-11-10T10:00:00");
    expect(wallClock("2026-11-10T07:00:00Z", "Asia/Novosibirsk")).toBe("2026-11-10T14:00:00");
    const fc = new Date("2026-11-10T10:00:00Z"); // FullCalendar в UTC: «10:00» сетки
    expect(fromWallClock(fc, TZ).toISOString()).toBe("2026-11-10T07:00:00.000Z");
  });

  test("когда: день, весь день, через полночь", () => {
    expect(
      eventWhen(
        {
          start: "2026-11-10T07:00:00Z",
          end: "2026-11-10T08:00:00Z",
          all_day: false,
          day_from: "",
          day_to: "",
        },
        TZ,
      ),
    ).toBe("Вторник, 10 ноября · 10:00–11:00");
    expect(
      eventWhen(
        { start: "", end: "", all_day: true, day_from: "2026-11-27", day_to: "2026-11-29" },
        TZ,
      ),
    ).toBe("27 ноября – 29 ноября, весь день");
    expect(
      eventWhen(
        { start: "", end: "", all_day: true, day_from: "2026-11-27", day_to: "2026-11-27" },
        TZ,
      ),
    ).toBe("Пятница, 27 ноября, весь день");
    expect(
      eventWhen(
        {
          start: "2026-11-10T19:00:00Z",
          end: "2026-11-10T23:00:00Z",
          all_day: false,
          day_from: "",
          day_to: "",
        },
        TZ,
      ),
    ).toBe("10 ноября, 22:00 – 11 ноября, 02:00");
  });

  test("«Подключиться» — за 15 минут до начала и до конца", () => {
    const s = "2026-11-10T07:00:00Z";
    const e = "2026-11-10T08:00:00Z";
    expect(canJoinVideo(s, e, new Date("2026-11-10T06:44:00Z"))).toBe(false);
    expect(canJoinVideo(s, e, new Date("2026-11-10T06:46:00Z"))).toBe(true);
    expect(canJoinVideo(s, e, new Date("2026-11-10T08:00:00Z"))).toBe(true);
    expect(canJoinVideo(s, e, new Date("2026-11-10T08:01:00Z"))).toBe(false);
  });
});

describe("повторы и напоминания", () => {
  test("подписи повторов", () => {
    expect(rruleText({ freq: "daily" })).toBe("Каждый день");
    expect(rruleText({ freq: "workdays" })).toBe("По рабочим дням");
    expect(rruleText({ freq: "weekly", weekdays: [3, 1] })).toBe("Каждую неделю: пн, ср");
    expect(rruleText({ freq: "weekly", interval: 2, weekdays: [5] })).toBe("Каждые 2 недели: пт");
    expect(rruleText({ freq: "daily", interval: 21 })).toBe("Каждый 21 день");
    expect(rruleText({ freq: "monthly" }, "2026-01-31")).toBe("Каждый месяц, 31-го числа");
    expect(rruleText({ freq: "yearly", until: "2030-01-01" }, "2026-03-08")).toBe(
      "Каждый год, 8 марта до 1 января",
    );
    expect(rruleText(null)).toBe("");
  });

  test("подписи напоминаний", () => {
    expect(reminderLabel(0, false)).toBe("В момент начала");
    expect(reminderLabel(15, false)).toBe("За 15 мин");
    expect(reminderLabel(60, false)).toBe("За час");
    expect(reminderLabel(120, false)).toBe("За 2 часа");
    expect(reminderLabel(1440, false)).toBe("За день");
    expect(reminderLabel(10080, false)).toBe("За неделю");
    expect(reminderLabel(-540, true)).toBe("В день события в 09:00");
    expect(reminderLabel(900, true)).toBe("За день в 09:00");
    expect(reminderLabel(2340, true)).toBe("За 2 дня в 09:00");
    expect(reminderLabel(9540, true)).toBe("За неделю в 09:00");
  });
});

describe("форма события", () => {
  const base = (patch: Partial<EventForm> = {}): EventForm => ({
    ...newEventForm("cal", TZ, new Date("2026-11-10T07:20:00Z")),
    title: "Планёрка",
    ...patch,
  });

  test("новое — со следующего часа на час", () => {
    const f = newEventForm("cal", TZ, new Date("2026-11-10T07:20:00Z"));
    expect([f.dayFrom, f.timeFrom, f.dayTo, f.timeTo]).toEqual([
      "2026-11-10",
      "11:00",
      "2026-11-10",
      "12:00",
    ]);
    expect(f.weekdays).toEqual([2]);
    expect(f.reminders).toEqual([15]);
    const late = newEventForm("cal", TZ, new Date("2026-11-10T20:30:00Z"));
    expect([late.dayFrom, late.timeFrom, late.timeTo]).toEqual(["2026-11-11", "00:00", "01:00"]);
    const pick = newEventForm("cal", TZ, new Date(), {
      day: "2026-11-12",
      endDay: "2026-11-14",
      allDay: true,
    });
    expect([pick.allDay, pick.dayTo, pick.reminders]).toEqual([true, "2026-11-14", [-540]]);
  });

  test("проверки", () => {
    expect(formProblem(base({ title: " " }), TZ)).toBe("Напишите название");
    expect(formProblem(base({ timeTo: "09:00" }), TZ)).toBe("Окончание раньше начала");
    expect(formProblem(base({ freq: "weekly", weekdays: [] }), TZ)).toBe("Выберите дни недели");
    expect(formProblem(base({ freq: "daily", until: "2026-11-01" }), TZ)).toBe(
      "Повтор заканчивается раньше начала",
    );
    expect(formProblem(base(), TZ)).toBeNull();
  });

  test("данные для базы: весь день и повтор", () => {
    const p = formPayload(
      base({
        allDay: true,
        dayFrom: "2026-11-27",
        dayTo: "2026-11-29",
        freq: "weekly",
        weekdays: [5, 1, 5],
        interval: 2,
      }),
      TZ,
    );
    expect(p.starts_at).toBe("2026-11-26T21:00:00.000Z");
    expect(p.ends_at).toBe("2026-11-29T21:00:00.000Z");
    expect(p.rrule).toEqual({ freq: "weekly", interval: 2, weekdays: [1, 5] });
    expect(p.tz).toBe(TZ);
  });

  test("правка всей серии из повторения — сдвиг времени серии", () => {
    // Серия с 2 ноября 10:00; правим повторение 9 ноября: 10:00 → 11:00.
    const f = base({
      dayFrom: "2026-11-09",
      timeFrom: "11:00",
      dayTo: "2026-11-09",
      timeTo: "11:30",
    });
    const p = formPayload(f, TZ, {
      occStart: "2026-11-09T07:00:00Z",
      occEnd: "2026-11-09T07:30:00Z",
      seriesStart: "2026-11-02T07:00:00Z",
      seriesEnd: "2026-11-02T07:30:00Z",
    });
    expect([p.starts_at, p.ends_at]).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T08:30:00.000Z",
    ]);
  });
});

describe("адрес и ошибки", () => {
  test("адрес", () => {
    const id = "6f1c7a8e-2f4b-4b6e-9a51-0c1d2e3f4a5b";
    expect(calendarSearch({ event: id, at: "2026-11-10T07:00:00Z" })).toEqual({
      event: id,
      at: "2026-11-10T07:00:00Z",
    });
    expect(calendarSearch({ event: "x", at: "2026-11-10", settings: "new", invites: "1" })).toEqual(
      {
        settings: "new",
        invites: true,
      },
    );
    expect(calendarSearch({ settings: "drop table" })).toEqual({});
  });

  test("ошибки базы — понятным текстом", () => {
    expect(calErrorText(new Error("cal_forbidden"))).toBe("Нет прав на это действие в календаре");
    expect(calErrorText(new Error("cal_access_forbidden"))).toContain("всей компании");
    expect(calErrorText(new Error("что-то"))).toBe("что-то");
  });
});
