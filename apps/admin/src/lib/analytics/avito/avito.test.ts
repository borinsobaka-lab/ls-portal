import { describe, expect, test } from "bun:test";

import { avitoRegisterView, type AvitoRegisterPayload } from "./register";
import {
  avitoCampaignStart,
  avitoCheckStatus,
  avitoEntityRow,
  avitoHistoryChunks,
  avitoHistoryStart,
  avitoKeyValue,
  avitoLandingUrl,
  avitoList,
  avitoNumber,
  avitoPlanFloat,
  avitoPlanInt,
  avitoPlansForPeriod,
  avitoStatDate,
  avitoStatRows,
  avitoStatsFor,
  avitoSummaryText,
  pyParseQs,
} from "./rules";

describe("разбор ответа API — как их avito_ads.py", () => {
  test("parse_qs: пустые значения отбрасываются, %XX и «+» раскодируются", () => {
    const q = pyParseQs("utm_source=&utm_medium=cpc&a=%D0%BF%D1%80%D0%B8+%D0%B2&b&utm_medium=x");
    expect(q.get("utm_source")).toBeUndefined();
    expect(q.get("utm_medium")).toEqual(["cpc", "x"]);
    expect(q.get("a")).toEqual(["при в"]);
    expect(q.has("b")).toBe(false);
  });

  test("ссылка с UTM: первая http(s) с utm_source, вглубь словарей, не списков", () => {
    expect(avitoLandingUrl({ link: "https://x.ru/?utm_source=" })).toBe("");
    expect(
      avitoLandingUrl({
        list: ["https://x.ru/?utm_source=a"],
        target: { url: "https://x.ru/p?utm_source=avito_ads#f" },
      }),
    ).toBe("https://x.ru/p?utm_source=avito_ads#f");
    expect(avitoLandingUrl({ a: "ftp://x?utm_source=1", b: "http://y/?utm_source=1" })).toBe(
      "http://y/?utm_source=1",
    );
  });

  test("сущность: id, родители, название, UTM, старт кампании; без id — пропуск", () => {
    expect(avitoEntityRow("creatives", { id: 0 })).toBeNull();
    const row = avitoEntityRow("creatives", {
      id: 15,
      groupID: 7,
      campaignId: 3,
      name: "",
      title: "Баннер",
      link: "https://x.ru/?utm_source=avito_ads&utm_medium=cpc&utm_campaign=rk1&utm_content=a+b",
    })!;
    expect(row).toMatchObject({
      entity_id: "15",
      parent_campaign_id: "3",
      parent_group_id: "7",
      name: "Баннер",
      utm_source: "avito_ads",
      utm_medium: "cpc",
      utm_campaign: "rk1",
      utm_content: "a b",
      start_date: null,
    });
    expect(avitoCampaignStart({ startDate: "", createdAt: "2026-07-01T00:00:00Z" })).toBe(
      "2026-07-01",
    );
    expect(avitoCampaignStart({ startDate: 1724000000, created_at: "нет" })).toBeNull();
  });

  test("список: total их int(total or len)", () => {
    expect(avitoList("campaigns", { campaigns: [{}, {}], total: "5" }).total).toBe(5);
    expect(avitoList("groups", { groups: [{}, {}] }).total).toBe(2);
    expect(avitoList("creatives", []).total).toBe(0);
  });

  test("строки статистики: первый список словарей со статистикой, вглубь", () => {
    expect(avitoStatRows({ meta: { n: 1 }, result: { items: [{ date: "2026-10-01" }] } })).toEqual([
      { date: "2026-10-01" },
    ]);
    expect(avitoStatRows({ tags: [{ name: "x" }], data: [] })).toEqual([]);
    expect(avitoStatRows([{ date: "2026-10-01" }])).toEqual([]);
  });

  test("дата строки: ISO, метка времени (UTC), иначе пусто", () => {
    expect(avitoStatDate({ date: "2026-10-05T00:00:00+03:00" })).toBe("2026-10-05");
    expect(avitoStatDate({ date: "", timestamp: 1759626000 })).toBe("2025-10-05");
    expect(avitoStatDate({ day: "1759626000" })).toBe("2025-10-05");
    expect(avitoStatDate({ date: "05.10.2026" })).toBe("");
    expect(avitoStatDate({})).toBe("");
  });

  test("число: по первому ключу (нет ключа — 0), не число — следующий ключ", () => {
    expect(avitoNumber({ impressions: 99 }, "shows", "impressions")).toBe(0);
    expect(avitoNumber({ shows: "abc", impressions: "12" }, "shows", "impressions")).toBe(12);
    expect(avitoNumber({ spend: " 1_000.5 " }, "spend")).toBe(1000.5);
    expect(avitoNumber({ spend: true }, "spend")).toBe(1);
  });

  test("строки дня кампании: без даты — пропуск, показы и клики — целые", () => {
    const rows = avitoStatsFor("c1", {
      items: [
        { date: "2026-10-01", shows: 10.9, clicks: "3", spend: "12.30" },
        { timestamp: 1759626000, impressions: 5, clicks: 1, spend: 2 },
        { shows: 1 },
      ],
    });
    expect(rows).toEqual([
      { campaign_id: "c1", stat_date: "2026-10-01", shows: 10, clicks: 3, spent: 12.3 },
      { campaign_id: "c1", stat_date: "2025-10-05", shows: 0, clicks: 1, spent: 2 },
    ]);
  });

  test("история: самый ранний старт, иначе 100 дней; блоки по 100 дней", () => {
    expect(avitoHistoryStart(["2026-09-11", null, "2026-08-11"], "2026-10-30")).toBe("2026-08-11");
    expect(avitoHistoryStart([null], "2026-10-30")).toBe("2026-07-23");
    expect(avitoHistoryChunks("2026-01-01", "2026-05-01")).toEqual([
      ["2026-01-01", "2026-04-10"],
      ["2026-04-11", "2026-05-01"],
    ]);
  });
});

describe("подписи и формы", () => {
  test("ключи: пусто, длиннее 200, обрезка пробелов", () => {
    expect(avitoKeyValue("   ")).toEqual({ kind: "empty" });
    expect(avitoKeyValue("x".repeat(201))).toEqual({ kind: "long" });
    expect(avitoKeyValue(" id ")).toEqual({ kind: "ok", value: "id" });
  });

  test("статус проверки и структура", () => {
    expect(avitoCheckStatus(200, "2026-10-30")).toBe("проверен");
    expect(avitoCheckStatus(0, "2026-10-30")).toBe("не удалось проверить");
    expect(avitoCheckStatus(null, null)).toBe("не проверен");
    expect(avitoSummaryText(null)).toBe("—");
    expect(avitoSummaryText({})).toBe("данные не получены");
    expect(avitoSummaryText({ groups: { total: 5 }, campaigns: { total: 3 } })).toBe(
      "campaigns: 3 · groups: 5",
    );
  });

  test("план: int() и float() Python, их тексты ошибок", () => {
    expect(avitoPlanInt(" 1_0 ")).toBe(10);
    expect(() => avitoPlanInt("12.5")).toThrow("invalid literal for int() with base 10: '12.5'");
    expect(avitoPlanFloat("1 250,5")).toBe(1250.5);
    expect(() => avitoPlanFloat("abc")).toThrow("could not convert string to float: 'abc'");
  });

  test("план периода: пропорционально дням, CPL — взвешенный", () => {
    const m = avitoPlansForPeriod("2026-09-16", "2026-10-15", [
      {
        month: "2026-09",
        brand: "Lady Stretch",
        city: "Абакан",
        applications_plan: 30,
        target_cpl: 1000,
      },
      {
        month: "2026-10",
        brand: "Lady Stretch",
        city: "Абакан",
        applications_plan: 31,
        target_cpl: 2000,
      },
    ]);
    const p = m.get(JSON.stringify(["Lady Stretch", "Абакан"]))!;
    expect(p.applications_plan).toBe(30);
    expect(p.budget_plan).toBe(15000 + 30000);
    expect(p.target_cpl).toBe(1500);
  });
});

describe("реестр — их avito_register_page", () => {
  const payload: AvitoRegisterPayload = {
    from: "2026-10-01",
    to: "2026-10-30",
    accounts: [
      { id: 1, name: "Абакан Авито", brand: "Lady Stretch", city: "Абакан" },
      { id: 2, name: "Абакан Авито 2", brand: "Lady Stretch", city: "Абакан" },
      { id: 3, name: "Без кампаний", brand: "Lady Jump", city: "Самара" },
    ],
    rows: [
      {
        account_id: 2,
        brand: "Lady Stretch",
        city: "Абакан",
        campaign_id: "21",
        campaign_name: "А",
        shows: 1,
        clicks: 1500,
        spent: 1000.5,
      },
      {
        account_id: 1,
        brand: "Lady Stretch",
        city: "Абакан",
        campaign_id: "11",
        campaign_name: "Б",
        shows: 1,
        clicks: 10,
        spent: 3000,
      },
      {
        account_id: 1,
        brand: "Lady Stretch",
        city: "Абакан",
        campaign_id: "12",
        campaign_name: "В",
        shows: 0,
        clicks: 0,
        spent: 0,
      },
    ],
    entities: [
      {
        account_id: 1,
        entity_type: "groups",
        entity_id: "g1",
        parent_campaign_id: "11",
        parent_group_id: "",
        name: "Группа",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
      },
      {
        account_id: 1,
        entity_type: "creatives",
        entity_id: "k1",
        parent_campaign_id: "11",
        parent_group_id: "g1",
        name: "",
        utm_medium: "cpc",
        utm_campaign: "rk1",
        utm_content: "a",
      },
      {
        account_id: 1,
        entity_type: "creatives",
        entity_id: "k2",
        parent_campaign_id: "11",
        parent_group_id: "g1",
        name: "Дубль",
        utm_medium: "cpc",
        utm_campaign: "rk1",
        utm_content: "b",
      },
      {
        account_id: 2,
        entity_type: "groups",
        entity_id: "g2",
        parent_campaign_id: "21",
        parent_group_id: "",
        name: "",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
      },
      {
        account_id: 2,
        entity_type: "creatives",
        entity_id: "k3",
        parent_campaign_id: "21",
        parent_group_id: "g2",
        name: "Тот же UTM",
        utm_medium: "cpc",
        utm_campaign: "rk1",
        utm_content: "b",
      },
    ],
    leads: [
      {
        brand: "Lady Stretch",
        city: "Абакан",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
        attribution: "source",
        leads: 2,
        qualified: 1,
        booked: 0,
        attended: 0,
        paid: 0,
      },
      {
        brand: "Lady Stretch",
        city: "Абакан",
        utm_medium: "cpc",
        utm_campaign: "rk1",
        utm_content: "a",
        attribution: "utm",
        leads: 3,
        qualified: 2,
        booked: 1,
        attended: 0,
        paid: 0,
      },
      {
        brand: "Lady Stretch",
        city: "Абакан",
        utm_medium: "cpc",
        utm_campaign: "rk1",
        utm_content: "b",
        attribution: "utm",
        leads: 4,
        qualified: 4,
        booked: 0,
        attended: 0,
        paid: 0,
      },
      {
        brand: "Lady Jump",
        city: "Самара",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
        attribution: "source",
        leads: 5,
        qualified: 0,
        booked: 0,
        attended: 0,
        paid: 0,
      },
    ],
    source_leads: [
      {
        brand: "Lady Stretch",
        city: "Абакан",
        amo_lead_id: "100",
        utm_source: "",
        utm_medium: "",
        utm_campaign: "",
        utm_content: "",
      },
    ],
    plans: [
      {
        month: "2026-10",
        brand: "Lady Stretch",
        city: "Абакан",
        applications_plan: 10,
        target_cpl: 400,
      },
    ],
  };
  const view = avitoRegisterView(payload);

  test("итоги: расход и клики кампаний, заявки — все (и без кабинета)", () => {
    expect([view.spent, view.clicks, view.leads, view.cpl]).toEqual([
      "4 000 ₽",
      "1 510",
      14,
      "286 ₽",
    ]);
  });

  test("город: кабинеты в порядке строк, план периода, CPL к цели", () => {
    expect(view.cities).toHaveLength(1);
    const c = view.cities[0];
    expect([c.title, c.cabinets, c.plan, c.clicks, c.spent, c.unmatched]).toEqual([
      "Абакан · Lady Stretch",
      "2 кабинетов",
      "10",
      "1 510",
      "4 000 ₽",
      2,
    ]);
    expect(c.fact).toEqual({ text: "9 из 10", pill: { label: "Нужно 1", tone: "warning" } });
    expect(c.cpl).toEqual({ text: "400 ₽ / 444 ₽", pill: { label: "Выше цели", tone: "warning" } });
    expect(c.accounts.map((a) => [a.name, a.campaigns.length, a.clicks, a.spent])).toEqual([
      ["Абакан Авито 2", 1, "1 500", "1 000 ₽"],
      ["Абакан Авито", 2, "10", "3 000 ₽"],
    ]);
  });

  test("заявки РК — только по UTM, который у одной кампании", () => {
    const [k11, k12] = view.cities[0].accounts[1].campaigns;
    expect([k11.name, k11.leads, k11.cpl]).toEqual(["Б", 3, "1 000 ₽"]);
    expect(k11.groups[0].creatives).toEqual([
      { name: "k1", utmCampaign: "rk1", utmContent: "a", leads: 3, qualified: 2 },
      { name: "Дубль", utmCampaign: "rk1", utmContent: "b", leads: 0, qualified: 0 },
    ]);
    expect([k12.leads, k12.cpl, k12.groups]).toEqual([0, "—", []]);
    const k21 = view.cities[0].accounts[0].campaigns[0];
    expect([k21.leads, k21.groups[0].name]).toEqual([0, "g2"]);
  });
});
