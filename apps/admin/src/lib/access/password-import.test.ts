import { describe, expect, test } from "bun:test";

import { buildPasswordRows, isHeaderRow } from "./password-import";
import { parseTable } from "./import";

const users = [
  { user_id: "u1", full_name: "Семёнова Анна" },
  { user_id: "u2", full_name: "Петрова Ольга" },
  { user_id: "u3", full_name: "Иванова Мария" },
  { user_id: "u4", full_name: "Иванова Мария" },
  { user_id: "u5", full_name: null },
];

describe("импорт паролей", () => {
  test("заголовок пропускается, имя — без регистра, ё и лишних пробелов", () => {
    expect(isHeaderRow(["Пользователь", "Логин", "Пароль"])).toBe(true);
    expect(isHeaderRow(["Петрова Ольга", "petrova", "123456"])).toBe(false);
    const rows = buildPasswordRows(
      parseTable("Имя пользователя\tЛогин\tПароль\nсеменова  анна\tsemenova\tqwerty1\n"),
      users,
    );
    expect(rows).toEqual([
      {
        line: 2,
        name: "семенова анна",
        login: "semenova",
        password: "qwerty1",
        user_id: "u1",
        portal_name: "Семёнова Анна",
        error: null,
      },
    ]);
  });

  test("ошибки строк", () => {
    const rows = buildPasswordRows(
      [
        ["Петрова Ольга", "petrova", "secret1"],
        ["Неизвестная Вера", "vera", "secret2"],
        ["Иванова Мария", "ivanova", "secret3"],
        ["Семёнова Анна", "", "secret4"],
        ["Семёнова Анна", "se menova", "secret4"],
        ["Семёнова Анна", "semenova", "123"],
        ["Петрова Ольга", "petrova2", "secret5"],
        ["Семёнова Анна", "PETROVA", "secret6"],
        ["", "", ""],
      ],
      users,
    );
    expect(rows.map((r) => r.error)).toEqual([
      null,
      "Нет такого пользователя на портале",
      "На портале 2 человека с таким именем — задайте в карточке",
      "Нет логина",
      "В логине есть пробелы",
      "Пароль короче 4 знаков",
      "Этот человек уже в строке 1",
      "Логин уже в строке 1",
    ]);
  });
});
