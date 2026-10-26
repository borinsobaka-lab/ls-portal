import { describe, expect, test } from "bun:test";

import {
  accessErrorText,
  effectiveDiff,
  groupCatalog,
  isoToLocalInput,
  localInputToIso,
  permLevel,
  roleProblem,
  roleSummary,
  scopeText,
  setPerm,
  splitFullName,
  subjectText,
  unitPathText,
  unitSubtree,
  unitTree,
  userStatus,
  validityText,
  type Names,
} from "./logic";
import type { Assignment, PermissionDef, RolePerm } from "./types";

/**
 * Логика разделов клубов — как после их возвращения (lib/launch.ts). Пока
 * клубы скрыты, она идёт отдельным прогоном: VITE_SHOW_CLUBS=true
 * (`bun run test`); в обычном `bun test` эти тесты пропускаются.
 */
const SHOW_CLUBS = process.env.VITE_SHOW_CLUBS === "true";

const def = (
  key: string,
  block: PermissionDef["block"],
  scope: PermissionDef["scope"],
  levels = ["on"],
  sort = 0,
): PermissionDef => ({
  key,
  block,
  label: key,
  hint: null,
  scope,
  levels,
  target: key === "kb.base" ? "kb_base" : null,
  sort_order: sort,
});

const catalog: PermissionDef[] = [
  def("studio.tier", "club", "studio", ["trainer", "admin", "owner"], 10),
  def("club.all", "club", "studio", ["on"], 20),
  def("club.schedule", "club", "studio", ["on"], 30),
  def("app.content", "sections", "network", ["on"], 110),
  def("scripts", "sections", "network", ["view", "edit"], 120),
  def("kb.base", "knowledge", "network", ["view", "edit"], 200),
  def("kb.admin", "knowledge", "network", ["on"], 210),
  def("users.manage", "admin", "studio", ["on"], 300),
];

describe.skipIf(!SHOW_CLUBS)("пользователи и роли — логика", () => {
  test("статус: блокировка, срок, без ролей, не входил", () => {
    const base = {
      status: "active" as const,
      access_until: null,
      last_sign_in_at: "x",
      portal: true,
    };
    expect(userStatus(base, "2026-10-25")).toBe("active");
    expect(userStatus({ ...base, last_sign_in_at: null }, "2026-10-25")).toBe("invited");
    expect(userStatus({ ...base, portal: false }, "2026-10-25")).toBe("no_roles");
    expect(userStatus({ ...base, access_until: "2026-10-24" }, "2026-10-25")).toBe("expired");
    expect(userStatus({ ...base, access_until: "2026-10-25" }, "2026-10-25")).toBe("active");
    expect(userStatus({ ...base, status: "blocked" }, "2026-10-25")).toBe("blocked");
  });

  test("матрица прав: поставить, снять, уровень, база знаний по id", () => {
    let perms: RolePerm[] = [];
    perms = setPerm(perms, "studio.tier", "admin");
    perms = setPerm(perms, "kb.base", "view", "b1");
    perms = setPerm(perms, "kb.base", "edit", null);
    expect(permLevel(perms, "studio.tier")).toBe("admin");
    expect(permLevel(perms, "kb.base", "b1")).toBe("view");
    expect(permLevel(perms, "kb.base")).toBe("edit");
    perms = setPerm(perms, "studio.tier", "owner");
    expect(perms.filter((p) => p.perm_key === "studio.tier")).toHaveLength(1);
    perms = setPerm(perms, "kb.base", null, "b1");
    expect(permLevel(perms, "kb.base", "b1")).toBeNull();
    expect(permLevel(perms, "kb.base")).toBe("edit");
  });

  test("разделы клуба без уровня доступа — ошибка, как в базе", () => {
    expect(
      roleProblem([{ perm_key: "club.schedule", target_id: null, level: "on" }]),
    ).not.toBeNull();
    expect(
      roleProblem([
        { perm_key: "club.schedule", target_id: null, level: "on" },
        { perm_key: "studio.tier", target_id: null, level: "trainer" },
      ]),
    ).toBeNull();
  });

  test("сводка роли и группы каталога", () => {
    const perms: RolePerm[] = [
      { perm_key: "studio.tier", target_id: null, level: "owner" },
      { perm_key: "club.all", target_id: null, level: "on" },
      { perm_key: "kb.base", target_id: null, level: "view" },
      { perm_key: "scripts", target_id: null, level: "edit" },
      { perm_key: "app.content", target_id: null, level: "on" },
      { perm_key: "users.manage", target_id: null, level: "on" },
    ];
    expect(roleSummary(perms, catalog)).toEqual([
      "Владелец клуба",
      "все разделы клуба",
      "все базы знаний: просмотр",
      "Скрипты LS: правка",
      "app.content",
      "users.manage",
    ]);
    expect(groupCatalog(catalog).map((g) => g.block)).toEqual([
      "club",
      "sections",
      "knowledge",
      "admin",
    ]);
  });

  test("область и субъект назначения словами", () => {
    const names: Names = {
      studio: new Map([
        ["s1", "Тбилиси"],
        ["s2", "Казань"],
      ]),
      brand: new Map([["b1", "Lady Stretch"]]),
      unit: new Map([["u1", "Отдел развития"]]),
      position: new Map([["p1", "Эксперт ОР"]]),
      user: new Map([["x", "Соня"]]),
    };
    expect(scopeText({ scope_type: "all", scope_ids: [] }, names)).toBe("Вся сеть");
    expect(scopeText({ scope_type: "brands", scope_ids: ["b1"] }, names)).toBe(
      "Бренд Lady Stretch",
    );
    expect(scopeText({ scope_type: "studios", scope_ids: ["s1", "s2", "s1", "s2"] }, names)).toBe(
      "Тбилиси, Казань, Тбилиси и ещё 1",
    );
    const a = {
      subject_type: "unit",
      unit_id: "u1",
      unit_members: "heads",
      with_subunits: true,
    } as Assignment;
    expect(subjectText(a, names)).toBe("«Отдел развития»: руководители, и ниже");
    expect(subjectText({ ...a, subject_type: "position", position_id: "p1" }, names)).toBe(
      "Должность «Эксперт ОР»",
    );
  });

  test("срок назначения", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(validityText({ valid_from: null, valid_until: null }, now)).toBeNull();
    expect(validityText({ valid_from: null, valid_until: "2026-10-24T12:00:00Z" }, now)).toMatch(
      /^истекло/,
    );
    expect(validityText({ valid_from: null, valid_until: "2026-11-01T12:00:00Z" }, now)).toMatch(
      /^до /,
    );
    expect(validityText({ valid_from: "2026-11-01T12:00:00Z", valid_until: null }, now)).toMatch(
      /^с /,
    );
    const iso = localInputToIso("2026-11-01T18:30");
    expect(iso && isoToLocalInput(iso)).toBe("2026-11-01T18:30");
    expect(localInputToIso("")).toBeNull();
  });

  test("дерево подразделений: порядок, ветка, путь, сироты — в корень", () => {
    const units = [
      { id: "b", parent_id: "a", name: "Кураторы", sort_order: 1 },
      { id: "a", parent_id: null, name: "Отдел развития", sort_order: 1 },
      { id: "c", parent_id: "a", name: "Аналитики", sort_order: 0 },
      { id: "z", parent_id: null, name: "Бухгалтерия", sort_order: 0 },
      { id: "o", parent_id: "missing", name: "Сирота", sort_order: 5 },
    ];
    expect(unitTree(units).map((x) => `${x.depth}:${x.unit.id}`)).toEqual([
      "0:z",
      "0:a",
      "1:c",
      "1:b",
      "0:o",
    ]);
    expect([...unitSubtree(units, "a")].sort()).toEqual(["a", "b", "c"]);
    expect(unitPathText(units, "b")).toBe("Отдел развития › Кураторы");
  });

  test("журнал: что добавилось и что ушло", () => {
    const names = {
      studio: new Map([["s1", "Тбилиси"]]),
      kbBase: new Map([["k1", "Стандарты"]]),
      perm: new Map([["kb.admin", "Администратор баз знаний"]]),
    };
    const diff = effectiveDiff(
      { studios: { s1: { tier: "trainer", sections: ["schedule"] } }, rights: [], rails: [] },
      {
        studios: { s1: { tier: "admin", sections: null } },
        kb: { k1: "view" },
        rights: ["kb.admin"],
        rails: [],
      },
      names,
    );
    expect(diff.added).toEqual([
      "Администратор баз знаний",
      "База знаний «Стандарты»: просмотр",
      "Клуб «Тбилиси»: Администратор, все разделы",
    ]);
    expect(diff.removed).toEqual(["Клуб «Тбилиси»: Сотрудник, разделов: 1"]);
  });

  test("ошибки базы — понятным текстом", () => {
    expect(accessErrorText("access_last_superadmin")).toBe(
      "Нельзя оставить портал без суперадминистратора",
    );
    expect(accessErrorText("access_grant_denied", "Можно только в своих клубах")).toBe(
      "Можно только в своих клубах",
    );
    expect(
      accessErrorText('duplicate key value violates unique constraint "access_roles_name_uidx"'),
    ).toBe("Роль с таким названием уже есть");
    expect(accessErrorText("что-то другое")).toBe("что-то другое");
    expect(splitFullName("Иванова Анна Мария")).toEqual({
      last_name: "Иванова",
      first_name: "Анна Мария",
    });
  });
});
