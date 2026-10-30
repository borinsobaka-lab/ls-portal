import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import type { Inflate } from "../onec/xlsx-read";
import { writeXlsx } from "../onec/xlsx-write";
import {
  vkChunks,
  vkDecimal,
  vkFormPlanIds,
  vkInt,
  vkItems,
  vkPlansPath,
  vkRetryDelayMs,
  vkStatRows,
  vkStatsPath,
  vkTransient,
  vkUrl,
  vkYesterdayUtc,
} from "./api";
import { vkAccountsFromXlsx } from "./import";
import {
  vkAccountMatches,
  vkBalanceSort,
  vkNumber,
  vkSpendCells,
  vkSpendTotals,
  vkVerification,
  type VkAccountRow,
  type VkSpendRow,
} from "./view";

const inflate: Inflate = async function* (data) {
  const s = Readable.from([Buffer.from(data)]).pipe(createInflateRaw());
  for await (const c of s) yield c as Uint8Array;
};

describe("VK Ads: правила их vk_ads.py", () => {
  test("адреса API: /api/… — от корня, остальное — от /api/v2; тестовый адрес", () => {
    expect(vkUrl("/user/account.json")).toBe("https://ads.vk.com/api/v2/user/account.json");
    expect(vkUrl("/api/v1/lead_ads/lead_forms.json")).toBe(
      "https://ads.vk.com/api/v1/lead_ads/lead_forms.json",
    );
    expect(vkUrl("/ad_plans.json", "http://127.0.0.1:1")).toBe(
      "http://127.0.0.1:1/api/v2/ad_plans.json",
    );
    expect(vkPlansPath(400)).toBe("/ad_plans.json?limit=200&offset=400");
    expect(vkStatsPath("2026-10-01", "2026-10-02", ["1", "2"])).toBe(
      "/statistics/ad_plans/day.json?date_from=2026-10-01&date_to=2026-10-02&ids=1%2C2&metrics=base",
    );
  });

  test("повторы — только сеть, 429 и 5xx; паузы 1, 2, 4… до 20 с", () => {
    expect([0, 429, 500, 502, 503, 504].every(vkTransient)).toBe(true);
    expect([200, 400, 401, 403, 404, 501].some(vkTransient)).toBe(false);
    expect([1, 2, 3, 5, 6].map(vkRetryDelayMs)).toEqual([1000, 2000, 4000, 16000, 20000]);
  });

  test("_decimal: число или «0»; int(… or 0)", () => {
    expect(vkDecimal("12.50")).toBe("12.50");
    expect(vkDecimal(" 7 ")).toBe("7");
    expect(vkDecimal("1_000.5")).toBe("1000.5");
    expect(vkDecimal(".5")).toBe(".5");
    expect(vkDecimal(12.25)).toBe("12.25");
    expect(vkDecimal("abc")).toBe("0");
    expect(vkDecimal("")).toBe("0");
    expect(vkDecimal(null)).toBe("0");
    expect(vkDecimal(true)).toBe("0");
    expect(vkDecimal("NaN")).toBe("0");
    expect(vkInt(12.9)).toBe(12);
    expect(vkInt("15")).toBe(15);
    expect(vkInt("")).toBe(0);
    expect(vkInt(null)).toBe(0);
    expect(vkInt(true)).toBe(1);
  });

  test("связи лид-формы с кампаниями — ключ ad_plan_ids на любой глубине", () => {
    const ids = vkFormPlanIds({
      id: 1,
      ad_plan_ids: [10, "11", " "],
      settings: { nested: [{ ad_plan_ids: 12 }, { other: { ad_plan_ids: [13, 10] } }] },
      ad_plan_id: 99,
    });
    expect([...ids].sort()).toEqual(["10", "11", "12", "13"]);
    expect(vkFormPlanIds({ name: "без кампаний" }).size).toBe(0);
  });

  test("items or data or [] — как в Python (пустой список — ложь)", () => {
    expect(vkItems({ items: [1] })).toEqual([1]);
    expect(vkItems({ items: [], data: [2] }, ["items", "data"])).toEqual([2]);
    expect(vkItems({ data: null })).toEqual([]);
    expect(vkItems({ items: { a: 1 } })).toEqual({ a: 1 });
  });

  test("статистика: items[].rows[] с base, без даты — начало периода", () => {
    const rows = vkStatRows(
      {
        items: [
          {
            id: 7,
            rows: [
              {
                date: "2026-10-01",
                base: { shows: 10, clicks: "2", goals: null, spent: "100.5", cpc: "" },
              },
              { base: { spent: 3 } },
            ],
          },
          { id: "", rows: [{ base: { spent: 1 } }] },
          { rows: [] },
        ],
      },
      "2026-09-30",
    );
    expect(rows).toEqual([
      {
        vk_plan_id: "7",
        stat_date: "2026-10-01",
        shows: 10,
        clicks: 2,
        goals: 0,
        spent: "100.5",
        not_ad_spent: "0",
        cpm: "0",
        cpc: "0",
        cpa: "0",
        ctr: "0",
        cr: "0",
      },
      {
        vk_plan_id: "7",
        stat_date: "2026-09-30",
        shows: 0,
        clicks: 0,
        goals: 0,
        spent: "3",
        not_ad_spent: "0",
        cpm: "0",
        cpc: "0",
        cpa: "0",
        ctr: "0",
        cr: "0",
      },
    ]);
    expect(vkStatRows({ error: "x" }, "2026-10-01")).toEqual([]);
  });

  test("пачки по 100, «вчера» — по UTC", () => {
    expect(vkChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(vkYesterdayUtc(Date.UTC(2026, 9, 1, 0, 30))).toBe("2026-09-30");
    // 22:30 UTC 31.10 — в Москве уже 1.11, а «вчера» у сборщика — 30.10.
    expect(vkYesterdayUtc(Date.UTC(2026, 9, 31, 22, 30))).toBe("2026-10-30");
  });
});

describe("VK Ads: страницы", () => {
  test('f"{x:,.2f}" с пробелом и округлением Python', () => {
    expect(vkNumber(33483.51299999999, 2)).toBe("33 483.51");
    expect(vkNumber(0.125, 2)).toBe("0.12");
    expect(vkNumber(2.675, 2)).toBe("2.67");
    expect(vkNumber(1234567.005, 2)).toBe("1 234 567.00");
    expect(vkNumber(-1234.5, 2)).toBe("-1 234.50");
    expect(vkNumber(999.995, 2)).toBe("1 000.00");
    expect(vkNumber(0, 2)).toBe("0.00");
    expect(vkNumber(1e7, 0)).toBe("10 000 000");
  });

  test("подпись ключа", () => {
    expect(vkVerification(200)).toBe("ключ проверен");
    expect(vkVerification(401)).toBe("ошибка HTTP 401");
    expect(vkVerification(0)).toBe("не проверен");
    expect(vkVerification(null)).toBe("не проверен");
  });

  const account = (p: Partial<VkAccountRow>): VkAccountRow => ({
    id: 1,
    name: "Абакан ЛС",
    vk_account_id: "123456",
    city: "Абакан",
    brand: "Lady Stretch",
    partner_name: "Иванова Анна",
    is_active: true,
    last_verified_at: null,
    last_verification_status: null,
    last_balance_at: null,
    last_balance: null,
    ...p,
  });

  test("поиск и фильтры списка — подстрока строки поиска", () => {
    const a = account({});
    const f = { query: "", city: "", partner: "" };
    expect(vkAccountMatches(a, { ...f, query: " абакан " })).toBe(true);
    expect(vkAccountMatches(a, { ...f, query: "3456" })).toBe(true);
    expect(vkAccountMatches(a, { ...f, query: "stretch" })).toBe(true);
    expect(vkAccountMatches(a, { ...f, city: "Абакан" })).toBe(true);
    expect(vkAccountMatches(a, { ...f, city: "Бийск" })).toBe(false);
    expect(vkAccountMatches(a, { ...f, partner: "Иванова Анна" })).toBe(true);
    expect(vkBalanceSort(a)).toBe(-1);
    expect(vkBalanceSort(account({ last_balance: "15234.50" }))).toBe(15234.5);
  });

  test("расходы: НДС ×1,22, СС = всего − ЛФ, без данных — прочерки", () => {
    const row = (p: Partial<VkSpendRow>): VkSpendRow => ({
      account_id: 1,
      name: "К",
      vk_account_id: "1",
      city: "",
      partner_name: "",
      is_active: true,
      platform_spent: 0,
      lead_form_spent: 0,
      updated_at: null,
      campaign_rows: 0,
      ...p,
    });
    const rows = [
      row({ platform_spent: 27445.5, lead_form_spent: 256.5, campaign_rows: 250 }),
      row({ platform_spent: 300.75, lead_form_spent: 300.75, campaign_rows: 3 }),
      row({}),
    ];
    const t = vkSpendTotals(rows);
    expect(vkNumber(t.total, 2)).toBe("33 850.42");
    expect(vkNumber(t.leadForms, 2)).toBe("679.85");
    expect(vkNumber(t.messages, 2)).toBe("33 170.58");
    expect([t.withData, t.accounts]).toEqual([2, 3]);
    expect(vkSpendCells(rows[0])).toEqual({
      has: true,
      total: "33 483.51",
      leadForms: "312.93",
      messages: "33 170.58",
      sortValue: 27445.5,
    });
    expect(vkSpendCells(rows[2])).toEqual({
      has: false,
      total: "—",
      leadForms: "—",
      messages: "—",
      sortValue: -1,
    });
  });

  test("импорт API_VK_ADS.xlsx: A — название, B — ID, E — ключ, со второй строки", async () => {
    const bytes = await writeXlsx([
      {
        name: "Кабинеты",
        rows: [
          ["Название", "ID", "Логин", "Комментарий", "Токен"],
          ["Малый", 7000001, "", "", "token-1"],
          ["  Большой  ", "7000002", null, null, " token-2 "],
          ["Без ключа", 7000003, "", "", null],
          [null, 7000004, "", "", "x"],
          ["Нулевой ID", 0, "", "", "x"],
          ["Дробный", 7.5, "", "", "x"],
        ],
      },
    ]);
    expect(await vkAccountsFromXlsx(bytes, inflate)).toEqual([
      {
        name: "Малый",
        vk_account_id: "7000001",
        token: "token-1",
        city: "",
        partner_name: "",
        brand: "",
      },
      {
        name: "Большой",
        vk_account_id: "7000002",
        token: "token-2",
        city: "",
        partner_name: "",
        brand: "",
      },
      { name: "Дробный", vk_account_id: "7.5", token: "x", city: "", partner_name: "", brand: "" },
    ]);
  });
});
