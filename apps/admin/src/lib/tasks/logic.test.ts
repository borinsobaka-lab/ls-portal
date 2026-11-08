import { describe, expect, test } from "bun:test";

import {
  batchText,
  columnDeadline,
  deadlineColumn,
  eventText,
  filtersToParams,
  formatDeadline,
  localDay,
  localTime,
  parseTaskFilters,
  quickDeadlines,
  taskPerms,
  zoned,
} from "./logic";
import { dayKind, parseIsDayOff, type DayKind } from "./work-calendar";
import { yearsToLoad } from "./worker.server";

const MSK = "Europe/Moscow";
const NSK = "Asia/Novosibirsk";
const noCal = new Map<string, DayKind>();

describe("время в поясе человека", () => {
  test("день и время — в поясе, а не по UTC", () => {
    const d = new Date("2026-11-13T22:30:00Z");
    expect(localDay(d, MSK)).toBe("2026-11-14");
    expect(localTime(d, MSK)).toBe("01:30");
    expect(localDay(d, "UTC")).toBe("2026-11-13");
  });

  test("«18:00 в Новосибирске» — 11:00 UTC", () => {
    expect(zoned("2026-11-14", "18:00", NSK).toISOString()).toBe("2026-11-14T11:00:00.000Z");
    expect(zoned("2026-11-14", "18:00", MSK).toISOString()).toBe("2026-11-14T15:00:00.000Z");
  });

  test("подпись срока", () => {
    const now = new Date("2026-11-12T09:00:00Z"); // чт, 12:00 по Москве
    expect(formatDeadline("2026-11-12T15:00:00Z", MSK, now)).toBe("сегодня, 18:00");
    expect(formatDeadline("2026-11-13T15:00:00Z", MSK, now)).toBe("завтра, 18:00");
    expect(formatDeadline("2026-11-17T07:30:00Z", MSK, now)).toBe("вт 17.11, 10:30");
    expect(formatDeadline("2027-01-05T07:30:00Z", MSK, now)).toBe("05.01.2027, 10:30");
  });
});

describe("производственный календарь", () => {
  test("ответ isdayoff.ru: длина года и цифры", () => {
    expect(parseIsDayOff(2026, "0".repeat(365))).toBe("0".repeat(365));
    expect(parseIsDayOff(2028, "0".repeat(365))).toBeNull();
    expect(parseIsDayOff(2026, "100")).toBeNull();
    expect(parseIsDayOff(2026, `${"0".repeat(364)}9`)).toBeNull();
  });

  test("нет дня в календаре — суббота и воскресенье выходные", () => {
    expect(dayKind("2026-11-14", noCal)).toBe("off");
    expect(dayKind("2026-11-13", noCal)).toBe("work");
    expect(dayKind("2026-11-04", new Map([["2026-11-04", "off" as const]]))).toBe("off");
  });

  test("годы для загрузки: текущий, с октября — и следующий", () => {
    expect(yearsToLoad([], new Date("2026-03-01T00:00:00Z"))).toEqual([2026]);
    expect(yearsToLoad([2026], new Date("2026-10-15T00:00:00Z"))).toEqual([2027]);
    expect(yearsToLoad([2026, 2027], new Date("2026-12-01T00:00:00Z"))).toEqual([]);
  });
});

describe("быстрые сроки по рабочим дням", () => {
  test("четверг: сегодня, завтра (пт), конец недели (пт), через неделю (чт)", () => {
    const now = new Date("2026-11-12T09:00:00Z"); // чт 12:00 МСК
    const q = quickDeadlines(now, MSK, "18:00:00", noCal);
    expect(q.map((x) => x.label)).toEqual(["Сегодня", "Завтра", "Конец недели", "Через неделю"]);
    expect(q.map((x) => x.date.toISOString())).toEqual([
      "2026-11-12T15:00:00.000Z",
      "2026-11-13T15:00:00.000Z",
      "2026-11-13T15:00:00.000Z",
      "2026-11-19T15:00:00.000Z",
    ]);
  });

  test("пятница после конца дня: сегодня — до 23:59, следующий — понедельник", () => {
    const now = new Date("2026-11-13T16:00:00Z"); // пт 19:00 МСК
    const q = quickDeadlines(now, MSK, "18:00", noCal);
    expect(q[0].hint).toBe("до 23:59");
    expect(q[1].label).toBe("пн 16.11");
    expect(localDay(q[2].date, MSK)).toBe("2026-11-13");
  });

  test("праздник пропускается", () => {
    const now = new Date("2026-11-03T09:00:00Z"); // вт; 4 ноября — праздник
    const cal = new Map<string, DayKind>([["2026-11-04", "off"]]);
    const q = quickDeadlines(now, MSK, "18:00", cal);
    expect(localDay(q[1].date, MSK)).toBe("2026-11-05");
  });
});

describe("«Сроки»: колонки и перенос", () => {
  const now = new Date("2026-11-11T09:00:00Z"); // ср 12:00 МСК
  test("колонка по сроку", () => {
    expect(deadlineColumn(null, now, MSK)).toBe("none");
    expect(deadlineColumn("2026-11-10T15:00:00Z", now, MSK)).toBe("overdue");
    expect(deadlineColumn("2026-11-11T15:00:00Z", now, MSK)).toBe("today");
    expect(deadlineColumn("2026-11-12T15:00:00Z", now, MSK)).toBe("tomorrow");
    expect(deadlineColumn("2026-11-15T15:00:00Z", now, MSK)).toBe("week");
    expect(deadlineColumn("2026-11-20T15:00:00Z", now, MSK)).toBe("next");
    expect(deadlineColumn("2026-12-20T15:00:00Z", now, MSK)).toBe("later");
  });

  test("перенос в колонку — срок по рабочим дням", () => {
    const at = (k: Parameters<typeof columnDeadline>[0]) => {
      const d = columnDeadline(k, now, MSK, "18:00", noCal);
      return d ? localDay(d, MSK) : d;
    };
    expect(at("today")).toBe("2026-11-11");
    expect(at("tomorrow")).toBe("2026-11-12");
    expect(at("week")).toBe("2026-11-13");
    expect(at("next")).toBe("2026-11-20");
    expect(at("none")).toBeNull();
    expect(at("overdue")).toBeUndefined();
    expect(at("later")).toBeUndefined();
  });
});

describe("права и действия", () => {
  test("исполнитель при проверке — «На проверку», постановщик — «Завершить»", () => {
    const base = { status: "in_progress" as const, requires_review: true };
    const worker = taskPerms({ ...base, my_roles: ["assignee"] });
    expect(worker.actions.map((a) => a.label)).toEqual(["На проверку", "Отложить"]);
    expect(worker.deadline).toBe("reason");
    expect(worker.edit).toBe(false);
    const boss = taskPerms({ ...base, my_roles: ["creator"] });
    expect(boss.actions.map((a) => a.action)).toEqual(["complete", "defer", "cancel"]);
    expect(boss.actions[0].label).toBe("Завершить");
    expect(boss.deadline).toBe("free");
  });

  test("соисполнитель не завершает и не двигает срок, наблюдатель — ничего", () => {
    const co = taskPerms({ status: "new", requires_review: false, my_roles: ["coassignee"] });
    expect(co.actions.map((a) => a.action)).toEqual(["start", "defer"]);
    expect(co.deadline).toBeNull();
    const watcher = taskPerms({ status: "new", requires_review: false, my_roles: ["watcher"] });
    expect(watcher.actions).toEqual([]);
    expect(watcher.work).toBe(false);
  });

  test("на проверке у постановщика — принять или вернуть", () => {
    const p = taskPerms({ status: "review", requires_review: true, my_roles: ["creator"] });
    expect(p.actions.map((a) => a.action)).toEqual(["accept", "return", "cancel"]);
  });
});

describe("подписи", () => {
  test("сводка постановки", () => {
    expect(batchText({ total: 86, done: 60, cancelled: 0, overdue: 6 })).toBe(
      "86 задач: 60 готово, 26 в работе, 6 просрочено",
    );
    expect(batchText({ total: 2, done: 0, cancelled: 0, overdue: 0 })).toBe(
      "2 задачи: 0 готово, 2 в работе",
    );
  });

  test("история", () => {
    const name = (id: string) => ({ a: "Анна", b: "Борис" })[id] ?? id;
    const ev = (kind: string, data: Record<string, unknown>) => ({
      id: 1,
      actor_id: "a",
      kind,
      data,
      reason: null,
      created_at: "",
    });
    expect(eventText(ev("status", { from: "review", to: "in_progress" }), name, MSK)).toBe(
      "статус: На проверке → В работе",
    );
    expect(eventText(ev("delegated", { from: "a", to: "b" }), name, MSK)).toBe(
      "передал(а) задачу: Анна → Борис",
    );
    expect(eventText(ev("deadline", { from: null, to: "2026-11-14T15:00:00Z" }), name, MSK)).toBe(
      "срок: без срока → 14.11.2026, 18:00",
    );
    expect(
      eventText(
        ev("members", { added: [{ user_id: "b", role: "coassignee" }], removed: [] }),
        name,
        MSK,
      ),
    ).toBe("добавил(а): Борис (соисполнитель)");
  });
});

describe("фильтры", () => {
  test("из адреса — только допустимое", () => {
    expect(
      parseTaskFilters({
        role: "do",
        status: "new,bad,review",
        deadline: "overdue",
        dfrom: "2026-13",
        q: "отчёт",
        done: "1",
        creator: "not-a-uuid",
      }),
    ).toEqual({
      role: "do",
      status: ["new", "review"],
      deadline: "overdue",
      q: "отчёт",
      done: true,
    });
  });

  test("в параметры RPC", () => {
    const p = filtersToParams({ role: "assigned", deadline: "range", dfrom: "2026-11-01" });
    expect(p).toMatchObject({
      role: "assigned",
      deadline: "range",
      deadline_from: "2026-11-01",
      show_done: false,
    });
    expect(filtersToParams({}).role).toBe("all");
  });
});

describe("веха 4: повтор и фильтры", () => {
  test("подпись расписания", async () => {
    const { recurrenceText } = await import("./logic");
    expect(recurrenceText({ freq: "daily" }, "09:00:00")).toBe("Каждый день в 09:00");
    expect(recurrenceText({ freq: "weekly", weekdays: [3, 1] }, "10:30")).toBe("По пн, ср в 10:30");
    expect(recurrenceText({ freq: "monthly", monthday: 5 }, "09:00")).toBe(
      "Каждый месяц 5-го в 09:00",
    );
    expect(recurrenceText({ freq: "after_close", after_days: 2 }, "09:00")).toBe(
      "Через 2 дня после закрытия прежней, в 09:00",
    );
  });

  test("проект и подчинённые — в адресе и в RPC", () => {
    const f = parseTaskFilters({ project: "11111111-1111-4111-8111-111111111111", team: "1" });
    expect(f).toEqual({ project: "11111111-1111-4111-8111-111111111111", team: true });
    expect(filtersToParams(f)).toMatchObject({ scope: "team", project: f.project });
  });
});

describe("срок из шаблона", () => {
  test("через N рабочих дней к концу дня", async () => {
    const { templateDeadline, localDay: day } = await import("./logic");
    const fri = new Date("2026-11-13T09:00:00Z");
    const cal = new Map<string, DayKind>();
    expect(day(templateDeadline(fri, MSK, "18:00", cal, 0)!, MSK)).toBe("2026-11-13");
    expect(day(templateDeadline(fri, MSK, "18:00", cal, 1)!, MSK)).toBe("2026-11-16");
    expect(templateDeadline(fri, MSK, "18:00", cal, 2, "10:00")!.toISOString()).toBe(
      "2026-11-17T07:00:00.000Z",
    );
    expect(templateDeadline(fri, MSK, "18:00", cal, null)).toBeNull();
  });
});
