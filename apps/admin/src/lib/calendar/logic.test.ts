import { describe, expect, test } from "bun:test";

import {
  allDayReminder,
  allDayReminderParts,
  applyRepeatPreset,
  calendarSearch,
  emptyPeriodText,
  formErrors,
  invitesText,
  quickSlotTime,
  repeatOptions,
  repeatPresetOf,
  shortWhen,
  tzCity,
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

describe("упрощённая форма и плашки", () => {
  test("повтор под дату — как в Google", () => {
    const labels = repeatOptions("2026-11-10").map((o) => o.label);
    expect(labels).toEqual([
      "Не повторять",
      "Каждый день",
      "По рабочим дням",
      "Каждую неделю по вторникам",
      "Каждый месяц 10-го числа",
      "Каждый год 10 ноября",
      "Настроить…",
    ]);
    const f = {
      freq: "none" as const,
      interval: 1,
      weekdays: [2],
      until: "",
      dayFrom: "2026-11-10",
    };
    expect(repeatPresetOf(f)).toBe("none");
    const weekly = { ...f, ...applyRepeatPreset(f, "weekly") };
    expect(weekly).toMatchObject({ freq: "weekly", weekdays: [2], interval: 1 });
    expect(repeatPresetOf(weekly)).toBe("weekly");
    expect(repeatPresetOf({ ...weekly, weekdays: [1, 3] })).toBe("custom");
    expect(repeatPresetOf({ ...weekly, interval: 2 })).toBe("custom");
    expect(repeatPresetOf({ ...weekly, freq: "monthly", until: "2027-01-01" })).toBe("custom");
    expect(repeatPresetOf({ ...weekly, freq: "workdays", interval: 3 })).toBe("workdays");
    expect(applyRepeatPreset(f, "custom").freq).toBe("weekly");
  });

  test("ошибки — по полям", () => {
    const f = newEventForm("cal", TZ, new Date("2026-11-10T07:20:00Z"));
    expect(formErrors(f, TZ)).toEqual({ title: "Напишите название" });
    expect(formErrors({ ...f, title: "x", timeTo: "09:00" }, TZ)).toEqual({
      time: "Окончание раньше начала",
    });
    expect(formErrors({ ...f, title: "x" }, TZ)).toEqual({});
  });

  test("быстрое создание: время и строка", () => {
    const now = new Date("2026-11-10T07:20:00Z"); // 10:20 МСК
    expect(quickSlotTime("2026-11-10", TZ, now)).toBe("11:00");
    expect(quickSlotTime("2026-11-11", TZ, now)).toBe("10:00");
    expect(quickSlotTime("2026-11-10", TZ, new Date("2026-11-10T17:30:00Z"))).toBe("10:00");
    expect(
      shortWhen({
        allDay: false,
        dayFrom: "2026-11-11",
        dayTo: "2026-11-11",
        timeFrom: "10:00",
        timeTo: "11:00",
      }),
    ).toMatch(/^ср, 11 нояб?\.? · 10:00–11:00$/);
  });

  test("напоминание на весь день — дни и час", () => {
    expect(allDayReminder(0, 9)).toBe(-540);
    expect(allDayReminder(1, 9)).toBe(900);
    expect(allDayReminder(7, 9)).toBe(9540);
    expect(allDayReminderParts(2340)).toEqual({ days: 2, hour: 9 });
    expect(allDayReminderParts(-480)).toEqual({ days: 0, hour: 8 });
    expect(reminderLabel(allDayReminder(1, 18), true)).toBe("За день в 18:00");
  });

  test("подписи плашек", () => {
    expect(invitesText(1)).toBe("1 приглашение ждёт ответа");
    expect(invitesText(2)).toBe("2 приглашения ждут ответа");
    expect(invitesText(5)).toBe("5 приглашений ждут ответа");
    expect(emptyPeriodText("timeGridWeek")).toBe("Событий на этой неделе нет");
    expect(tzCity("Владивосток (МСК+7)")).toBe("Владивосток");
  });

  test("адрес: день, новое событие с участником, возврат к приглашениям", () => {
    const id = "6f1c7a8e-2f4b-4b6e-9a51-0c1d2e3f4a5b";
    expect(calendarSearch({ date: "2026-11-20", new: "1", with: id })).toEqual({
      date: "2026-11-20",
      new: true,
      with: id,
    });
    expect(calendarSearch({ date: "20.11.2026", with: id })).toEqual({});
    expect(calendarSearch({ event: id, from: "invites" })).toEqual({ event: id, from: "invites" });
  });
});
