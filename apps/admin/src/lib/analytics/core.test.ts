import { describe, expect, test } from "bun:test";

import {
  activityTotals,
  auditLabel,
  defaultActivityPeriod,
  formatDuration,
  formatMsk,
  newApiKey,
  presenceDashboard,
  sha256Hex,
  type AnActivityRow,
} from "./core";
import { gptCatalog, gptDate, gptOpenApi, GPT_DASHBOARDS } from "./gpt-api";

describe("ядро их портала: подписи и расчёты", () => {
  test("format_duration — как у них", () => {
    expect(formatDuration(0)).toBe("0 сек");
    expect(formatDuration(-5)).toBe("0 сек");
    expect(formatDuration(59)).toBe("59 сек");
    expect(formatDuration(60)).toBe("1 мин");
    expect(formatDuration(125)).toBe("2 мин 5 сек");
    expect(formatDuration(3600)).toBe("1 ч 0 мин");
    expect(formatDuration(3723)).toBe("1 ч 2 мин 3 сек");
  });

  test("время — по Москве, «дд.мм.гггг чч:мм»; пусто — «—»", () => {
    expect(formatMsk("2026-10-29T21:30:00Z")).toBe("30.10.2026 00:30");
    expect(formatMsk(null)).toBe("—");
  });

  test("период по умолчанию — 30 дней по сегодня по Москве", () => {
    // 29.10 23:30 UTC — в Москве уже 30.10.
    expect(defaultActivityPeriod(Date.parse("2026-10-29T23:30:00Z"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-30",
    });
  });

  test("журнал: их подписи, неизвестное событие — как есть", () => {
    expect(auditLabel("login")).toBe("вход");
    expect(auditLabel("dashboard_view")).toBe("открыл(а) дашборд");
    expect(auditLabel("partner_cities_changed")).toBe("partner_cities_changed");
  });

  test("плитки посещаемости: визиты, время, не заходили", () => {
    const row = (visits: number, seconds: number) => ({ visits, seconds }) as AnActivityRow;
    expect(activityTotals([row(2, 50), row(0, 0), row(1, 10)])).toEqual({
      visits: 3,
      seconds: 60,
      inactive: 1,
    });
  });

  test("пульс — страницы «Аналитики» как «Главная», отчёты 1С — без пульса", () => {
    expect(presenceDashboard("/analytics")).toBe("Главная");
    expect(presenceDashboard("/analytics/admin/partners")).toBe("Главная");
    expect(presenceDashboard("/analytics/onec/revenue")).toBeNull();
    expect(presenceDashboard("/kb")).toBeNull();
    expect(presenceDashboard("/analyticsx")).toBeNull();
  });

  test("ключ API — «ls_live_» + 54 знака base64url; хеш — SHA-256", async () => {
    const key = newApiKey((b) => b.fill(255));
    expect(key).toBe(`ls_live_${"_".repeat(53)}w`);
    expect(newApiKey()).toMatch(/^ls_live_[A-Za-z0-9_-]{54}$/);
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("API для GPT", () => {
  test("каталог и схема — их тексты, адреса портала", () => {
    expect(gptCatalog().dashboards.map((d) => d.id)).toEqual(Object.keys(GPT_DASHBOARDS));
    const schema = gptOpenApi("https://portal.example.ru/");
    expect(schema.servers).toEqual([{ url: "https://portal.example.ru" }]);
    expect(Object.keys(schema.paths)).toEqual([
      "/api/analytics/v1/catalog",
      "/api/analytics/v1/dashboards/{dashboard}",
    ]);
    expect(schema.info.description).toContain("никогда не запрашивай персональные данные");
  });

  test("даты периода — только ГГГГ-ММ-ДД", () => {
    expect(gptDate("2026-10-01")).toBe("2026-10-01");
    expect(gptDate("01.10.2026")).toBeUndefined();
    expect(gptDate(null)).toBeUndefined();
  });
});
