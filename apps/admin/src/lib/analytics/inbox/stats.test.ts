import { describe, expect, test } from "bun:test";

import {
  STATS_TEXT,
  extractClientPhones,
  inboxConversion,
  inboxDuration,
  inboxStatsScope,
  inboxStatsView,
  statCsv,
  statSort,
  statSortValue,
  summarizeLeadStatistics,
  summarizeManagerScopes,
  summarizeResponseStatistics,
  type StatsContext,
} from "./stats";

describe("номера телефонов (их extract_client_phones)", () => {
  test("форматы 8, +7, 7 и 10 цифр с 9 — к одному виду", () => {
    expect([...extractClientPhones("+7 (912) 345-67-89")]).toEqual(["79123456789"]);
    expect([...extractClientPhones("89123456789, 8 912 345 67 89")]).toEqual(["79123456789"]);
    expect([...extractClientPhones("9123456789")]).toEqual(["79123456789"]);
    expect([...extractClientPhones("79123456780 и 89990001122")].sort()).toEqual([
      "79123456780",
      "79990001122",
    ]);
  });
  test("не номер: внутри слова, короткий, после даты, не 7/8/9", () => {
    expect(extractClientPhones("x89123456789").size).toBe(0);
    expect(extractClientPhones("+7912345678").size).toBe(0);
    expect(extractClientPhones("дата 12.05.2024 9123456781").size).toBe(1);
    expect(extractClientPhones("12.05.20249123456781").size).toBe(0);
    expect(extractClientPhones("просто текст 12345").size).toBe(0);
  });
});

describe("скорость ответов (их summarize_response_statistics)", () => {
  test("серия входящих — одно измерение; ответ из VK закрывает ожидание", () => {
    const r = summarizeResponseStatistics(
      [
        [1, 10, "i", null, 100],
        [1, 10, "i", null, 160],
        [1, 10, "o", "u1", 400],
        [1, 10, "i", null, 500],
        [1, 10, "o", null, 600],
        [1, 10, "o", "u1", 700],
        [2, 10, "i", null, 1000],
        [2, 10, "o", "u2", 1100],
      ],
      0,
      10_000,
      null,
      null,
    );
    expect(r.managers.get("u1")).toEqual({
      response_count: 1,
      response_median_seconds: 300,
      response_p90_seconds: 300,
    });
    expect(r.managers.get("u2")?.response_count).toBe(1);
  });
  test("процентили — линейная интерполяция; фильтры менеджеров и групп", () => {
    const rows: [number, number, "i" | "o", string | null, number][] = [];
    [60, 120, 180, 240].forEach((w, i) => {
      rows.push([i + 1, 10, "i", null, 1000 * (i + 1)], [i + 1, 10, "o", "u1", 1000 * (i + 1) + w]);
    });
    const r = summarizeResponseStatistics(rows, 0, 10_000, null, null);
    expect(r.managers.get("u1")?.response_median_seconds).toBe(150);
    expect(r.managers.get("u1")?.response_p90_seconds).toBeCloseTo(222);
    expect(summarizeResponseStatistics(rows, 0, 10_000, new Set(["u2"]), null).managers.size).toBe(
      0,
    );
    expect(summarizeResponseStatistics(rows, 0, 10_000, null, new Set([20])).managers.size).toBe(0);
  });
});

describe("лиды и телефоны (их summarize_lead_statistics)", () => {
  const lead = (dialog: number, at: number, extra = {}) => ({
    dialog_id: dialog,
    lead_at: at,
    history_verified: true,
    incoming_at: at,
    community_id: 10,
    community_name: "Группа",
    city: "Тула",
    owner_id: "u1",
    reply_at: null,
    reply_user_id: null,
    ...extra,
  });
  const phone = (
    id: number,
    dialog: number,
    at: number,
    body: string,
    owner: string | null = "u1",
  ) => ({
    id,
    dialog_id: dialog,
    body,
    sent_at: at,
    phone_owner_id: owner,
    bot_before_phone: owner === null,
  });
  test("номер — один раз за историю; два разных — два; старый лид — только в «телефоны»", () => {
    const r = summarizeLeadStatistics(
      [lead(1, 100), lead(2, -500)],
      [
        phone(1, 1, 200, "89123456789"),
        phone(2, 1, 300, "+7 912 345 67 89 и 89990001122"),
        phone(3, 2, 400, "89120000000"),
        phone(4, 2, -100, "89120000000"),
      ],
      [{ user_id: "u1", day: "1970-01-01", replies: 2, dialog_ids: [1] }],
      0,
      1000,
      null,
      null,
    );
    expect([r.leads, r.phones, r.converted]).toEqual([1, 2, 2]);
    expect(r.groups).toEqual([
      {
        community_id: 10,
        name: "Группа",
        city: "Тула",
        leads: 1,
        phones: 2,
        converted: 2,
        pending_history: 0,
      },
    ]);
    expect(r.activity.get("u1")).toEqual({ dialogs: 1, phones: 2, converted_dialogs: 2 });
  });
  test("несверенная история — не лид, «идёт сверка»; номер после бота", () => {
    const r = summarizeLeadStatistics(
      [lead(1, 100, { history_verified: false })],
      [phone(1, 1, 200, "89123456789", null)],
      [],
      0,
      1000,
      null,
      null,
    );
    expect([r.leads, r.pending_history, r.bot_phones, r.phones]).toEqual([0, 1, 1, 1]);
  });
  test("группы менеджера — по назначенным в выборке", () => {
    const groups = [
      {
        community_id: 10,
        name: "А",
        city: "Т",
        leads: 3,
        phones: 2,
        converted: 1,
        pending_history: 0,
      },
      {
        community_id: 20,
        name: "Б",
        city: "Т",
        leads: 1,
        phones: 1,
        converted: 1,
        pending_history: 2,
      },
    ];
    expect(
      summarizeManagerScopes(
        new Map([
          ["u1", new Set([10, 20, 30])],
          ["u2", new Set()],
        ]),
        groups,
        new Set([10, 30]),
      ),
    ).toEqual([
      { user_id: "u1", group_count: 2, leads: 3, phones: 1, total_phones: 2, pending_history: 0 },
      { user_id: "u2", group_count: 0, leads: 0, phones: 0, total_phones: 0, pending_history: 0 },
    ]);
  });
});

describe("вид таблиц (их duration, conversion, сортировка, CSV)", () => {
  test("длительность и конверсия как у них", () => {
    expect(inboxDuration(null)).toBe("—");
    expect(inboxDuration(20)).toBe("< 1 мин");
    expect(inboxDuration(90)).toBe("2 мин");
    expect(inboxDuration(150)).toBe("2 мин");
    expect(inboxDuration(3 * 3600 + 5 * 60)).toBe("3 ч 5 мин");
    expect(inboxConversion(1, 2)).toBe("50.0%");
    expect(inboxConversion(1, 8)).toBe("12.5%");
    expect(inboxConversion(3, 0)).toBe("—");
  });
  test("сортировка: пустые в конце, минуты, проценты", () => {
    expect(statSortValue("1 ч 5 мин")).toBe(65);
    expect(statSortValue("12.5%")).toBe(12.5);
    expect(statSortValue("—")).toBeNull();
    expect(statSortValue("x", -1)).toBeNull();
    const rows = [
      { index: 0, cells: [{ text: "—" }] },
      { index: 1, cells: [{ text: "10.0%" }] },
      { index: 2, cells: [{ text: "50.0%" }] },
    ];
    expect(statSort(rows, 0, "desc").map((r) => r.index)).toEqual([2, 1, 0]);
    expect(statSort(rows, 0, "asc").map((r) => r.index)).toEqual([1, 2, 0]);
  });
  test("CSV: «;», кавычки, формулы, BOM", () => {
    expect(statCsv(["А", "Б"], [["=1+1", 'x"y']])).toBe('﻿"А";"Б"\r\n"\'=1+1";"x""y"');
  });
});

describe("фильтры и страница (их inbox_statistics_page)", () => {
  const ctx: StatsContext = {
    admin: false,
    communities: [{ id: 10, display_name: "Моя", brand: "Lady Stretch", city: "Тула" }],
    active: [10, 20],
    people: [
      {
        user_id: "11111111-1111-1111-1111-111111111111",
        full_name: "Анна",
        active: true,
        communities: [10],
      },
      {
        user_id: "22222222-2222-2222-2222-222222222222",
        full_name: "Борис",
        active: false,
        communities: [20],
      },
    ],
  };
  test("период по умолчанию, ошибки периода и чужой группы", () => {
    const s = inboxStatsScope(ctx, { managers: [], groups: [] }, "2026-10-31");
    expect([s.from, s.to, s.error]).toEqual(["2026-10-01", "2026-10-31", null]);
    expect(s.end - s.start).toBe(31 * 86400);
    // Сводка команды лид-менеджера — все активные группы.
    expect([...s.scopeGroups]).toEqual([10, 20]);
    expect(
      inboxStatsScope(
        ctx,
        { from: "2026-10-31", to: "2026-10-01", managers: [], groups: [] },
        "2026-10-31",
      ).error,
    ).toBe(STATS_TEXT.period);
    expect(
      inboxStatsScope(
        ctx,
        { from: "2024-01-01", to: "2025-01-01", managers: [], groups: [] },
        "2026-10-31",
      ).error,
    ).toBe(STATS_TEXT.period);
    expect(inboxStatsScope(ctx, { managers: [], groups: ["20"] }, "2026-10-31").error).toBe(
      STATS_TEXT.ids,
    );
    const m = inboxStatsScope(
      ctx,
      { managers: ["22222222-2222-2222-2222-222222222222"], groups: [] },
      "2026-10-31",
    );
    expect([...m.scopeGroups]).toEqual([20]);
  });
  test("лид-менеджеру — группы только свои, без блока активности; неактивный — с пометкой", () => {
    const scope = inboxStatsScope(ctx, { managers: [], groups: [] }, "2026-10-31");
    const funnel = summarizeLeadStatistics(
      [
        {
          dialog_id: 1,
          lead_at: scope.start + 10,
          history_verified: true,
          incoming_at: scope.start + 10,
          community_id: 10,
          community_name: "Моя",
          city: "Тула",
          owner_id: null,
          reply_at: null,
          reply_user_id: null,
        },
        {
          dialog_id: 2,
          lead_at: scope.start + 10,
          history_verified: true,
          incoming_at: scope.start + 10,
          community_id: 20,
          community_name: "Чужая",
          city: "Орёл",
          owner_id: null,
          reply_at: null,
          reply_user_id: null,
        },
      ],
      [],
      [],
      scope.start,
      scope.end,
      null,
      scope.scopeGroups,
    );
    const v = inboxStatsView(ctx, scope, [], funnel, null, null);
    expect(v.kpi.leads).toBe(2);
    expect(v.groupTable.rows.map((r) => r.cells[0].text)).toEqual(["Моя"]);
    expect(v.activity).toBeNull();
    expect(v.managerTable.rows.map((r) => r.cells[1].text)).toEqual(["Анна", "Борис (неактивен)"]);
  });
});
