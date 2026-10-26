import { describe, expect, test } from "bun:test";

import { diagnosticsBalance } from "./balance";
import { staffHasRating, staffOrder, staffRole, staffRoleLabel } from "./staff-roles";
import { chunks, groupSubstitutions, replacedOf } from "./substitutions";
import { isOverdue, paymentsBySale, tbilisiToday } from "./upcoming-payments";
import { startsIn, startsInParts } from "./starts-in";

describe("вкладки «Студии»: роли сотрудников", () => {
  test("руководитель студии — во вкладке «Админы», первым, с подписью «Руководитель студии»", () => {
    expect(staffRole({ role: "senior_admin" })).toBe("admin");
    expect(staffRoleLabel({ role: "senior_admin" })).toBe("Руководитель студии");
    expect(staffOrder({ role: "senior_admin" })).toBeLessThan(staffOrder({ role: "admin" }));
    expect(staffRoleLabel({ role: "admin" })).toBe("Администратор");
    expect(staffHasRating(staffRole({ role: "senior_admin" }))).toBe(false);
  });

  test("тренеры и массажисты — со своими вкладками и рейтингом; неизвестная роль — тренер", () => {
    expect(staffRole({ role: "masseur" })).toBe("masseur");
    expect(staffRole({ role: null })).toBe("trainer");
    expect(staffRole({ role: "boss" })).toBe("trainer");
    expect(staffHasRating("trainer")).toBe(true);
    expect(staffHasRating("masseur")).toBe(true);
  });
});

describe("замена тренера", () => {
  const anna = { id: "anna", full_name: "Анна" };

  test("замены собираются по занятиям; прежний тренер — объектом или массивом", () => {
    const byEntry = groupSubstitutions([
      { entry_id: "e1", trainer_id: "olga", replaced: anna },
      { entry_id: "e1", trainer_id: "ira", replaced: [anna] },
      { entry_id: "e2", trainer_id: "vera", replaced: null },
    ]);
    expect(byEntry.get("e1")).toEqual([
      { trainer_id: "olga", replaced: anna },
      { trainer_id: "ira", replaced: anna },
    ]);
    // Прежнего тренера клиенту не видно (снят со студии) — пометки нет.
    expect(replacedOf(byEntry.get("e2"), "vera")).toBeNull();
    expect(replacedOf(byEntry.get("e1"), "olga")).toEqual(anna);
    expect(replacedOf(byEntry.get("e1"), "anna")).toBeNull();
    expect(replacedOf(undefined, "olga")).toBeNull();
  });

  test("id занятий уходят в запрос порциями по 100", () => {
    const ids = Array.from({ length: 230 }, (_, i) => `e${i}`);
    expect(chunks(ids, 100).map((c) => c.length)).toEqual([100, 100, 30]);
    expect(chunks([], 100)).toEqual([]);
  });
});

describe("следующие платежи у абонемента", () => {
  test("по продажам и по дате; сумма — числом", () => {
    const bySale = paymentsBySale([
      { sale_id: "s1", amount: "50.00", due_date: "2026-12-12" },
      { sale_id: "s1", amount: 50, due_date: "2026-11-12" },
      { sale_id: "s2", amount: "80", due_date: "2026-11-01" },
    ]);
    expect(bySale.get("s1")).toEqual([
      { amount: 50, due_date: "2026-11-12" },
      { amount: 50, due_date: "2026-12-12" },
    ]);
    expect(bySale.get("s2")).toEqual([{ amount: 80, due_date: "2026-11-01" }]);
  });

  test("просрочен — только когда дата прошла; «сегодня» — по Тбилиси", () => {
    expect(isOverdue({ amount: 1, due_date: "2026-10-12" }, "2026-10-13")).toBe(true);
    expect(isOverdue({ amount: 1, due_date: "2026-10-13" }, "2026-10-13")).toBe(false);
    // 21:00 UTC — в Тбилиси (UTC+4) уже следующий день.
    expect(tbilisiToday(new Date("2026-10-13T21:00:00Z"))).toBe("2026-10-14");
  });
});

describe("«начинается через» на своей записи", () => {
  const at = Date.parse("2026-10-18T10:00:00Z");
  const parts = (ms: number) => {
    const s = startsIn("2026-10-18T10:00:00Z", at - ms);
    return (
      s &&
      startsInParts(s)
        .map((p) => `${p.n} ${p.unit}`)
        .join(" ")
    );
  };

  test("часы и минуты; минуты округляются вверх", () => {
    expect(parts((2 * 60 + 15) * 60_000)).toBe("2 h 15 min");
    expect(parts(3 * 60 * 60_000)).toBe("3 h");
    expect(parts(40 * 60_000)).toBe("40 min");
    expect(parts(30_000)).toBe("1 min");
  });

  test("больше суток — дни и часы", () => {
    expect(parts((26 * 60 + 30) * 60_000)).toBe("1 d 2 h");
    expect(parts(48 * 60 * 60_000)).toBe("2 d");
  });

  test("началось — ничего", () => {
    expect(parts(0)).toBeNull();
    expect(parts(-60_000)).toBeNull();
  });
});

describe("диагностики тела: остаток как у списания в базе", () => {
  const row = (r: Partial<Parameters<typeof diagnosticsBalance>[0][number]>) => ({
    status: "active",
    diagnostics_left: 0,
    balance_kind: "group" as const,
    ...r,
  });

  test("ждущее продление не в счёт, пока жив текущий того же вида", () => {
    expect(diagnosticsBalance([row({}), row({ status: "pending", diagnostics_left: 2 })])).toBe(0);
    expect(
      diagnosticsBalance([
        row({ status: "frozen" }),
        row({ status: "pending", diagnostics_left: 2 }),
      ]),
    ).toBe(0);
    expect(diagnosticsBalance([row({ status: "pending", diagnostics_left: 2 })])).toBe(2);
  });

  test("текущий и пакет персональных — оба в остатке", () => {
    expect(
      diagnosticsBalance([
        row({ diagnostics_left: 1 }),
        row({ balance_kind: "personal", diagnostics_left: 2 }),
        row({ status: "pending", balance_kind: "personal", diagnostics_left: 5 }),
        row({ status: "frozen", diagnostics_left: 3 }),
      ]),
    ).toBe(3);
  });
});
