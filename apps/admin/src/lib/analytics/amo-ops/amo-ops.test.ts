import { describe, expect, test } from "bun:test";

import { OpsClient, OpsFailure, opsCollect, opsValidateHost } from "../server/amo-ops.server";
import {
  buildOpsReport,
  leadReaction,
  normalizeEvents,
  normalizeTasks,
  opsReactionStats,
  opsRows,
  opsSources,
  opsTasks,
  opsWindow,
  reactionSummary,
  sanitizeEvent,
  sanitizeLead,
  sanitizeTask,
  taskStatus,
  type OpsConfig,
  type OpsLead,
  type OpsSnapshot,
} from "./rules";

/** Их tests/test_metrics.py. */
describe("их metrics", () => {
  const lead = { account_id: "a", id: "1", created_at: 100 };
  const event = (
    id: string,
    at: number,
    kind = "call_attempt",
    actor = "human",
    account = "a",
  ) => ({
    account_id: account,
    id,
    lead_id: "1",
    occurred_at: at,
    kind,
    actor_kind: actor,
  });

  test("основное действие раньше этапа, бот не в счёт", () => {
    const r = leadReaction(
      lead,
      [
        event("s", 110, "stage_changed"),
        event("b", 120, "outgoing_message", "bot"),
        event("c", 700),
      ],
      800,
    );
    expect([r.status, r.minutes]).toEqual(["primary", 10]);
  });

  test("самое раннее основное, не приоритет вида", () => {
    const r = leadReaction(
      lead,
      [event("m", 300, "outgoing_message"), event("t", 160, "task_completed")],
      800,
    );
    expect(r.kind).toBe("task_completed");
  });

  test("граница, аккаунт, создание и неизвестный автор", () => {
    const r = leadReaction(
      lead,
      [
        event("early", 99),
        event("future", 900),
        event("foreign", 120, "call_attempt", "human", "b"),
        event("unknown", 130, "call_attempt", "unknown"),
      ],
      800,
    );
    expect(r.status).toBe("not_observed");
    expect(r.unknown_actor_events).toBe(1);
  });

  test("только этап не входит в среднее", () => {
    const r = reactionSummary([lead as OpsLead], [event("s", 120, "stage_changed")], 800);
    expect(r.stage_only).toBe(1);
    expect(r.mean_minutes).toBeNull();
  });

  test("повтор события и конфликт", () => {
    const e = event("e", 160);
    expect(leadReaction(lead, [e, e], 800).minutes).toBe(1);
    expect(() => leadReaction(lead, [e, { ...e, occurred_at: 170 }], 800)).toThrow(
      "Conflicting event ID",
    );
  });

  test("завершение — по сроку на момент завершения", () => {
    const t = { current_deadline: 900, completed_at: 300, deadline_at_completion: 200 };
    expect(taskStatus(t, 800)).toBe("late");
    expect(taskStatus({ ...t, completed_at: 200 }, 800)).toBe("on_time");
  });

  test("неизвестное и будущее завершение", () => {
    expect(taskStatus({ current_deadline: 200, is_completed: true }, 800)).toBe(
      "unknown_completion",
    );
    expect(taskStatus({ current_deadline: 200, completed_at: 900 }, 800)).toBe("overdue");
  });
});

const records = () => ({
  lead: {
    id: 1,
    created_at: 110,
    updated_at: 130,
    responsible_user_id: 7,
    status_id: 143,
    pipeline_id: 1,
    name: "PRIVATE NAME",
    custom_fields_values: [
      { field_id: 55, values: [{ enum_id: 4, value: "SECRET REASON TEXT" }] },
      { field_id: 66, values: [{ value: "VK Ads" }] },
    ],
  },
  task: {
    id: 9,
    created_at: 115,
    updated_at: 170,
    entity_id: 1,
    entity_type: "leads",
    complete_till: 160,
    is_completed: true,
    text: "PRIVATE TASK TEXT",
  },
  events: [
    {
      id: "e1",
      type: "outgoing_chat_message",
      entity_id: 1,
      entity_type: "lead",
      created_at: 130,
      created_by: 7,
      value_after: [{ message: { id: "m1", text: "PRIVATE MESSAGE" } }],
    },
    {
      id: "e2",
      type: "task_completed",
      entity_id: 9,
      entity_type: "task",
      created_at: 170,
      created_by: 7,
    },
  ],
});

const config: OpsConfig = {
  close_basis_field_id: "55",
  auto_source_field_id: "66",
  manual_source_field_id: "",
  unqualified_reasons: { "4": "Дубль" },
  user_labels: {},
};

/** Клиент с подменённым get (их FakeClient и client.get = lambda). */
class FakeClient extends OpsClient {
  constructor(private answer: (path: string, query?: Record<string, unknown>) => unknown) {
    super("https://test.amocrm.ru", "fake");
  }
  override async get(path: string, query?: Record<string, never>) {
    return this.answer(path, query) as Record<string, unknown> | null;
  }
}
const fixture = () => {
  const r = records();
  return new FakeClient((path) =>
    path === "/api/v4/leads"
      ? { _embedded: { leads: [r.lead] } }
      : path === "/api/v4/tasks"
        ? { _embedded: { tasks: [r.task] } }
        : { _embedded: { events: r.events } },
  );
};

/** Их tests/test_pipeline.py. */
describe("их pipeline", () => {
  test("очистка, связь и отчёт", async () => {
    const { leads, tasks, events } = await opsCollect(fixture(), "a", config, 100, 200);
    const flat = JSON.stringify([leads, tasks, events]);
    expect(flat).not.toContain("PRIVATE");
    expect(flat).not.toContain("SECRET");
    const [normalized, unresolved] = normalizeEvents(
      leads,
      tasks,
      events,
      new Set(["7"]),
      new Set(["0"]),
    );
    expect(normalized.map((e) => e.lead_id)).toEqual(["1", "1"]);
    expect(unresolved).toEqual({});
    const snapshot: OpsSnapshot = {
      leads,
      tasks,
      events,
      config,
      humans: ["7"],
      bots: ["0"],
      coverage: "fixture",
      request_count: 3,
      limitations: [],
    };
    const report = buildOpsReport({
      account: "a",
      start: 100,
      end: 200,
      captured_at: 300,
      snapshot,
    });
    expect(report.reaction.measured).toBe(1);
    expect(report.tasks[0].status).toBe("late");
    const sources = opsSources(report, opsRows(report, "all", "all"));
    expect(sources).toEqual([{ source: "VK Ads", n: 1, u: 1, r: [["Дубль", 1]], ids: ["1"] }]);
  });

  test("неизвестный автор и контакт без связи", async () => {
    const { leads, tasks, events } = await opsCollect(
      fixture(),
      "a",
      { ...config, unqualified_reasons: {} },
      100,
      200,
    );
    events.push({ ...events[0], id: "contact", entity_type: "contact", entity_id: "5" });
    const [normalized, unresolved] = normalizeEvents(
      leads,
      tasks,
      events,
      new Set(),
      new Set(["0"]),
    );
    expect(normalized.every((e) => e.actor_kind === "unknown")).toBe(true);
    expect(unresolved.outgoing_chat_message).toBe(1);
  });

  test("фильтр дат не проглатывается", async () => {
    await expect(opsCollect(fixture(), "a", config, 140, 200)).rejects.toThrow(OpsFailure);
  });

  test("снимок после окна не выдумывает просрочку", () => {
    const t = {
      id: "9",
      created_at: 100,
      updated_at: 300,
      current_deadline: 250,
      is_completed: true,
    };
    const normalized = normalizeTasks([t as never], [], 100, 200)[0];
    expect(taskStatus(normalized, 200)).toBe("unknown_state");
  });

  test("перенос срока после завершения откатывается", () => {
    const t = {
      id: "9",
      created_at: 100,
      updated_at: 190,
      current_deadline: 300,
      is_completed: true,
    };
    const es = [
      { entity_type: "task", entity_id: "9", id: "c", type: "task_completed", occurred_at: 170 },
      {
        entity_type: "task",
        entity_id: "9",
        id: "d",
        type: "task_deadline_changed",
        occurred_at: 180,
        before: [{ task_deadline: { timestamp: 160 } }],
        after: [{ task_deadline: { timestamp: 300 } }],
      },
    ];
    const r = normalizeTasks([t as never], es as never, 100, 200)[0];
    expect(r.deadline_at_completion).toBe(160);
    expect(taskStatus(r, 200)).toBe("late");
  });

  test("адрес аккаунта", () => {
    expect(opsValidateHost("https://test.amocrm.ru/")).toBe("https://test.amocrm.ru");
    for (const url of [
      "http://test.amocrm.ru",
      "https://amocrm.ru.evil.test",
      "https://x@a.amocrm.ru",
      "https://a.amocrm.ru/path",
      "https://a.amocrm.ru/?secret=x",
    ])
      expect(() => opsValidateHost(url)).toThrow(OpsFailure);
  });

  test("плохие страницы не дают ноль", async () => {
    await expect(
      new FakeClient(() => ({ _embedded: {} })).pages("/api/v4/events", "events"),
    ).rejects.toThrow("Collection absent");
    await expect(new FakeClient(() => ({})).pages("/api/v4/events", "events")).rejects.toThrow(
      OpsFailure,
    );
    expect(await new FakeClient(() => null).pages("/api/v4/events", "events")).toEqual([]);
    // Пустой next — как его нет: обычная одна страница.
    expect(
      await new FakeClient(() => ({
        _embedded: { events: [{ id: "1" }] },
        _links: { next: {} },
      })).pages("/api/v4/events", "events"),
    ).toHaveLength(1);
    await expect(
      new FakeClient(() => ({
        _embedded: { events: [{ id: "1" }] },
        _links: { next: { href: "x" } },
      })).pages("/api/v4/events", "events"),
    ).rejects.toThrow("Repeated page/object");
    await expect(
      new FakeClient(() => ({ _embedded: { events: [{ id: "" }] } })).pages(
        "/api/v4/events",
        "events",
      ),
    ).rejects.toThrow("Invalid collection item");
  });

  test("путь API только /api/v4/", async () => {
    const c = new OpsClient("https://test.amocrm.ru", "fake");
    await expect(c.get("/oauth2/access_token")).rejects.toThrow("API path is not allowed");
    await expect(c.get("/api/v4/leads?x=1")).rejects.toThrow("API path is not allowed");
    await expect(c.get("/api/v4/../account")).rejects.toThrow("API path is not allowed");
    expect(c.requests).toBe(0);
  });
});

describe("очистка фактов", () => {
  test("сделка: источник, имя ответственного, закрытие, контакты — только ID", () => {
    const l = sanitizeLead(
      {
        id: 5,
        created_at: "120",
        updated_at: 121,
        responsible_user_id: 0,
        status_id: "143",
        custom_fields_values: [
          { field_id: 66, values: [] },
          { field_id: 77, values: [{ value: "Сайт".repeat(50) }] },
        ],
        _embedded: { contacts: [{ id: 3, name: "PRIVATE" }, { id: 0 }, "x"] },
      },
      "a",
      { ...config, manual_source_field_id: "77", user_labels: { "9": "Анна" } },
    );
    expect(l.responsible_user_id).toBe("");
    expect(l.team).toBe("amo user unknown");
    expect(l.source).toHaveLength(150);
    expect(l.closed_lost).toBe(true);
    expect(l.contact_ids).toEqual(["3"]);
    expect(l.created_at).toBe(120);
    expect(
      sanitizeLead({ id: 1, created_at: 1, updated_at: 1, responsible_user_id: 9 }, "a", {
        ...config,
        user_labels: { "9": "Анна" },
      }).team,
    ).toBe("Анна");
    expect(sanitizeLead({ id: 1, created_at: 1, updated_at: 1 }, "a", config).source).toBe(
      "Источник не указан",
    );
  });

  test("задача и событие — без текстов", () => {
    const t = sanitizeTask(
      { id: 9, created_at: 1, updated_at: 2, complete_till: 3, text: "PRIVATE" },
      "a",
    );
    expect(t).toEqual({
      account_id: "a",
      id: "9",
      entity_id: "",
      entity_type: "",
      responsible_user_id: "",
      created_at: 1,
      updated_at: 2,
      current_deadline: 3,
      is_completed: false,
      task_type_id: "",
    });
    const e = sanitizeEvent(
      {
        id: "x",
        type: "lead_status_changed",
        entity_id: 4,
        entity_type: "lead",
        created_at: 10,
        created_by: 0,
        value_before: [
          { lead_status: { id: 1, pipeline_id: 2, name: "PRIVATE" } },
          { note: { text: "PRIVATE" } },
        ],
        value_after: [{ custom: { text: "PRIVATE" } }],
      },
      "a",
    );
    expect(e.created_by).toBe("0");
    expect(e.before).toEqual([{ lead_status: { id: 1, pipeline_id: 2 } }, { note: {} }]);
    expect(e.after).toEqual([]);
    expect(JSON.stringify(e)).not.toContain("PRIVATE");
  });
});

describe("страница отчёта", () => {
  const snapshot = (leads: Partial<OpsLead>[]): OpsSnapshot => ({
    leads: leads.map((l, i) => ({
      account_id: "a",
      id: String(i + 1),
      created_at: 100,
      updated_at: 100,
      responsible_user_id: "7",
      pipeline_id: "",
      status_id: "",
      team: "Анна",
      source: "VK",
      closed_lost: false,
      close_reason_id: "",
      contact_ids: [],
      ...l,
    })),
    tasks: [],
    events: [
      {
        account_id: "a",
        id: "e1",
        type: "outgoing_call",
        entity_id: "1",
        entity_type: "lead",
        occurred_at: 160,
        created_by: "7",
        before: [],
        after: [],
      },
      {
        account_id: "a",
        id: "e2",
        type: "outgoing_call",
        entity_id: "2",
        entity_type: "lead",
        occurred_at: 400,
        created_by: "8",
        before: [],
        after: [],
      },
      {
        account_id: "a",
        id: "e3",
        type: "outgoing_call",
        entity_id: "3",
        entity_type: "lead",
        occurred_at: 280,
        created_by: "0",
        before: [],
        after: [],
      },
    ],
    config: { ...config, unqualified_reasons: { "4": "Дубль", "5": "Спам" } },
    humans: ["7"],
    bots: ["0"],
    coverage: "SYNTHETIC DEMONSTRATION",
    request_count: 4,
    limitations: [],
  });

  test("реакция — по всем, кроме ботов; медиана их страницы", () => {
    const report = buildOpsReport({
      account: "a",
      start: 0,
      end: 1000,
      captured_at: 1,
      snapshot: snapshot([{}, { team: "Борис" }, {}, { source: "2024" }]),
    });
    expect(report.demo).toBe(true);
    expect(report.reaction.measured).toBe(1);
    const rows = opsRows(report, "all", "all");
    expect(rows.map((r) => r.reaction.status)).toEqual([
      "primary",
      "primary",
      "not_observed",
      "not_observed",
    ]);
    expect(rows[1].verified_reaction.unknown_actor_events).toBe(1);
    expect(opsReactionStats(rows)).toEqual({ created: 4, measured: 2, avg: 3, median: 3 });
    expect(opsRows(report, "Борис", "all").map((r) => r.id)).toEqual(["2"]);
    expect(opsRows(report, "all", "2024").map((r) => r.id)).toEqual(["4"]);
    expect(report.unknown_authors).toBe(1);
    expect(report.event_counts).toEqual({ outgoing_call: 3 });
  });

  test("неквал: только выбранные основания закрытых, порядок ключей объекта JS", () => {
    const report = buildOpsReport({
      account: "a",
      start: 0,
      end: 1000,
      captured_at: 1,
      snapshot: snapshot([
        { closed_lost: true, close_reason_id: "4" },
        { closed_lost: true, close_reason_id: "9" },
        { closed_lost: false, close_reason_id: "4" },
        { source: "2024", closed_lost: true, close_reason_id: "5" },
        { closed_lost: true, close_reason_id: "constructor" },
      ]),
    });
    const s = opsSources(report, opsRows(report, "all", "all"));
    expect(s.map((b) => [b.source, b.n, b.u])).toEqual([
      ["2024", 1, 1],
      ["VK", 4, 1],
    ]);
    expect(s[1].ids).toEqual(["1"]);
  });

  test("задачи при фильтре — только сделок выборки", () => {
    const base = snapshot([{}, { team: "Борис" }]);
    base.tasks = [
      {
        account_id: "a",
        id: "t1",
        entity_id: "1",
        entity_type: "leads",
        responsible_user_id: "7",
        created_at: 1,
        updated_at: 2,
        current_deadline: 3,
        is_completed: false,
        task_type_id: "",
      },
      {
        account_id: "a",
        id: "t2",
        entity_id: "2",
        entity_type: "lead",
        responsible_user_id: "7",
        created_at: 1,
        updated_at: 2,
        current_deadline: 3,
        is_completed: false,
        task_type_id: "",
      },
      {
        account_id: "a",
        id: "t3",
        entity_id: "9",
        entity_type: "contacts",
        responsible_user_id: "7",
        created_at: 1,
        updated_at: 2,
        current_deadline: 3,
        is_completed: false,
        task_type_id: "",
      },
    ];
    const report = buildOpsReport({
      account: "a",
      start: 0,
      end: 1000,
      captured_at: 1,
      snapshot: base,
    });
    expect(opsTasks(report, opsRows(report, "all", "all"), false)).toHaveLength(3);
    expect(opsTasks(report, opsRows(report, "Борис", "all"), true).map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(report.tasks.map((t) => t.status)).toEqual(["overdue", "overdue", "overdue"]);
  });

  test("окно — прошедший день по Москве", () => {
    expect(opsWindow("2026-10-30", "2026-10-31")).toEqual({ start: 1793307600, end: 1793393999 });
    expect(opsWindow("2026-10-31", "2026-10-31")).toBeNull();
    expect(opsWindow("2026-13-01", "2027-01-01")).toBeNull();
    expect(opsWindow("2026-02-30", "2027-01-01")).toBeNull();
    expect(opsWindow("30.10.2026", "2026-10-31")).toBeNull();
  });
});
