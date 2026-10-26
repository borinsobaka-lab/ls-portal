import { describe, expect, test } from "bun:test";

import {
  clubsLabel,
  defaultClubId,
  resolveClubIds,
  toggleClub,
  toggleFormat,
  type ClubLite,
} from "./dashboard-clubs";

const clubs: ClubLite[] = [
  { id: "s1", name: "Ваке", format: "subscription" },
  { id: "p1", name: "Сабуртало", format: "packages" },
  { id: "s2", name: "Глдани", format: "subscription" },
  { id: "p2", name: "Дигоми", format: "packages" },
];

describe("клуб по умолчанию", () => {
  test("клуб из шапки, а без доступа к нему — первый", () => {
    expect(defaultClubId(clubs, "p2")).toBe("p2");
    expect(defaultClubId(clubs, "чужой")).toBe("s1");
    expect(defaultClubId([], "s1")).toBeNull();
  });

  test("без выбора — клуб из шапки", () => {
    expect(resolveClubIds(clubs, "p1", null)).toEqual(["p1"]);
  });

  test("недоступные и чужого формата отбрасываются", () => {
    expect(resolveClubIds(clubs, "p1", ["x", "s2", "p1", "s1"])).toEqual(["s1", "s2"]);
    expect(resolveClubIds(clubs, "p1", ["x"])).toEqual(["p1"]);
  });
});

describe("выбор клубов", () => {
  test("клуб того же формата добавляется, другого — заменяет выбор", () => {
    expect(toggleClub(clubs, ["s1"], "s2")).toEqual(["s1", "s2"]);
    expect(toggleClub(clubs, ["s1", "s2"], "p1")).toEqual(["p1"]);
  });

  test("снять можно любой, кроме последнего", () => {
    expect(toggleClub(clubs, ["s1", "s2"], "s1")).toEqual(["s2"]);
    expect(toggleClub(clubs, ["s2"], "s2")).toEqual(["s2"]);
  });

  test("все клубы формата и обратно — один", () => {
    expect(toggleFormat(clubs, ["p1"], "subscription", "p1")).toEqual(["s1", "s2"]);
    expect(toggleFormat(clubs, ["s1", "s2"], "subscription", "s2")).toEqual(["s2"]);
    expect(toggleFormat(clubs, ["s1", "s2"], "subscription", "p1")).toEqual(["s1"]);
  });

  test("подпись поля", () => {
    expect(clubsLabel(clubs, ["p1"], "Все")).toBe("Сабуртало");
    expect(clubsLabel(clubs, ["s1", "s2"], "Все подписочные")).toBe("Все подписочные");
    const many: ClubLite[] = [...clubs, { id: "s3", name: "Исани", format: "subscription" }];
    expect(clubsLabel(many, ["s1", "s3"], "Все")).toBe("2 клуба");
  });
});
