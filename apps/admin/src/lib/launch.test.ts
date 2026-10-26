import { describe, expect, test } from "bun:test";

import type { AdminAccess } from "./admin-access";
import { hasStudioPerms, roleSummary, scopeText } from "./access/logic";
import { CLUBS_HIDDEN, isHiddenPermission, isHiddenRole } from "./launch";
import {
  ADMIN_SECTIONS,
  canOpenPath,
  firstAllowedUrl,
  MANAGE_GROUPS,
  SECTIONS,
} from "./nav-sections";

/** Суперадминистратор: в прежней модели ему открыто всё. */
const admin: AdminAccess = {
  rights: ["portal.admin", "users.manage", "roles.manage", "structure.manage", "audit.view"],
  kbAdmin: true,
  manageAll: true,
  manageStudioIds: [],
  studios: { s1: { owner: true, sections: null } },
  rail: null,
  kb: {},
  academy: {
    is_admin: true,
    can_create: true,
    can_review: true,
    my_courses: 1,
    my_open: 0,
    to_review: 0,
  },
  analytics: { view: true, cities: [], manage: true },
};

// С VITE_SHOW_CLUBS=true (прогон логики клубов) — клубы видны, тест не к месту.
describe.skipIf(process.env.VITE_SHOW_CLUBS === "true")(
  "первый этап: разделы клубов скрыты (lib/launch.ts)",
  () => {
    test("по умолчанию клубы скрыты", () => expect(CLUBS_HIDDEN).toBe(true));

    test("в рейке — база знаний, Академия, Аналитика и Управление", () => {
      expect(SECTIONS.map((s) => s.key)).toEqual(["kb", "academy", "analytics"]);
      expect(ADMIN_SECTIONS.map((s) => s.key)).toEqual(["manage"]);
    });

    test("в Управлении нет «Клубов» (они в «Сети клубов») и переноса из 1С", () => {
      const urls = MANAGE_GROUPS.flatMap((g) => g.items.map((i) => i.url));
      expect(urls).not.toContain("/studios");
      expect(urls).not.toContain("/import-1c");
      expect(urls).toContain("/access/structure");
      expect(MANAGE_GROUPS.map((g) => g.label)).toEqual(["Знания", "Пользователи и роли"]);
    });

    test("страницы скрытых разделов закрыты даже суперадминистратору", () => {
      for (const path of [
        "/dashboard",
        "/dashboard/sales",
        "/schedule",
        "/clients",
        "/trainers",
        "/payroll",
        "/news",
        "/push-triggers",
        "/app-settings",
        "/scripts",
        "/scripts/settings",
        "/import-1c",
        "/studios",
        "/assistant",
      ])
        expect(canOpenPath(admin, "s1", path)).toBe(false);
      for (const path of [
        "/kb",
        "/academy",
        "/analytics",
        "/access",
        "/access/roles",
        "/kb-bases",
        "/access/structure",
      ])
        expect(canOpenPath(admin, "s1", path)).toBe(true);
    });

    test("первая страница — база знаний", () => expect(firstAllowedUrl(admin, "s1")).toBe("/kb"));

    test("права и стартовые роли клубов скрыты", () => {
      for (const key of [
        "studio.tier",
        "club.all",
        "club.schedule",
        "staff.directory",
        "app.content",
        "scripts",
      ])
        expect(isHiddenPermission(key)).toBe(true);
      for (const key of [
        "kb.base",
        "academy.admin",
        "analytics.view",
        "analytics.clubs",
        "studios.create",
        "users.manage",
        "portal.admin",
      ])
        expect(isHiddenPermission(key)).toBe(false);
      expect(isHiddenRole({ system_key: "studio_owner" })).toBe(true);
      expect(isHiddenRole({ system_key: "trainer" })).toBe(true);
      expect(isHiddenRole({ system_key: "superadmin" })).toBe(false);
      expect(isHiddenRole({ system_key: null })).toBe(false);
    });

    test("клубы в назначении — только по видимым правам; права разделов клубов не упоминаются", () => {
      const def = (key: string, scope: "studio" | "network") => ({
        key,
        block: "sections" as const,
        label: key === "analytics.clubs" ? "Аналитика сети: свои клубы" : key,
        hint: null,
        scope,
        levels: ["on"],
        target: null,
        sort_order: 0,
      });
      const catalog = [
        def("studio.tier", "studio"),
        def("club.all", "studio"),
        def("analytics.clubs", "studio"),
      ];
      const tierOnly = [
        { perm_key: "studio.tier", target_id: null, level: "owner" },
        { perm_key: "club.all", target_id: null, level: "on" },
      ];
      expect(hasStudioPerms(tierOnly, catalog)).toBe(false);
      const owner = [...tierOnly, { perm_key: "analytics.clubs", target_id: null, level: "on" }];
      expect(hasStudioPerms(owner, catalog)).toBe(true);
      expect(roleSummary(owner, catalog)).toEqual(["Аналитика сети: свои клубы"]);
      const names = { studio: new Map([["s1", "Тверская"]]), brand: new Map() };
      expect(scopeText({ scope_type: "studios", scope_ids: ["s1"] }, names)).toBe("Тверская");
      expect(scopeText({ scope_type: "owned", scope_ids: [] }, names)).toBe("Клубы собственника");
    });
  },
);
