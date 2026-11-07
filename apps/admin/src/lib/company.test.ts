import { describe, expect, test } from "bun:test";

import {
  isOnline,
  lastSeenLabel,
  matchPerson,
  unitChildren,
  unitWithDescendants,
  type CompanyPerson,
  type CompanyUnit,
} from "./company";

const person: CompanyPerson = {
  user_id: "1",
  full_name: "Масюк Софья",
  avatar_url: null,
  email: "sonya@example.com",
  phone: "+7 912 345-67-89",
  user_type: "hq",
  position_id: "p",
  position_name: "Эксперт ОР",
  units: [{ id: "u", name: "Отдел развития", role: "member" }],
  clubs: [{ id: "c", name: "Lady Stretch Казань", role: "owner", city: "Казань" }],
  cities: ["Казань"],
  last_seen_at: null,
};

describe("справочник", () => {
  test("поиск по словам, ё = е, телефон цифрами", () => {
    expect(matchPerson(person, "софья эксперт")).toBe(true);
    expect(matchPerson(person, "развития казань")).toBe(true);
    expect(matchPerson(person, "9123456")).toBe(true);
    expect(matchPerson(person, "софья самара")).toBe(false);
    expect(matchPerson({ ...person, full_name: "Алёна" }, "алена")).toBe(true);
    expect(matchPerson(person, "  ")).toBe(true);
  });

  test("в сети и «был»", () => {
    const now = new Date("2026-11-07T15:00:00");
    expect(isOnline(new Date(now.getTime() - 60_000).toISOString(), now.getTime())).toBe(true);
    expect(isOnline(null)).toBe(false);
    expect(lastSeenLabel(null, now)).toBe("не заходил");
    expect(lastSeenLabel(new Date(now.getTime() - 30_000).toISOString(), now)).toBe("в сети");
    expect(lastSeenLabel(new Date(now.getTime() - 10 * 60_000).toISOString(), now)).toBe(
      "был 10 мин назад",
    );
    expect(lastSeenLabel(new Date("2026-11-07T09:05:00").toISOString(), now)).toBe(
      "был сегодня в 09:05",
    );
    expect(lastSeenLabel(new Date("2026-11-06T18:40:00").toISOString(), now)).toBe(
      "был вчера в 18:40",
    );
    expect(lastSeenLabel(new Date("2026-03-03T12:00:00").toISOString(), now)).toBe("был 3 марта");
    expect(lastSeenLabel(new Date("2025-03-03T12:00:00").toISOString(), now)).toBe(
      "был 3 марта 2025",
    );
  });

  test("дерево подразделений", () => {
    const u = (id: string, parent: string | null, sort = 0): CompanyUnit => ({
      id,
      parent_id: parent,
      name: id,
      description: null,
      sort_order: sort,
      members: [],
    });
    const units = [u("b", "a", 2), u("a", null), u("c", "a", 1), u("d", "c"), u("x", "missing")];
    const children = unitChildren(units);
    expect(children.get(null)!.map((x) => x.id)).toEqual(["a", "x"]);
    expect(children.get("a")!.map((x) => x.id)).toEqual(["c", "b"]);
    expect([...unitWithDescendants(children, "a")].sort()).toEqual(["a", "b", "c", "d"]);
  });
});
