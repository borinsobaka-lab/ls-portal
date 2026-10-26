import { describe, expect, test } from "bun:test";

import { buildImportRows, detectColumns, parseTable, parseUserType } from "./import";
import {
  assignmentReach,
  findDuplicates,
  inheritedVia,
  isPlaceholderEmail,
  realEmail,
} from "./logic";

describe("parseTable", () => {
  test("копия из Excel — табуляция", () => {
    expect(parseTable("Фамилия\tИмя\nИванова\tАнна\n")).toEqual([
      ["Фамилия", "Имя"],
      ["Иванова", "Анна"],
    ]);
  });
  test("CSV с «;», кавычками и BOM", () => {
    expect(parseTable('﻿ФИО;Клубы\r\n"Петрова Ольга";"Казань, Уфа"\r\n\r\n')).toEqual([
      ["ФИО", "Клубы"],
      ["Петрова Ольга", "Казань, Уфа"],
    ]);
  });
  test("двойные кавычки внутри ячейки", () => {
    expect(parseTable('a,b\n"x ""y""",z')).toEqual([
      ["a", "b"],
      ['x "y"', "z"],
    ]);
  });
});

describe("detectColumns", () => {
  test("синонимы и регистр", () => {
    expect(detectColumns(["E-mail", "Фамилия", "ИМЯ", "Отдел", "Ещё что-то"])).toEqual({
      email: 0,
      last_name: 1,
      first_name: 2,
      unit: 3,
    });
  });
});

describe("parseUserType", () => {
  test("по подписи, началу и словам", () => {
    expect(parseUserType("Партнёр")).toBe("partner");
    expect(parseUserType("франчайзи")).toBe("partner");
    expect(parseUserType("Управляющая компания")).toBe("hq");
    expect(parseUserType("")).toBeNull();
    expect(parseUserType("космонавт")).toBe("bad");
  });
});

describe("buildImportRows", () => {
  const dict = {
    positions: [{ id: "p1", name: "Партнёр" }],
    units: [{ id: "u1", name: "Кураторы" }],
    roles: [
      { id: "r1", name: "Партнёр — аналитика", network: true },
      { id: "r2", name: "Администратор клуба", network: false },
    ],
    clubs: [{ id: "c1", name: "Набережные Челны" }],
    users: [{ user_id: "x", full_name: "Симонова Анна", email: "anna@x.ru", phone: null }],
  };
  test("поля по справочникам, предупреждения и дубли", () => {
    const { rows } = buildImportRows(
      [
        ["ФИО", "Почта", "Должность", "Подразделение", "Роль", "Клубы"],
        [
          "Петрова Ольга Ивановна",
          "OLGA@x.ru",
          "партнер",
          "Отдел развития › Кураторы",
          "Партнёр — аналитика; Администратор клуба",
          "Набережные Челны, Казань",
        ],
        ["Симонова Анна", "", "", "", "", ""],
        ["Петрова Ольга", "", "", "", "", ""],
        ["Без", "плохая почта", "", "", "", ""],
      ],
      dict,
    );
    expect(rows[0]).toMatchObject({
      line: 2,
      last_name: "Петрова",
      first_name: "Ольга",
      email: "olga@x.ru",
      position_id: "p1",
      unit_id: "u1",
      role_ids: ["r1"],
      club_ids: ["c1"],
      error: null,
      duplicate: null,
    });
    expect(rows[0].warnings).toEqual([
      "Роль «Администратор клуба» с правами в клубе — выдайте её в карточке",
      "Нет клуба «Казань»",
    ]);
    expect(rows[1].duplicate).toBe("Уже в портале: Симонова Анна");
    expect(rows[2].duplicate).toBe("Повтор строки 2");
    expect(rows[3].error).toBe("Нет фамилии или имени");
  });
});

describe("почта", () => {
  test("служебный адрес не показывается", () => {
    expect(isPlaceholderEmail("nomail-1@no-email.invalid")).toBe(true);
    expect(realEmail("nomail-1@no-email.invalid")).toBeNull();
    expect(realEmail("a@b.ru")).toBe("a@b.ru");
  });
  test("дубли: почта, телефон, фамилия и имя (ё = е)", () => {
    const users = [
      { user_id: "1", full_name: "Семёнова Анна", email: "a@b.ru", phone: "+7 917 000-00-01" },
    ];
    expect(
      findDuplicates(users, { full_name: "семенова  анна", email: "", phone: "" }).map(
        (d) => d.reason,
      ),
    ).toEqual(["name"]);
    expect(
      findDuplicates(users, { full_name: "Иванова Мария", email: "", phone: "89170000001" })[0]
        ?.reason,
    ).toBe("phone");
    expect(findDuplicates(users, { full_name: "", email: "A@B.ru", phone: "" })[0]?.reason).toBe(
      "email",
    );
    expect(
      findDuplicates(users, { full_name: "Семёнова Анна", email: "", phone: "" }, "1"),
    ).toEqual([]);
  });
});

describe("унаследованные роли", () => {
  const units = [
    { id: "a", parent_id: null, name: "A", sort_order: 0, path: [] },
    { id: "b", parent_id: "a", name: "B", sort_order: 0, path: ["a"] },
  ];
  test("через какое подразделение снимать", () => {
    const user = { units: [{ unit_id: "b", member_role: "member" as const }] };
    expect(
      inheritedVia(
        { subject_type: "unit", unit_id: "a", with_subunits: true, unit_members: "all" },
        user,
        units,
      ),
    ).toEqual({ kind: "unit", unitIds: ["b"] });
    expect(
      inheritedVia(
        { subject_type: "position", unit_id: null, with_subunits: false, unit_members: "all" },
        user,
        units,
      ),
    ).toEqual({ kind: "position" });
  });
  test("сколько человек получат роль", () => {
    const members = [
      { unit_id: "a", user_id: "1", member_role: "head" as const },
      { unit_id: "b", user_id: "2", member_role: "member" as const },
    ];
    const base = {
      subject_type: "unit" as const,
      unit_id: "a",
      position_id: null,
      unit_members: "all" as const,
    };
    expect(assignmentReach({ ...base, with_subunits: false }, members, units, []).size).toBe(1);
    expect(assignmentReach({ ...base, with_subunits: true }, members, units, []).size).toBe(2);
    expect(
      assignmentReach({ ...base, with_subunits: true, unit_members: "heads" }, members, units, [])
        .size,
    ).toBe(1);
    expect(
      assignmentReach(
        {
          subject_type: "position",
          unit_id: null,
          position_id: "p",
          with_subunits: false,
          unit_members: "all",
        },
        [],
        units,
        [
          { user_id: "1", position_id: "p" },
          { user_id: "2", position_id: null },
        ],
      ).size,
    ).toBe(1);
  });
});
