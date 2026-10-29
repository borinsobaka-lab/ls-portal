import { describe, expect, test } from "bun:test";

import { anCan, parseAnMe } from "./access";

describe("права в «Аналитике» (их allowed_dashboards)", () => {
  test("ответ базы: незнакомые отчёты отбрасываются, партнёр и таргетолог — как есть", () => {
    const me = parseAnMe({
      visible: true,
      admin: false,
      reports: ["onec.mycity", "mkt.ls", "что-то новое"],
      partner_cities: ["Абакан"],
      targetologist: null,
      inbox: false,
    });
    expect(me.reports).toEqual(["onec.mycity", "mkt.ls"]);
    expect(me.partnerCities).toEqual(["Абакан"]);
    expect(parseAnMe(null).visible).toBe(false);
  });

  test("пункт меню: главная — по видимости, администрирование — администратору, отчёт — выданный", () => {
    const partner = parseAnMe({
      visible: true,
      admin: false,
      reports: ["onec.mycity"],
      partner_cities: ["Абакан"],
      targetologist: null,
      inbox: false,
    });
    expect(anCan(partner, "home")).toBe(true);
    expect(anCan(partner, "onec.mycity")).toBe(true);
    expect(anCan(partner, "onec.revenue")).toBe(false);
    expect(anCan(partner, "admin")).toBe(false);
    expect(anCan(partner, "inbox")).toBe(false);

    const admin = parseAnMe({
      visible: true,
      admin: true,
      reports: [],
      partner_cities: null,
      targetologist: null,
      inbox: true,
    });
    expect(anCan(admin, "onec.revenue")).toBe(true);
    expect(anCan(admin, "admin")).toBe(true);
    expect(anCan(undefined, "home")).toBe(false);
  });
});
