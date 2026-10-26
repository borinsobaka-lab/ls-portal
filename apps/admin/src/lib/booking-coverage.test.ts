import { describe, expect, test } from "bun:test";

import {
  attendanceBlock,
  balanceFor,
  entryBalance,
  isCharged,
  tbilisiDate,
  type BalanceRow,
} from "./booking-coverage";

const row = (r: Partial<BalanceRow>): BalanceRow => ({
  status: "active",
  ends_at: null,
  visits_left: 2,
  personal_left: 0,
  balance_kind: "group",
  ...r,
});

describe("остаток на дату занятия", () => {
  test("групповые — с пакета тренировок, вместе со ждущим продлением", () => {
    expect(
      balanceFor([row({}), row({ status: "pending", visits_left: 8 })], "visits", "2026-10-20"),
    ).toBe(10);
  });

  test("пакет персональных не даёт групповых, но даёт персональные; подарочные — тоже", () => {
    const rows = [
      row({ visits_left: 3, personal_left: 1 }),
      row({ balance_kind: "personal", visits_left: 0, personal_left: 5 }),
    ];
    expect(balanceFor(rows, "visits", "2026-10-20")).toBe(3);
    expect(balanceFor(rows, "personal", "2026-10-20")).toBe(6);
  });

  test("диагностики — с любого абонемента, где они есть", () => {
    const rows = [
      row({ visits_left: 3, diagnostics_left: 1 }),
      row({ balance_kind: "personal", visits_left: 0, personal_left: 5, diagnostics_left: 2 }),
      row({ status: "pending", diagnostics_left: 3 }),
    ];
    // Диагностики ждущего продления база не спишет, пока жив текущий того же
    // вида (его кончают тренировки): 1 + 2, без 3 у продления.
    expect(balanceFor(rows, "diagnostic", "2026-10-20")).toBe(3);
    // Текущего группового нет — продление спишется.
    expect(balanceFor(rows.slice(1), "diagnostic", "2026-10-20")).toBe(5);
    // Замороженный текущий тоже держит продление, сам в остаток не идёт.
    expect(
      balanceFor(
        [
          row({ status: "frozen", diagnostics_left: 4 }),
          row({ status: "pending", diagnostics_left: 3 }),
        ],
        "diagnostic",
        "2026-10-20",
      ),
    ).toBe(0);
    expect(balanceFor([row({})], "diagnostic", "2026-10-20")).toBe(0);
    expect(entryBalance("diagnostic")).toBe("diagnostic");
    expect(entryBalance("personal")).toBe("personal");
    expect(entryBalance("group")).toBe("visits");
  });

  test("истёкший к дате занятия, заменённый и с возвратом не считаются", () => {
    const rows = [
      row({ ends_at: "2026-10-19" }),
      row({ status: "replaced" }),
      row({ status: "refunded" }),
    ];
    expect(balanceFor(rows, "visits", "2026-10-20")).toBe(0);
    // Последний день срока — ещё действует.
    expect(balanceFor([row({ ends_at: "2026-10-20" })], "visits", "2026-10-20")).toBe(2);
  });

  test("без счётчика — безлимит; отрицательный остаток — ноль", () => {
    expect(balanceFor([row({ visits_left: null })], "visits", "2026-10-20")).toBe(Infinity);
    expect(balanceFor([row({ visits_left: -1 })], "visits", "2026-10-20")).toBe(0);
  });

  test("дата занятия — по Тбилиси (UTC+4): 21:30 UTC — уже следующий день", () => {
    expect(tbilisiDate("2026-10-20T21:30:00Z")).toBe("2026-10-21");
    expect(tbilisiDate("2026-10-20T19:59:00Z")).toBe("2026-10-20");
  });
});

describe("отметка посещения", () => {
  const booked = { status: "booked", no_show_excused: null };

  test("2 на балансе, записан на 4: первые две — без предупреждений, дальше — «не хватит»", () => {
    expect(attendanceBlock(booked, { balance: 2, ahead: 0 })).toEqual({
      noBalance: false,
      uncovered: false,
    });
    expect(attendanceBlock(booked, { balance: 2, ahead: 1 }).uncovered).toBe(false);
    expect(attendanceBlock(booked, { balance: 2, ahead: 2 })).toEqual({
      noBalance: false,
      uncovered: true,
    });
  });

  test("остатка нет — «Посетил» не отметить", () => {
    expect(attendanceBlock(booked, { balance: 0, ahead: 0 })).toEqual({
      noBalance: true,
      uncovered: true,
    });
    // «Не посетил» с уважительной причиной не списан — тоже нужен абонемент.
    expect(
      attendanceBlock({ status: "no_show", no_show_excused: true }, { balance: 0, ahead: 0 })
        .noBalance,
    ).toBe(true);
  });

  test("уже списанная запись — без предупреждений: её можно перевести в «Посетил»", () => {
    const unexcused = { status: "no_show", no_show_excused: false };
    expect(isCharged(unexcused)).toBe(true);
    expect(isCharged({ status: "attended", no_show_excused: null })).toBe(true);
    expect(attendanceBlock(unexcused, { balance: 0, ahead: 0 })).toEqual({
      noBalance: false,
      uncovered: false,
    });
  });

  test("подписочный клуб (нет расчёта) — без предупреждений", () => {
    expect(attendanceBlock(booked, undefined)).toEqual({ noBalance: false, uncovered: false });
  });
});
