import { describe, expect, test } from "bun:test";

import { buildPasswordRows, detectPasswordColumns } from "./password-import";
import { parseTable } from "./import";

const users = [
  { user_id: "u1", full_name: "Семёнова Анна" },
  { user_id: "u2", full_name: "Петрова Ольга" },
  { user_id: "u3", full_name: "Иванова Мария" },
  { user_id: "u4", full_name: "Иванова Мария" },
  { user_id: "u5", full_name: null },
];

describe("импорт паролей", () => {
  test("заголовки в любом порядке", () => {
    expect(detectPasswordColumns(["Имя", "Фамилия", "Логин", "Пароль"])).toEqual({
      first: 0,
      last: 1,
      login: 2,
      password: 3,
    });
    expect(detectPasswordColumns(["Пользователь", "Логин", "Пароль"])).toEqual({
      full: 0,
      login: 1,
      password: 2,
    });
    expect(detectPasswordColumns(["Петрова Ольга", "petrova", "123456"])).toBeNull();
  });

  test("фамилия и имя — отдельными колонками, по заголовкам", () => {
    const rows = buildPasswordRows(
      parseTable("Логин\tПароль\tИмя\tФамилия\nsemenova\tqwerty1\tанна\tСеменова\n"),
      users,
    );
    expect(rows).toEqual([
      {
        line: 2,
        name: "Семенова анна",
        login: "semenova",
        password: "qwerty1",
        user_id: "u1",
        portal_name: "Семёнова Анна",
        error: null,
      },
    ]);
  });

  test("без заголовков: четыре колонки — фамилия, имя, логин, пароль", () => {
    const rows = buildPasswordRows(
      [
        ["Петрова", "Ольга", "petrova", "secret1"],
        ["Анна", "Семёнова", "semenova", "secret2"],
      ],
      users,
    );
    expect(rows.map((r) => [r.user_id, r.error])).toEqual([
      ["u2", null],
      ["u1", null],
    ]);
  });

  test("полное имя: порядок слов не важен, отчество не мешает", () => {
    const rows = buildPasswordRows(
      [
        ["Ольга Петрова", "petrova", "secret1"],
        ["Семёнова Анна Ивановна", "semenova", "secret2"],
      ],
      users,
    );
    expect(rows.map((r) => [r.user_id, r.error])).toEqual([
      ["u2", null],
      ["u1", null],
    ]);
  });

  test("ошибки строк", () => {
    const rows = buildPasswordRows(
      [
        ["Фамилия", "Имя", "Логин", "Пароль"],
        ["Петрова", "Ольга", "petrova", "secret1"],
        ["Неизвестная", "Вера", "vera", "secret2"],
        ["Иванова", "Мария", "ivanova", "secret3"],
        ["Семёнова", "", "semenova", "secret4"],
        ["", "Анна", "semenova", "secret4"],
        ["Семёнова", "Анна", "", "secret4"],
        ["Семёнова", "Анна", "se menova", "secret4"],
        ["Семёнова", "Анна", "semenova", "123"],
        ["Петрова", "Ольга", "petrova2", "secret5"],
        ["Семёнова", "Анна", "PETROVA", "secret6"],
        ["", "", "", ""],
      ],
      users,
    );
    expect(rows.map((r) => r.error)).toEqual([
      null,
      "Нет такого пользователя на портале",
      "На портале 2 человека с такими фамилией и именем — задайте в карточке",
      "Нет имени",
      "Нет фамилии",
      "Нет логина",
      "В логине есть пробелы",
      "Пароль короче 4 знаков",
      "Этот человек уже в строке 2",
      "Логин уже в строке 2",
    ]);
  });

  test("полное имя из одного слова — ошибка", () => {
    const [row] = buildPasswordRows([["Петрова", "petrova", "secret1"]], users);
    expect(row.error).toBe("Нужны и фамилия, и имя");
  });
});
