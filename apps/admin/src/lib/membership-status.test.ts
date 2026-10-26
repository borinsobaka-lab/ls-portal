import { describe, expect, test } from "bun:test";

import {
  effectiveStatus,
  endsSoon,
  fewVisitsLeft,
  isLiveStatus,
  paymentInfo,
} from "./membership-status";
import { TRAINER_ROLES, hasRating, isAdminRole, roleGroup } from "./staff-roles";

describe("статус абонемента клиента", () => {
  const today = "2026-10-13";

  test("новая продажа пакетного клуба без посещений — «Ожидает посещения»", () => {
    const m = { status: "active", starts_on_first_visit: true, started_at: null, ends_at: null };
    expect(effectiveStatus(m, today)).toBe("awaiting");
    expect(isLiveStatus(effectiveStatus(m, today))).toBe(true);
  });

  test("после первого посещения — обычный действующий, кончился срок — истёк", () => {
    const base = { status: "active", starts_on_first_visit: true, started_at: "2026-10-01" };
    expect(effectiveStatus({ ...base, ends_at: "2026-10-31" }, today)).toBe("active");
    expect(effectiveStatus({ ...base, ends_at: "2026-10-12" }, today)).toBe("expired");
  });

  test("ждущее продление, возврат и абонемент подписочного клуба", () => {
    expect(
      effectiveStatus({ status: "pending", starts_on_first_visit: true, started_at: null }, today),
    ).toBe("pending");
    expect(effectiveStatus({ status: "refunded" }, today)).toBe("refunded");
    expect(isLiveStatus("refunded")).toBe(false);
    // Без полей пакетного формата (подписочные продажи) — как раньше.
    expect(effectiveStatus({ status: "active", ends_at: null }, today)).toBe("active");
    expect(effectiveStatus({ status: null }, today)).toBe("expired");
  });
});

describe("роли сотрудников", () => {
  test("руководитель студии — администратор со своей подписью и без рейтинга", () => {
    expect(isAdminRole("senior_admin")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("trainer")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(TRAINER_ROLES.senior_admin.label).toBe("Руководитель студии");
    expect(hasRating("senior_admin")).toBe(false);
  });

  test("группы в списках: руководитель студии — с администраторами, неизвестная — тренер", () => {
    expect(roleGroup("senior_admin")).toBe("admin");
    expect(roleGroup("masseur")).toBe("masseur");
    expect(roleGroup("trainer")).toBe("trainer");
    expect(roleGroup("boss")).toBe("trainer");
    expect(roleGroup(undefined)).toBe("trainer");
  });
});

describe("подсказка о продлении в окне занятия", () => {
  test("меньше 5 посещений — красным, безлимит — нет", () => {
    expect(fewVisitsLeft(4)).toBe(true);
    expect(fewVisitsLeft(0)).toBe(true);
    expect(fewVisitsLeft(5)).toBe(false);
    expect(fewVisitsLeft(null)).toBe(false);
  });

  test("до окончания меньше 14 дней — красным, без даты — нет", () => {
    const today = "2026-10-13";
    expect(endsSoon("2026-10-26", today)).toBe(true);
    expect(endsSoon("2026-10-27", today)).toBe(false);
    expect(endsSoon("2026-10-10", today)).toBe(true);
    expect(endsSoon("2026-10-26T00:00:00+00:00", today)).toBe(true);
    expect(endsSoon(null, today)).toBe(false);
  });
});

describe("оплата абонемента в окне занятия", () => {
  const today = "2026-10-26";
  const i = (due_date: string, paid = false, paid_at: string | null = null, refunded = false) => ({
    due_date,
    paid,
    paid_at,
    refunded,
  });

  test("без графика — оплачен днём продажи", () => {
    expect(paymentInfo([], "2026-10-01T10:00:00Z", today)).toEqual({
      state: "paid",
      date: "2026-10-01",
    });
  });

  test("всё внесено — дата последнего платежа", () => {
    const list = [i("2026-09-01", true, "2026-09-02"), i("2026-10-01", true, "2026-10-03")];
    expect(paymentInfo(list, null, today)).toEqual({ state: "paid", date: "2026-10-03" });
  });

  test("следующий платёж: не скоро, в ближайшие 5 дней, просрочен", () => {
    const paid = i("2026-09-01", true, "2026-09-01");
    expect(paymentInfo([paid, i("2026-11-20")], null, today).state).toBe("due");
    expect(paymentInfo([paid, i("2026-10-31")], null, today)).toEqual({
      state: "soon",
      date: "2026-10-31",
    });
    expect(paymentInfo([paid, i("2026-10-26")], null, today).state).toBe("soon");
    expect(paymentInfo([paid, i("2026-11-01")], null, today).state).toBe("due");
    expect(paymentInfo([paid, i("2026-10-25"), i("2026-11-25")], null, today)).toEqual({
      state: "overdue",
      date: "2026-10-25",
    });
  });

  test("снятые возвратом платежи не в счёт", () => {
    const list = [i("2026-09-01", true, "2026-09-01"), i("2026-10-01", false, null, true)];
    expect(paymentInfo(list, null, today)).toEqual({ state: "paid", date: "2026-09-01" });
  });
});
