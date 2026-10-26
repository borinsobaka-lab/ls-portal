import { describe, expect, test } from "bun:test";

import {
  ageGroups,
  ageOn,
  classifySales,
  clientLtv,
  dailySeries,
  foldSlices,
  membershipPayments,
  notRenewedBeforeEnd,
  renewalRates,
  salesMetrics,
  type SaleRecord,
} from "./dashboard-analytics";

let seq = 0;
function sale(p: Partial<SaleRecord> & { clientId: string; soldAt: string }): SaleRecord {
  seq++;
  return {
    id: p.id ?? `s${seq}`,
    createdAt: `${p.soldAt}T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    totalAmount: 100,
    membershipName: "Безлимит",
    trial: false,
    single: false,
    personal: false,
    method: "cash",
    source: "admin",
    promoCode: null,
    discount: 0,
    sellerKey: null,
    sellerName: null,
    endsAt: null,
    cancelled: false,
    noMembership: false,
    installments: [],
    ...p,
  };
}

describe("membershipPayments", () => {
  test("без графика — вся сумма в день продажи", () => {
    const p = membershipPayments([sale({ clientId: "a", soldAt: "2026-10-01", totalAmount: 300 })]);
    expect(p).toEqual([
      expect.objectContaining({ date: "2026-10-01", amount: 300, method: "cash" }),
    ]);
  });

  test("с графиком — только внесённые платежи, в день внесения", () => {
    const p = membershipPayments([
      sale({
        clientId: "a",
        soldAt: "2026-09-01",
        totalAmount: 300,
        method: "card",
        installments: [
          { amount: 100, paid: true, date: "2026-09-01", method: null },
          { amount: 100, paid: true, date: "2026-10-03", method: "transfer" },
          { amount: 100, paid: false, date: "2026-11-01", method: null },
        ],
      }),
    ]);
    expect(p.map((x) => [x.date, x.amount, x.method])).toEqual([
      ["2026-09-01", 100, "card"],
      ["2026-10-03", 100, "transfer"],
    ]);
  });
});

describe("classifySales", () => {
  test("первая покупка — новый, без перерыва — продление, после перерыва — возврат", () => {
    const first = sale({ clientId: "a", soldAt: "2026-01-01", endsAt: "2026-01-31" });
    // через 14 дней после окончания — ещё продление
    const renewal = sale({ clientId: "a", soldAt: "2026-02-14", endsAt: "2026-03-14" });
    // через 15 дней — уже возврат
    const back = sale({ clientId: "a", soldAt: "2026-03-29", endsAt: "2026-04-28" });
    const other = sale({ clientId: "b", soldAt: "2026-06-01" });
    const r = classifySales([back, other, renewal, first]);
    expect(r.get(first.id)).toBe("new");
    expect(r.get(renewal.id)).toBe("renewal");
    expect(r.get(back.id)).toBe("return");
    expect(r.get(other.id)).toBe("new");
  });

  test("пробное историей не считается", () => {
    const trial = sale({ clientId: "a", soldAt: "2026-01-01", endsAt: "2026-01-01", trial: true });
    const pack = sale({ clientId: "a", soldAt: "2026-01-02", endsAt: "2026-02-01" });
    const r = classifySales([trial, pack]);
    expect(r.get(trial.id)).toBe("new");
    expect(r.get(pack.id)).toBe("new");
  });

  test("разовое посещение — своя категория, историей не считается", () => {
    const single = sale({
      clientId: "a",
      soldAt: "2026-01-01",
      endsAt: "2026-01-31",
      single: true,
    });
    const pack = sale({ clientId: "a", soldAt: "2026-01-10", endsAt: "2026-02-10" });
    const again = sale({ clientId: "a", soldAt: "2026-02-05", single: true });
    const r = classifySales([single, pack, again]);
    expect(r.get(single.id)).toBe("single");
    expect(r.get(pack.id)).toBe("new");
    expect(r.get(again.id)).toBe("single");
  });

  test("прежний абонемент без срока — продление", () => {
    const open = sale({ clientId: "a", soldAt: "2025-01-01", endsAt: null });
    const next = sale({ clientId: "a", soldAt: "2026-05-01", endsAt: "2026-06-01" });
    expect(classifySales([open, next]).get(next.id)).toBe("renewal");
  });

  test("пакет персональных — своя история, групповой не продлевает", () => {
    const group = sale({ clientId: "a", soldAt: "2026-01-01", endsAt: "2026-01-31" });
    const personal = sale({
      clientId: "a",
      soldAt: "2026-01-10",
      endsAt: "2026-03-10",
      personal: true,
    });
    // группового нет с 31 января, а персональный действует — это возврат в группу
    const back = sale({ clientId: "a", soldAt: "2026-03-01", endsAt: "2026-03-31" });
    const r = classifySales([group, personal, back]);
    expect(r.get(personal.id)).toBe("new");
    expect(r.get(back.id)).toBe("return");
  });

  test("возврат до первого посещения (срок не начался) не продлевает", () => {
    const refunded = sale({ clientId: "a", soldAt: "2026-01-01", endsAt: null, cancelled: true });
    const next = sale({ clientId: "a", soldAt: "2026-05-01", endsAt: "2026-06-01" });
    expect(classifySales([refunded, next]).get(next.id)).toBe("return");
  });
});

describe("renewalRates", () => {
  test("продления и возвращения по месяцам", () => {
    const sales = [
      // a: закончился в марте, продлил через 10 дней
      sale({ clientId: "a", soldAt: "2026-02-10", endsAt: "2026-03-10" }),
      sale({ clientId: "a", soldAt: "2026-03-20", endsAt: "2026-04-20" }),
      // b: закончился в марте, не продлил; вернулся в июне
      sale({ clientId: "b", soldAt: "2026-02-01", endsAt: "2026-03-01" }),
      sale({ clientId: "b", soldAt: "2026-06-05", endsAt: "2026-07-05" }),
      // c: отменённый — не в базе продлений
      sale({ clientId: "c", soldAt: "2026-02-01", endsAt: "2026-03-05", cancelled: true }),
    ];
    const rates = renewalRates(sales, new Date(2026, 5, 15), 4); // март–июнь
    expect(rates.map((r) => r.key)).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    const march = rates[0];
    expect([march.renewed, march.renewalBase, march.renewal]).toEqual([1, 2, 50]);
    // На начало июня больше 14 дней без абонемента все трое (a — с 20 апреля),
    // вернулся только b.
    const june = rates[3];
    expect([june.returned, june.returnBase]).toEqual([1, 3]);
    expect(june.returnRate).toBeCloseTo(33.33, 1);
    // На начало апреля больше 14 дней без абонемента b и c (с 1 и 5 марта),
    // у a абонемент действует до 20 апреля.
    expect(rates[1].returnBase).toBe(2);
  });

  test("пакет персональных не считается продлением группового", () => {
    const sales = [
      sale({ clientId: "a", soldAt: "2026-02-10", endsAt: "2026-03-10" }),
      sale({ clientId: "a", soldAt: "2026-03-12", endsAt: "2026-05-12", personal: true }),
    ];
    const [march] = renewalRates(sales, new Date(2026, 2, 31), 1);
    expect([march.renewed, march.renewalBase]).toEqual([0, 1]);
  });
});

describe("notRenewedBeforeEnd", () => {
  test("продлённые до окончания того же вида не считаются", () => {
    const t = (d: string) => Date.parse(`${d}T10:00:00Z`);
    const ending = [
      // a: продление куплено за неделю до конца — не зовём
      { key: "a:group", createdAt: t("2026-09-01"), endsAt: "2026-10-10" },
      // b: купил следующий уже после окончания — закончился
      { key: "b:group", createdAt: t("2026-09-01"), endsAt: "2026-10-10" },
      // c: купил только пакет персональных — групповой закончился
      { key: "c:group", createdAt: t("2026-09-01"), endsAt: "2026-10-10" },
    ];
    const later = [
      { key: "a:group", createdAt: t("2026-10-03"), date: "2026-10-03" },
      { key: "b:group", createdAt: t("2026-10-12"), date: "2026-10-12" },
      { key: "c:personal", createdAt: t("2026-10-03"), date: "2026-10-03" },
      // свой же абонемент (оформлен не позже) продлением не считается
      { key: "b:group", createdAt: t("2026-09-01"), date: "2026-09-01" },
    ];
    expect(notRenewedBeforeEnd(ending, later).map((m) => m.key)).toEqual(["b:group", "c:group"]);
  });
});

describe("возраст", () => {
  test("полных лет и группы", () => {
    const today = new Date(2026, 9, 11);
    expect(ageOn("2000-10-11", today)).toBe(26);
    expect(ageOn("2000-10-12", today)).toBe(25);
    expect(ageOn(null, today)).toBeNull();
    expect(ageOn("2030-01-01", today)).toBeNull();
    const g = ageGroups([15, 25, 29, 30, 65, null]);
    expect(g.map((x) => x.value)).toEqual([1, 2, 1, 0, 0, 1, 1]);
  });
});

describe("foldSlices", () => {
  test("хвост сворачивается в «Остальное»", () => {
    const s = foldSlices(
      [
        { key: "a", label: "A", value: 5 },
        { key: "b", label: "B", value: 4 },
        { key: "c", label: "C", value: 1 },
        { key: "d", label: "D", value: 2 },
        { key: "z", label: "Z", value: 0 },
      ],
      3,
    );
    expect(s.map((x) => [x.label, x.value])).toEqual([
      ["A", 5],
      ["B", 4],
      ["Остальное", 3],
    ]);
  });
});

describe("dailySeries", () => {
  test("все дни периода, пустые — нулём", () => {
    const d = dailySeries(
      [
        { date: "2026-10-02", value: 5 },
        { date: "2026-10-02", value: 1 },
        { date: "2026-11-01", value: 9 },
      ],
      "2026-10-01",
      "2026-10-03",
    );
    expect(d.map((x) => [x.date, x.value])).toEqual([
      ["2026-10-01", 0],
      ["2026-10-02", 6],
      ["2026-10-03", 0],
    ]);
  });
});

describe("salesMetrics и clientLtv", () => {
  const sales = [
    sale({
      id: "x",
      clientId: "a",
      soldAt: "2026-09-20",
      totalAmount: 300,
      installments: [
        { amount: 100, paid: true, date: "2026-09-20", method: null },
        { amount: 200, paid: true, date: "2026-10-05", method: null },
      ],
    }),
    sale({ id: "y", clientId: "b", soldAt: "2026-10-02", totalAmount: 500 }),
  ];
  const otherSales = [
    {
      id: "o1",
      clientId: "a",
      soldAt: "2026-10-03",
      totalAmount: 40,
      itemName: "Вода",
      method: "cash",
    },
  ];

  test("выручка — по дате продажи, платежи — по дате внесения", () => {
    const m = salesMetrics({ sales, otherSales }, "2026-10-01", "2026-10-31");
    expect(m.membershipRevenue).toBe(500);
    expect(m.membershipPayments).toBe(700);
    expect(m.avgMembershipPayment).toBe(350);
    expect(m.otherRevenue).toBe(40);
    expect(m.avgOtherCheck).toBe(40);
    expect(m.singleVisits).toBe(0);
  });

  test("разовые посещения: число и выручка за период, удалённые не в счёт", () => {
    const withSingles = [
      ...sales,
      sale({ clientId: "c", soldAt: "2026-10-04", totalAmount: 30, single: true }),
      sale({ clientId: "d", soldAt: "2026-10-06", totalAmount: 30, single: true }),
      sale({
        clientId: "e",
        soldAt: "2026-10-07",
        totalAmount: 30,
        single: true,
        noMembership: true,
      }),
      sale({ clientId: "f", soldAt: "2026-09-30", totalAmount: 30, single: true }),
    ];
    const m = salesMetrics({ sales: withSingles, otherSales }, "2026-10-01", "2026-10-31");
    expect(m.singleVisits).toBe(2);
    expect(m.singleRevenue).toBe(60);
  });

  test("LTV — все платежи клиента минус возвраты", () => {
    const ltv = clientLtv({
      sales,
      otherSales,
      refunds: [{ date: "2026-10-04", amount: 50, saleId: "x", otherSaleId: null }],
    });
    expect(ltv.get("a")).toBe(290);
    expect(ltv.get("b")).toBe(500);
  });
});
