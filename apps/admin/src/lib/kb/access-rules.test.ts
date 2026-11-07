import { describe, expect, test } from "bun:test";

import {
  addRule,
  inheritedText,
  peopleCount,
  removeRule,
  ruleHint,
  ruleKey,
  rulesEqual,
  type KbAccessRule,
} from "./access-rules";

const rule = (
  subject_type: KbAccessRule["subject_type"],
  subject_id: string,
  extra: Partial<KbAccessRule> = {},
): KbAccessRule => ({
  subject_type,
  subject_id,
  unit_members: "all",
  with_subunits: true,
  ...extra,
});

describe("доступ к разделу базы знаний", () => {
  test("добавить: без повторов, подразделение заменяет настройки", () => {
    let list = addRule([], rule("position", "p1"));
    list = addRule(list, rule("position", "p1"));
    expect(list).toHaveLength(1);
    list = addRule(list, rule("unit", "u1"));
    list = addRule(list, rule("unit", "u1", { unit_members: "heads", with_subunits: false }));
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual(rule("unit", "u1", { unit_members: "heads", with_subunits: false }));
    // У не подразделения настройки подразделения не сохраняются.
    expect(
      addRule([], rule("role", "r1", { unit_members: "heads", with_subunits: false }))[0],
    ).toEqual(rule("role", "r1"));
    expect(removeRule(list, ruleKey(rule("position", "p1")))).toEqual([list[1]]);
  });

  test("сравнение списков — без порядка, с настройками подразделения", () => {
    const a = [rule("user", "x"), rule("unit", "u")];
    expect(rulesEqual(a, [rule("unit", "u"), rule("user", "x")])).toBe(true);
    expect(rulesEqual(a, [rule("unit", "u", { unit_members: "heads" }), rule("user", "x")])).toBe(
      false,
    );
    expect(rulesEqual(a, [rule("user", "x")])).toBe(false);
  });

  test("подписи", () => {
    expect(ruleHint(rule("unit", "u", { unit_members: "heads", with_subunits: false }))).toBe(
      "руководители и заместители",
    );
    expect(ruleHint(rule("unit", "u"))).toBe("все сотрудники, и подразделения ниже");
    expect(ruleHint(rule("position", "p"))).toBeNull();
    expect(inheritedText({ source_id: null, source_title: null })).toBe(
      "Как в базе — видят все, кому открыта база.",
    );
    expect(inheritedText({ source_id: "s", source_title: "Офис УК" })).toBe(
      "Как у «Офис УК» — действует его список.",
    );
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(peopleCount)).toEqual([
      "1 человек",
      "2 человека",
      "5 человек",
      "11 человек",
      "12 человек",
      "21 человек",
      "22 человека",
      "25 человек",
    ]);
  });
});
