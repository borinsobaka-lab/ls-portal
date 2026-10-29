import { describe, expect, test } from "bun:test";

import {
  legacyEmail,
  legacyImportProblem,
  legacyRights,
  legacyRolePlan,
  legacyUserType,
  unknownGrants,
  type LegacyPerson,
} from "./legacy-people";

function person(over: Partial<LegacyPerson>): LegacyPerson {
  return {
    id: 1,
    login: "a@example.com",
    full_name: "Иванова Анна",
    role: "viewer",
    is_active: true,
    position: "",
    kind: "staff",
    is_targetologist: false,
    is_lead_manager: false,
    grants: [],
    cities: [],
    created_at: "2026-08-01T00:00:00Z",
    last_seen_at: null,
    user_id: null,
    user_name: null,
    imported_at: null,
    match_user_id: null,
    match_in_portal: null,
    ...over,
  };
}

const STARTERS = {
  an_admin: ["an.admin"],
  an_partner: ["an.partner", "an.onec.mycity", "an.mkt.ls", "an.reviews"],
  an_targetologist: ["an.targetologist"],
  an_lead_manager: ["an.inbox"],
  an_staff: [
    "an.onec.revenue",
    "an.onec.sales",
    "an.onec.classes",
    "an.onec.trials",
    "an.onec.zero",
    "an.onec.mycity",
  ],
};

describe("перенос людей со старого портала аналитики", () => {
  test("администратор — только «Администратор аналитики», выданное не нужно", () => {
    const p = person({ role: "admin", kind: "admin", grants: ["reviews", "something.html"] });
    expect(legacyRights(p)).toEqual(["an.admin"]);
    expect(unknownGrants(p)).toEqual([]);
    expect(legacyRolePlan(legacyRights(p), STARTERS)).toEqual({
      kind: "starter",
      systemKey: "an_admin",
    });
  });

  test("типичный партнёр — стартовая роль, с Lady Jump — личные права", () => {
    const p = person({
      kind: "partner",
      cities: ["Абакан"],
      grants: ["partner_city_dashboard.html", "marketing_lady_stretch", "reviews"],
    });
    expect(legacyRolePlan(legacyRights(p), STARTERS)).toEqual({
      kind: "starter",
      systemKey: "an_partner",
    });
    const lj = { ...p, grants: [...p.grants, "marketing_lady_jump"] };
    expect(legacyRolePlan(legacyRights(lj), STARTERS)).toEqual({
      kind: "personal",
      rights: ["an.mkt.lj", "an.mkt.ls", "an.onec.mycity", "an.partner", "an.reviews"],
    });
    expect(legacyUserType(p)).toBe("partner");
  });

  test("таргетолог и лид-менеджер — флаги в права; сотрудник — выданное", () => {
    const t = person({
      kind: "targetologist",
      is_targetologist: true,
      grants: ["target_register"],
    });
    expect(legacyRights(t)).toEqual(["an.targetologist", "an.vk.register"]);
    const lm = person({ kind: "lead_manager", is_lead_manager: true });
    expect(legacyRolePlan(legacyRights(lm), STARTERS)).toEqual({
      kind: "starter",
      systemKey: "an_lead_manager",
    });
    const staff = person({
      grants: [
        "revenue_city_dashboard.html",
        "subscription_sales_dashboard.html",
        "activities_dashboard.html",
        "trial_funnel_dashboard.html",
        "zero_nomenclature_dashboard.html",
        "partner_city_dashboard.html",
      ],
    });
    expect(legacyRolePlan(legacyRights(staff), STARTERS)).toEqual({
      kind: "starter",
      systemKey: "an_staff",
    });
    expect(legacyUserType(staff)).toBe("hq");
    expect(unknownGrants(person({ grants: ["reviews", "old.html"] }))).toEqual(["old.html"]);
  });

  test("почта — логин-адрес; без почты, отключённого и перенесённого не переносим", () => {
    expect(legacyEmail(" Anna@Example.COM ")).toBe("anna@example.com");
    expect(legacyEmail("anna")).toBeNull();
    expect(legacyImportProblem(person({}), "a@example.com")).toBeNull();
    expect(legacyImportProblem(person({}), null)).toBe("Нет почты — укажите её");
    expect(legacyImportProblem(person({ is_active: false }), "a@example.com")).toBe(
      "Отключён на старом портале",
    );
    expect(legacyImportProblem(person({ user_id: "u" }), "a@example.com")).toBe("Уже перенесён");
  });
});
