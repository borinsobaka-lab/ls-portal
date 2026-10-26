import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PUSH_TRIGGERS,
  cleanParams,
  insertAt,
  templateVars,
  triggerDef,
  triggersOfFormat,
  unknownVars,
} from "./push-triggers";

const MIGRATION = readFileSync(
  new URL("../../../../db/migrations/2026-10-15_push_triggers.sql", import.meta.url),
  "utf8",
);

describe("каталог триггеров", () => {
  test("ключи уникальны и все есть в миграции (стартовые тексты и проход)", () => {
    const keys = PUSH_TRIGGERS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(MIGRATION).toContain(`('${k}', `);
      expect(MIGRATION).toMatch(new RegExp(`when [^\\n]*'${k}'`));
    }
  });

  test("стартовые тексты используют только переменные своего триггера", () => {
    // Строка сида: ('key', format, 'title', 'message', '{json}', url, '{params}').
    for (const t of PUSH_TRIGGERS) {
      const start = MIGRATION.indexOf(`('${t.key}', `);
      const next = MIGRATION.indexOf("\n    ('", start + 1);
      const last = MIGRATION.indexOf("\n  ) as t(", start);
      const chunk = MIGRATION.slice(start, next === -1 || next > last ? last : next);
      // JSON переводов и параметров — с пробелами, за переменные не считается.
      expect(chunk).toContain("{name}");
      expect(unknownVars([chunk], t.vars)).toEqual([]);
    }
  });

  test("пакетные триггеры — только у пакетного приложения", () => {
    const subscription = triggersOfFormat("subscription").map((t) => t.key);
    expect(subscription).not.toContain("visits_low");
    expect(subscription).not.toContain("rate_trainer");
    expect(triggersOfFormat("packages")).toHaveLength(PUSH_TRIGGERS.length);
  });

  test("описание учитывает параметры", () => {
    expect(triggerDef("class_reminder")!.describe({ hours: 1 })).toContain("За 1 час до начала");
    expect(triggerDef("class_reminder")!.describe({ hours: 5 })).toContain("За 5 часов");
    expect(triggerDef("installment_due")!.describe({ days: 0, send_hour: 9 })).toContain(
      "В день платежа в 09:00",
    );
    expect(triggerDef("membership_expiring")!.describe({})).toContain("За 3 дня до окончания");
  });
});

describe("переменные текста", () => {
  test("находит переменные и неизвестные", () => {
    expect(templateVars("{name}, ждём на «{class}» {when}. {name}")).toEqual([
      "name",
      "class",
      "when",
    ]);
    expect(templateVars("{ не переменная } {}")).toEqual([]);
    expect(unknownVars(["{name} {amount}", null, "{club}"], { name: "", club: "" })).toEqual([
      "amount",
    ]);
  });

  test("вставка на место курсора с пробелом", () => {
    expect(insertAt("Привет,", "{name}", null, null)).toEqual({
      text: "Привет, {name}",
      caret: 14,
    });
    expect(insertAt("ждём «»", "{class}", 6, 6)).toEqual({ text: "ждём «{class}»", caret: 13 });
    expect(insertAt("abc", "{x}", 0, 3)).toEqual({ text: "{x}", caret: 3 });
  });
});

describe("параметры", () => {
  test("только свои поля, целые, в пределах; пустое — по умолчанию", () => {
    const reminder = triggerDef("class_reminder")!;
    expect(cleanParams(reminder, { hours: 2.6, days: 4 })).toEqual({ hours: 3 });
    expect(cleanParams(reminder, { hours: 500 })).toEqual({ hours: 48 });
    expect(cleanParams(reminder, {})).toEqual({ hours: 3 });
    expect(cleanParams(triggerDef("birthday")!, { send_hour: 3 })).toEqual({ send_hour: 8 });
  });
});
