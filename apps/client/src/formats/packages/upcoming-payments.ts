/**
 * «Следующие платежи» у своего абонемента («Абонементы» пакетного
 * приложения, 2026-10-13): невнесённые платежи рассрочки по продаже — дата и
 * сумма по порядку, просроченный — красным. Платёж, снятый возвратом, сюда
 * не попадает: абонемент с возвратом в списке своих не показывается.
 */

export type UpcomingPayment = { amount: number; due_date: string };

/** Строка sale_installments (numeric приходит строкой). */
export type InstallmentRow = { sale_id: string; amount: number | string; due_date: string };

/** Платежи по продажам; внутри продажи — по дате (как бы ни пришли из базы). */
export function paymentsBySale(rows: InstallmentRow[]): Map<string, UpcomingPayment[]> {
  const bySale = new Map<string, UpcomingPayment[]>();
  for (const r of rows)
    bySale.set(r.sale_id, [
      ...(bySale.get(r.sale_id) ?? []),
      { amount: Number(r.amount), due_date: r.due_date },
    ]);
  for (const list of bySale.values()) list.sort((a, b) => a.due_date.localeCompare(b.due_date));
  return bySale;
}

/** Сегодня по Тбилиси (YYYY-MM-DD) — как база считает даты платежей. */
export function tbilisiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tbilisi" }).format(now);
}

/** Платёж просрочен: дата прошла (в сам день — ещё нет). */
export function isOverdue(p: UpcomingPayment, today: string) {
  return p.due_date < today;
}
