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
    expect(q.map((x) => x.label)).toEqual([
      "Сегодня",
      "Завтра",
      "Конец недели",
      "Через 5 рабочих дней",
    ]);
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

describe("этап 2: сообщение, порядок, история", () => {
  test("название из сообщения — первая непустая строка, до 300 знаков", async () => {
    const { titleFromMessage } = await import("./logic");
    expect(titleFromMessage("\n  Отчёт по Казани  \nподробности")).toBe("Отчёт по Казани");
    const long = titleFromMessage("а".repeat(400));
    expect(long.length).toBe(300);
    expect(long.endsWith("…")).toBe(true);
    expect(titleFromMessage("")).toBe("");
  });

  test("порядок списка — в адресе и в RPC, но не фильтр", async () => {
    const { parseTaskFilters, filtersToParams, hasExtraFilters } = await import("./logic");
    expect(parseTaskFilters({ sort: "urgent" })).toEqual({ sort: "urgent" });
    expect(parseTaskFilters({ sort: "bad" })).toEqual({});
    expect(filtersToParams({}).sort).toBe("deadline");
    expect(filtersToParams({ sort: "created" }).sort).toBe("created");
    expect(hasExtraFilters({ sort: "urgent" })).toBe(false);
  });

  test("история: подзадачи и результат", async () => {
    const { eventText } = await import("./logic");
    const ev = (kind: string, data: Record<string, unknown>) =>
      eventText({ id: 1, actor_id: null, kind, data, reason: null, created_at: "" }, () => "", MSK);
    expect(ev("subtask", { number: 12, title: "Ремонт" })).toBe(
      "добавил(а) подзадачу #12 «Ремонт»",
    );
    expect(ev("subtask_status", { number: 12, title: "Ремонт", to: "done" })).toBe(
      "подзадача #12 «Ремонт» — завершена",
    );
    expect(ev("parent", { from: null, to: 7 })).toBe("сделал(а) подзадачей #7");
    expect(ev("parent", { from: 7, to: null })).toBe("отвязал(а) от задачи #7");
    expect(ev("result", { cleared: false })).toBe("написал(а) результат");
  });
});

describe("мой план", () => {
  test("порядок колонки после переноса", async () => {
    const { planColumnCards, planMoveOrder } = await import("./logic");
    const card = (id: string, column_id: string | null, sort_order: number) => ({
      column_id,
      sort_order,
      task: { id },
    });
    const cards = [card("a", "x", 1), card("b", "x", 0), card("c", null, 0), card("d", "x", 2)];
    expect(planColumnCards(cards, "x").map((c) => c.task.id)).toEqual(["b", "a", "d"]);
    // Из «Не разобрано» — перед «a».
    expect(planMoveOrder(cards, "c", "x", "a")).toEqual(["b", "c", "a", "d"]);
    // Внутри колонки — в конец.
    expect(planMoveOrder(cards, "b", "x", null)).toEqual(["a", "d", "b"]);
    // В пустую колонку.
    expect(planMoveOrder(cards, "a", "y", null)).toEqual(["a"]);
    // Перед собой — место не меняется.
    expect(planMoveOrder(cards, "a", "x", "a")).toEqual(["b", "a", "d"]);
  });
});

describe("теги", () => {
  test("тег — в адресе и в RPC, история тегов", async () => {
    const { parseTaskFilters, filtersToParams, eventText } = await import("./logic");
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseTaskFilters({ tag: id })).toEqual({ tag: id });
    expect(parseTaskFilters({ tag: "Казань" })).toEqual({});
    expect(filtersToParams({ tag: id }).tag).toBe(id);
    expect(
      eventText(
        {
          id: 1,
          actor_id: null,
          kind: "tags",
          data: { added: ["Казань"], removed: ["VK"] },
          reason: null,
          created_at: "",
        },
        () => "",
        MSK,
      ),
    ).toBe("добавил(а) теги: #Казань; убрал(а) теги: #VK");
  });
});

describe("разбор интерфейса", () => {
  test("фильтры: отличие от умолчаний и счётчик «Фильтры (N)»", async () => {
    const { filtersDiffer, hiddenFilterCount, TODAY_PRESET } = await import("./logic");
    expect(filtersDiffer({})).toBe(false);
    expect(filtersDiffer({ role: "all" })).toBe(false);
    expect(filtersDiffer({ role: "do" })).toBe(true);
    expect(filtersDiffer({ done: false, q: "" })).toBe(false);
    expect(filtersDiffer(TODAY_PRESET)).toBe(true);
    expect(hiddenFilterCount({ q: "x", status: ["new"], assignee: "a" })).toBe(0);
    expect(
      hiddenFilterCount({ creator: "a", deadline: "range", cfrom: "2026-01-01", sort: "urgent" }),
    ).toBe(4);
    expect(hiddenFilterCount({ deadline: "today", sort: "created" })).toBe(0);
  });

  test("порядок с сервера по колонке", async () => {
    const { serverSort } = await import("./logic");
    expect(serverSort(null, false)).toBe("deadline");
    expect(serverSort("number", false)).toBe("created");
    expect(serverSort("title", false)).toBe("created");
    expect(serverSort("status", false)).toBe("deadline");
    expect(serverSort("number", true)).toBe("urgent");
  });

  test("кружок «выполнить»: проверка, отчёт, подзадачи", async () => {
    const { quickComplete } = await import("./logic");
    const base = {
      status: "in_progress" as const,
      requires_review: false,
      result_required: false,
      has_result: false,
      subtasks_total: 0,
      subtasks_done: 0,
    };
    expect(quickComplete({ ...base, my_roles: ["assignee"] })?.label).toBe("Завершить");
    expect(quickComplete({ ...base, my_roles: ["assignee"], requires_review: true })?.label).toBe(
      "На проверку",
    );
    expect(quickComplete({ ...base, my_roles: ["creator"], requires_review: true })?.label).toBe(
      "Завершить",
    );
    expect(quickComplete({ ...base, my_roles: ["watcher"] })).toBeNull();
    expect(quickComplete({ ...base, my_roles: ["coassignee"] })).toBeNull();
    expect(quickComplete({ ...base, my_roles: ["assignee"], status: "review" })).toBeNull();
    const q = quickComplete({
      ...base,
      my_roles: ["assignee"],
      result_required: true,
      subtasks_total: 3,
      subtasks_done: 1,
    });
    expect(q).toEqual({ label: "Завершить", needsResult: true, openSubtasks: 2 });
  });

  test("подпись закрытого срока", async () => {
    const { deadlineLockHint } = await import("./logic");
    expect(deadlineLockHint({ my_roles: ["watcher"] })).toBe("Срок меняет постановщик");
    expect(
      deadlineLockHint({ my_roles: ["assignee"], deadline_rule: "forbid", project_id: "p" }),
    ).toBe("В этом проекте срок меняет только постановщик");
  });

  test("тост после постановки", async () => {
    const { createdText } = await import("./logic");
    expect(createdText([12])).toBe("Задача #12 поставлена");
    expect(createdText([1, 2, 3])).toBe("Поставлено 3 задачи");
    expect(createdText([1, 2, 3, 4, 5])).toBe("Поставлено 5 задач");
  });

  test("расписание: черновик и правило", async () => {
    const { buildRule, ruleDraft } = await import("./logic");
    const wed = new Date(2026, 10, 11);
    const d = ruleDraft(null, wed);
    expect(d).toEqual({ freq: "weekly", weekdays: [3], monthday: "11", afterDays: "1" });
    expect(buildRule(d)).toEqual({ freq: "weekly", weekdays: [3] });
    expect(buildRule({ ...d, weekdays: [5, 1] })).toEqual({ freq: "weekly", weekdays: [1, 5] });
    expect(buildRule({ ...d, weekdays: [] })).toBeNull();
    expect(buildRule({ ...d, freq: "monthly", monthday: "32" })).toBeNull();
    expect(buildRule({ ...d, freq: "monthly", monthday: "31" })).toEqual({
      freq: "monthly",
      monthday: 31,
    });
    expect(buildRule({ ...d, freq: "after_close", afterDays: "" })).toBeNull();
    expect(buildRule({ ...d, freq: "after_close", afterDays: "0" })).toEqual({
      freq: "after_close",
      after_days: 0,
    });
    expect(buildRule({ ...d, freq: "workdays" })).toEqual({ freq: "workdays" });
    expect(ruleDraft({ freq: "monthly", monthday: 5 }, wed).monthday).toBe("5");
  });

  test("рабочих дней до срока — обратное к сроку шаблона", async () => {
    const { workdaysBetween, templateDeadline, localDay } = await import("./logic");
    // Пятница 13.11.2026 → вторник 17.11: пн, вт.
    expect(workdaysBetween("2026-11-13", "2026-11-17", noCal)).toBe(2);
    expect(workdaysBetween("2026-11-13", "2026-11-13", noCal)).toBe(0);
    // Суббота → понедельник: 0 (суббота сдвигается на понедельник).
    expect(workdaysBetween("2026-11-14", "2026-11-16", noCal)).toBe(0);
    const now = new Date("2026-11-14T09:00:00Z");
    for (const target of ["2026-11-16", "2026-11-18", "2026-11-24"]) {
      const n = workdaysBetween(localDay(now, MSK), target, noCal);
      const d = templateDeadline(now, MSK, "18:00", noCal, n);
      expect(localDay(d!, MSK)).toBe(target);
    }
  });

  test("подписи: «Все мои», «Инициатива», правило срока", async () => {
    const { ROLE_TABS, PROJECT_KIND_LABEL, DEADLINE_RULE_LABEL } = await import("./logic");
    expect(ROLE_TABS.find((t) => t.key === "all")?.title).toBe("Все мои");
    expect(PROJECT_KIND_LABEL.project).toBe("Инициатива");
    expect(Object.values(DEADLINE_RULE_LABEL)).toEqual(["Свободно", "С причиной", "Нельзя"]);
  });
});
