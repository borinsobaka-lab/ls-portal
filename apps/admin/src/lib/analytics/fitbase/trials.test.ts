import { describe, expect, test } from "bun:test";

import {
  fbApplyBasis,
  fbBasisClassifier,
  fbCatalogRow,
  fbCollectRefs,
  fbNormLabel,
  fbReviewCsv,
  fbReviewRows,
  fbServiceOverrides,
  fbTrialAggregate,
  fbTrialCalculateConfirmed,
  fbTrialNumber,
  fbTrialOwner,
  type FbTrialConnection,
  type FbTrialRecord,
} from "./trials";

// Ожидания — ответы своей транскрипции их fitbase_trials / fitbase_trial_services /
// fitbase_trial_fast / fitbase_trial_review на тех же синтетических данных.

const MSK = (day: string, hm = "12:00") => Date.parse(`${day}T${hm}:00+03:00`) / 1000;
const conn = (patch: Partial<FbTrialConnection> = {}): FbTrialConnection => ({
  id: 1,
  name: "С1",
  city: "Самара",
  brand: "Lady Stretch",
  attendance_synced_at: 1,
  attendance_from: "2026-01-01",
  attendance_to: "2026-12-31",
  sales_payments_at: MSK("2026-10-30"),
  sales_synced_at: MSK("2026-10-30"),
  ...patch,
});
const rec = (rid: string, day: string, patch: Partial<FbTrialRecord> = {}): FbTrialRecord => ({
  connection_id: 1,
  registration_id: rid,
  client_key: "k1",
  status: "visited",
  kind: 1,
  day,
  end_at: MSK(day, "11:00"),
  ...patch,
});

describe("FitBase: воронка пробных (их calculate)", () => {
  const now = MSK("2026-10-30");
  const records = [
    rec("1", "2026-10-01"),
    rec("2", "2026-10-02", { client_key: "k2" }),
    rec("3", "2026-10-03", { client_key: "k3", status: "refused" }),
    rec("4", "2026-10-20", { client_key: "" }),
    rec("5", "2026-10-04", { kind: 0 }),
    rec("6", "2026-10-05", { kind: -1 }),
  ];
  const sales = [
    // k1 купил в день пробного; k2 — через 13 дней; договор до пробного не считается.
    {
      connection_id: 1,
      contract_id: "10",
      client_id: "k1",
      purchased_at: MSK("2026-10-01", "15:00"),
      price_cents: 500000,
      kind: 0,
    },
    {
      connection_id: 1,
      contract_id: "11",
      client_id: "k2",
      purchased_at: MSK("2026-10-15"),
      price_cents: 500000,
      kind: 0,
    },
    {
      connection_id: 1,
      contract_id: "12",
      client_id: "k3",
      purchased_at: MSK("2026-09-01"),
      price_cents: 500000,
      kind: 0,
    },
  ];
  const payments = [
    {
      connection_id: 1,
      contract_id: "10",
      operation: "purchase",
      amount_cents: 500000,
      pay_at: MSK("2026-10-01", "15:05"),
    },
    {
      connection_id: 1,
      contract_id: "11",
      operation: "purchase",
      amount_cents: 500000,
      pay_at: MSK("2026-10-15"),
    },
    {
      connection_id: 1,
      contract_id: "12",
      operation: "purchase",
      amount_cents: 500000,
      pay_at: MSK("2026-10-04"),
    },
  ];
  const stats = fbTrialCalculateConfirmed(
    [conn()],
    records,
    sales,
    payments,
    "2026-10-01",
    "2026-10-29",
    now,
  );
  const s = stats.get(1)!;
  test("записи, приходы, покупки в день и за 14 дней", () => {
    expect([s.registered, s.visited, s.day, s.within, s.missing_client, s.unknown]).toEqual([
      4, 3, 1, 2, 1, 0,
    ]);
    // 20.10 + 13 дней позже вчерашнего дня — окно не завершено.
    expect([s.day_base, s.window_base, s.immature]).toEqual([3, 2, 1]);
    expect(s.paid_complete).toBe(false);
  });
  test("их форматы: проценты, «не в день», прочерки", () => {
    const b = fbTrialAggregate([s]);
    expect(fbTrialNumber(b, "registered")).toBe("4");
    expect(fbTrialNumber(b, "attendance")).toBe("75,0%");
    // Нет ID клиента у пробного посещения — конверсии скрыты.
    expect(fbTrialNumber(b, "conversion")).toBe("—");
    expect(fbTrialNumber(b, "later")).toBe("—");
    const full = fbTrialAggregate([
      fbTrialCalculateConfirmed(
        [conn()],
        records.slice(0, 3),
        sales,
        payments,
        "2026-10-01",
        "2026-10-29",
        now,
      ).get(1)!,
    ]);
    expect(
      ["day_conversion", "conversion", "later"].map((k) => fbTrialNumber(full, k as never)),
    ).toEqual(["50,0%", "100,0%", "1"]);
  });
  test("не загружен период — плитки прочерком, «Записались» тоже", () => {
    const b = fbTrialAggregate([
      fbTrialCalculateConfirmed(
        [conn({ attendance_from: "2026-10-05" })],
        records,
        sales,
        payments,
        "2026-10-01",
        "2026-10-29",
        now,
      ).get(1)!,
    ]);
    expect([b.known, fbTrialNumber(b, "registered"), fbTrialNumber(b, "attendance")]).toEqual([
      0,
      "—",
      "—",
    ]);
  });
});

describe("FitBase: пробные услуги и основания (их services / fast)", () => {
  test("владелец и ID услуги", () => {
    expect(fbTrialOwner({ domain: "ladyjump", club_id: "1" })).toBe('["ladyjump", "1"]');
    expect(fbCatalogRow({ id: 7, name: "", clubs: [{ id: 1 }] }, "1", 0)).toEqual({
      service_id: "7",
      name: "Услуга 7",
      is_trial: 0,
      archived: 0,
    });
    expect(fbCatalogRow({ id: 7, clubs: [2] }, "1", 1)).toBeNull();
    expect(() => fbCatalogRow({ name: "x" }, "1", 0)).toThrow("FitBase вернул услугу без ID");
  });
  test("связи: запись и активации того же клиента и клуба", () => {
    const refs = fbCollectRefs(
      [
        { id: 1, client_id: 10, client_service: { service: { available_service: { id: 5 } } } },
        { id: 2, client_id: 99, service: { service: { available_service: { id: 6 } } } },
      ],
      [
        {
          registration_id: 1,
          client_id: 10,
          club: { id: 1 },
          client_service: { service: { available_service: { id: 7 } } },
        },
        {
          registration_id: 2,
          client_id: 10,
          club: { id: 2 },
          client_service: { service: { available_service: { id: 8 } } },
        },
      ],
      new Map([
        ["1", "10"],
        ["2", "10"],
      ]),
      "1",
    );
    expect([...refs].map(([k, v]) => [k, [...v]])).toEqual([["1", ["5", "7"]]]);
  });
  test("выбранные услуги, основание поверх связи, противоречие — неопределённая", () => {
    const rule = { mode: "selected" as const, selected: ["5"], revision: 1 };
    const values = fbServiceOverrides(rule, [
      ["1", ["5"]],
      ["2", ["5", "6"]],
      ["3", ["6"]],
    ]);
    expect([...values]).toEqual([
      ["1", 1],
      ["2", -1],
      ["3", 0],
    ]);
    const resolve = fbBasisClassifier(
      rule,
      [
        { service_id: "5", name: "Пробное  занятие" },
        { service_id: "6", name: "Разовое" },
      ],
      [{ label: "Абонемент 8", is_trial: 0 }],
    );
    const out = fbApplyBasis(
      values,
      [
        { registration_id: "3", label: "ПРОБНОЕ занятие" },
        { registration_id: "4", label: "абонемент 8" },
        { registration_id: "5", label: "Неизвестное" },
      ],
      resolve,
    );
    expect([...out]).toEqual([
      ["1", 1],
      ["2", -1],
      ["3", -1],
      ["4", 0],
    ]);
    expect(fbServiceOverrides({ ...rule, mode: "auto" }, [["1", ["5"]]]).size).toBe(0);
  });
  test("их normalized: пробелы Python, регистр, ё", () => {
    expect(fbNormLabel(" Ёлочка  \tПробная ")).toBe("елочка пробная");
    expect(fbNormLabel("Straße")).toBe("strasse");
    // U+FEFF у них не пробел.
    expect(fbNormLabel("﻿А")).toBe("﻿а");
  });
});

describe("FitBase: «Записи без услуги» (их fitbase_trial_review)", () => {
  test("порядок, время окончания по Москве, CSV с защитой от формул", () => {
    const rows = fbReviewRows({
      from: "",
      to: "",
      connections: [],
      rows: [
        [
          "Б",
          "Самара",
          "Lady Stretch",
          "2026-10-02",
          MSK("2026-10-02", "09:30"),
          "=1+1",
          "refused",
          "e1",
          "r2",
        ],
        [
          "А",
          "Самара",
          "Lady Stretch",
          "2026-10-02",
          MSK("2026-10-02", "09:30"),
          "Стретчинг",
          "odd",
          "e2",
          "r1",
        ],
      ],
    });
    expect(rows.map((r) => [r.branch, r.end_time, r.status])).toEqual([
      ["А", "09:30", "Статус не сопоставлен"],
      ["Б", "09:30", "Отказался"],
    ]);
    const csv = fbReviewCsv(rows);
    expect(csv.startsWith("﻿Филиал;Город;")).toBe(true);
    expect(csv).toContain(";'=1+1;Отказался;");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
