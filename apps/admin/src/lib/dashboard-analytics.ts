import {
  addDays,
  addMonths,
  differenceInYears,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
} from "date-fns";
import { ru } from "date-fns/locale";

/**
 * Расчёты разделов дашборда («Общие показатели», «Продажи», «Клиенты») без
 * React и Supabase: строки из базы приходят уже разобранными, здесь — только
 * арифметика (тест — dashboard-analytics.test.ts). Даты — локальные
 * yyyy-MM-dd, сравниваются строками.
 */

/**
 * Перерыв, после которого покупка — уже не продление, а возвращение: новый
 * абонемент куплен позже чем через столько дней после окончания прежнего.
 */
export const RENEWAL_GRACE_DAYS = 14;

/** Продажа абонемента со всем, что нужно аналитике (sales + связанные строки). */
export type SaleRecord = {
  id: string;
  clientId: string;
  soldAt: string;
  /** Момент внесения — порядок продаж одного дня. */
  createdAt: string;
  totalAmount: number;
  membershipName: string;
  /** memberships.kind: пробное не делает следующую покупку продлением. */
  trial: boolean;
  /**
   * Разовое посещение (memberships.kind = single, пакетные клубы): своя доля
   * выручки, историей абонементов не считается — как пробное.
   */
  single: boolean;
  /**
   * Пакет персональных тренировок (memberships.kind = personal, пакетные
   * клубы) — свой вид баланса: продлевается и считается отдельно от
   * групповых абонементов, как в базе (client_memberships.balance_kind).
   */
  personal: boolean;
  method: string | null;
  /** Где оформлена: admin — в админке, mobile — клиентом в приложении. */
  source: string;
  /** Промокод — свободный текст из формы продажи (null — без промокода). */
  promoCode: string | null;
  /** Скидка от цены номенклатуры (sales.discount_amount). */
  discount: number;
  /** Ответственный (администратор-продавец): id справочника или снимок имени. */
  sellerKey: string | null;
  sellerName: string | null;
  /** Окончание выданного по продаже абонемента: null — бессрочный или срок ещё не начался. */
  endsAt: string | null;
  /**
   * Абонемент по продаже отменён или по нему оформлен возврат (пакетные
   * клубы, статус refunded) — продлевать было нечего.
   */
  cancelled: boolean;
  /** Нет выданного абонемента (удалён) — в истории клиента продажи нет. */
  noMembership: boolean;
  installments: { amount: number; paid: boolean; date: string; method: string | null }[];
};

export type OtherSaleRecord = {
  id: string;
  clientId: string | null;
  soldAt: string;
  totalAmount: number;
  itemName: string;
  method: string | null;
};

export type RefundRecord = {
  date: string;
  amount: number;
  saleId: string | null;
  otherSaleId: string | null;
};

/** Поступивший платёж: по абонементу или по прочей продаже. */
export type Payment = {
  date: string;
  amount: number;
  method: string | null;
  clientId: string | null;
  source: "membership" | "other";
  saleId: string;
};

/**
 * Поступившие деньги — как в зарплатах (payroll_lines): продажа без графика —
 * вся сумма в день продажи; с графиком (рассрочка) — каждый внесённый платёж
 * в день внесения. Способ оплаты — у платежа, без него — у продажи.
 */
export function membershipPayments(sales: SaleRecord[]): Payment[] {
  const out: Payment[] = [];
  for (const s of sales) {
    if (s.installments.length === 0) {
      out.push({
        date: s.soldAt,
        amount: s.totalAmount,
        method: s.method,
        clientId: s.clientId,
        source: "membership",
        saleId: s.id,
      });
      continue;
    }
    for (const i of s.installments) {
      if (!i.paid) continue;
      out.push({
        date: i.date,
        amount: i.amount,
        method: i.method ?? s.method,
        clientId: s.clientId,
        source: "membership",
        saleId: s.id,
      });
    }
  }
  return out;
}

export function otherPayments(sales: OtherSaleRecord[]): Payment[] {
  return sales.map((s) => ({
    date: s.soldAt,
    amount: s.totalAmount,
    method: s.method,
    clientId: s.clientId,
    source: "other",
    saleId: s.id,
  }));
}

export const inPeriod = (date: string, from: string, to: string) => date >= from && date <= to;

export function sumBy<T>(rows: T[], value: (row: T) => number) {
  return rows.reduce((s, r) => s + value(r), 0);
}

/** Тип продажи абонемента по истории клиента; разовое посещение — отдельно. */
export type SaleOrigin = "new" | "renewal" | "return" | "single";

export const SALE_ORIGIN_LABEL: Record<SaleOrigin, string> = {
  new: "Новые абонементы",
  renewal: "Продления",
  return: "Возвраты",
  single: "Разовые посещения",
};

/**
 * Продажи клиента по порядку внесения — отдельно по виду баланса: пакет
 * персональных не продлевает групповой абонемент и наоборот.
 */
function byClient(sales: SaleRecord[]) {
  const map = new Map<string, SaleRecord[]>();
  for (const s of sales) {
    const key = `${s.clientId}:${s.personal ? "personal" : "group"}`;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort(compareSales);
  return map;
}

function compareSales(a: SaleRecord, b: SaleRecord) {
  return a.soldAt === b.soldAt
    ? a.createdAt.localeCompare(b.createdAt)
    : a.soldAt.localeCompare(b.soldAt);
}

/** Продажа считается в истории клиента: не пробное, не разовое и абонемент по ней был. */
const counts = (s: SaleRecord) => !s.trial && !s.single && !s.noMembership;

/**
 * Самое позднее окончание абонементов из списка (null — какой-то из них без
 * срока или срок ещё не начался). Отменённый или возвращённый без срока
 * (возврат до первого посещения) уже не начнётся — не продлевает ничего.
 */
function latestEnd(list: SaleRecord[]): string | null {
  let latest = "";
  for (const s of list) {
    if (s.endsAt === null && s.cancelled) continue;
    if (s.endsAt === null) return null;
    if (s.endsAt > latest) latest = s.endsAt;
  }
  return latest;
}

/**
 * Новый абонемент, продление или возврат: до этой продажи абонементов у
 * клиента не было — новый; прежний ещё действовал или закончился не раньше
 * чем за RENEWAL_GRACE_DAYS дней — продление; перерыв дольше — возврат.
 * Пробные и разовые посещения историей не считаются (разовое — своя
 * категория «single»); групповые абонементы и пакеты персональных — две
 * отдельные истории.
 */
export function classifySales(all: SaleRecord[]): Map<string, SaleOrigin> {
  const result = new Map<string, SaleOrigin>();
  for (const list of byClient(all).values()) {
    const prior: SaleRecord[] = [];
    for (const s of list) {
      if (s.single) {
        result.set(s.id, "single");
      } else if (prior.length === 0) {
        result.set(s.id, "new");
      } else {
        const end = latestEnd(prior);
        const graceFrom = format(addDays(parseISO(s.soldAt), -RENEWAL_GRACE_DAYS), "yyyy-MM-dd");
        result.set(s.id, end === null || end >= graceFrom ? "renewal" : "return");
      }
      if (counts(s)) prior.push(s);
    }
  }
  return result;
}

/**
 * Абонементы из `ending`, которые клиент не продлил до окончания: среди
 * `later` нет абонемента того же клиента и вида (`key`), оформленного после
 * этого и не позже дня окончания. createdAt — момент оформления (мс), date —
 * его локальная дата.
 */
export function notRenewedBeforeEnd<T extends { key: string; createdAt: number; endsAt: string }>(
  ending: T[],
  later: { key: string; createdAt: number; date: string }[],
): T[] {
  const byKey = new Map<string, { createdAt: number; date: string }[]>();
  for (const m of later) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);
  return ending.filter(
    (m) => !(byKey.get(m.key) ?? []).some((n) => n.createdAt > m.createdAt && n.date <= m.endsAt),
  );
}

export type MonthRate = {
  key: string;
  tick: string;
  label: string;
  /** Доля в процентах; null — в месяце некого было считать. */
  renewal: number | null;
  renewalBase: number;
  renewed: number;
  returnRate: number | null;
  returnBase: number;
  returned: number;
};

/**
 * Процент продлений и возвращений за `months` месяцев до `anchor` включительно.
 *
 * Продления: абонементы, закончившиеся в месяце (кроме отменённых и
 * возвращённых), — какая доля клиентов купила следующий того же вида не позже
 * RENEWAL_GRACE_DAYS дней после окончания. Возвращения: клиенты, у которых
 * на начало месяца все абонементы этого вида закончились больше
 * RENEWAL_GRACE_DAYS дней назад, — какая доля купила такой абонемент в этом
 * месяце.
 */
export function renewalRates(all: SaleRecord[], anchor: Date, months = 5): MonthRate[] {
  const history = all.filter(counts);
  const clients = byClient(history);
  const iso = (d: Date) => format(d, "yyyy-MM-dd");
  const result: MonthRate[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = startOfMonth(addMonths(anchor, -i));
    const from = iso(start);
    const to = iso(endOfMonth(start));
    const lapsedBefore = iso(addDays(start, -RENEWAL_GRACE_DAYS));

    let renewalBase = 0;
    let renewed = 0;
    let returnBase = 0;
    let returned = 0;
    for (const list of clients.values()) {
      list.forEach((s, idx) => {
        if (s.cancelled || s.endsAt === null || !inPeriod(s.endsAt, from, to)) return;
        renewalBase++;
        const deadline = iso(addDays(parseISO(s.endsAt), RENEWAL_GRACE_DAYS));
        if (list.slice(idx + 1).some((next) => next.soldAt <= deadline)) renewed++;
      });

      const before = list.filter((s) => s.soldAt < from);
      if (before.length === 0) continue;
      const end = latestEnd(before);
      if (end === null || end >= lapsedBefore) continue;
      returnBase++;
      if (list.some((s) => inPeriod(s.soldAt, from, to))) returned++;
    }
    const pct = (n: number, base: number) => (base ? (n / base) * 100 : null);
    result.push({
      key: from,
      tick: format(start, "LLL yy", { locale: ru }),
      label: format(start, "LLLL yyyy", { locale: ru }),
      renewal: pct(renewed, renewalBase),
      renewalBase,
      renewed,
      returnRate: pct(returned, returnBase),
      returnBase,
      returned,
    });
  }
  return result;
}

/** Сумма по ключу; порядок — по убыванию суммы. */
export function groupSum<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => number,
): { key: string; value: number; n: number }[] {
  const map = new Map<string, { value: number; n: number }>();
  for (const r of rows) {
    const k = key(r);
    const g = map.get(k) ?? { value: 0, n: 0 };
    g.value += value(r);
    g.n += 1;
    map.set(k, g);
  }
  return [...map.entries()].map(([k, g]) => ({ key: k, ...g })).sort((a, b) => b.value - a.value);
}

/**
 * Доли для круговой диаграммы: первые `max - 1` по убыванию, остальное —
 * одним куском «Остальное» (цветов в палитре конечное число).
 */
export function foldSlices(
  slices: { key: string; label: string; value: number }[],
  max: number,
  otherLabel = "Остальное",
) {
  const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((s, x) => s + x.value, 0);
  return [...head, { key: "__other", label: otherLabel, value: rest }];
}

/** Возрастные группы клиентов: десятилетия и «не указан». */
export const AGE_GROUPS = [
  { key: "10", label: "10–20", max: 20 },
  { key: "20", label: "20–30", max: 30 },
  { key: "30", label: "30–40", max: 40 },
  { key: "40", label: "40–50", max: 50 },
  { key: "50", label: "50–60", max: 60 },
  { key: "60", label: "60+", max: Infinity },
] as const;

export const AGE_UNKNOWN = { key: "none", label: "Не указан" } as const;

/** Полных лет на дату; дата рождения пустая или нелепая (будущее, старше 110) — null. */
export function ageOn(birthday: string | null | undefined, today: Date): number | null {
  if (!birthday) return null;
  const age = differenceInYears(today, parseISO(birthday));
  return Number.isFinite(age) && age >= 0 && age <= 110 ? age : null;
}

export function ageGroups(ages: (number | null)[]) {
  const groups = [...AGE_GROUPS, AGE_UNKNOWN].map((g) => ({
    key: g.key,
    label: g.label,
    value: 0,
  }));
  for (const age of ages) {
    const idx = age === null ? groups.length - 1 : AGE_GROUPS.findIndex((g) => age < g.max);
    groups[idx].value++;
  }
  return groups;
}

/** Точки по дням периода (включая пустые дни) — для графиков «по дням». */
export function dailySeries(points: { date: string; value: number }[], from: string, to: string) {
  const totals = new Map<string, number>();
  for (const p of points) {
    if (inPeriod(p.date, from, to)) totals.set(p.date, (totals.get(p.date) ?? 0) + p.value);
  }
  const out: { date: string; tick: string; label: string; value: number }[] = [];
  const end = parseISO(to);
  for (let d = parseISO(from); d <= end; d = addDays(d, 1)) {
    const key = format(d, "yyyy-MM-dd");
    out.push({
      date: key,
      tick: format(d, "d MMM", { locale: ru }),
      label: format(d, "EEEEEE, d MMMM yyyy", { locale: ru }),
      value: totals.get(key) ?? 0,
    });
  }
  return out;
}

/** Показатели раздела «Продажи» за период (плитки). */
export function salesMetrics(
  history: { sales: SaleRecord[]; otherSales: OtherSaleRecord[] },
  from: string,
  to: string,
) {
  const sold = history.sales.filter((s) => inPeriod(s.soldAt, from, to));
  const payments = membershipPayments(history.sales).filter((p) => inPeriod(p.date, from, to));
  const others = history.otherSales.filter((s) => inPeriod(s.soldAt, from, to));
  const membershipRevenue = sumBy(sold, (s) => s.totalAmount);
  const paid = sumBy(payments, (p) => p.amount);
  const otherRevenue = sumBy(others, (s) => s.totalAmount);
  const singles = sold.filter((s) => s.single && !s.noMembership);
  const avg = (total: number, n: number) => (n ? total / n : 0);
  return {
    membershipRevenue,
    membershipPayments: paid,
    otherRevenue,
    singleRevenue: sumBy(singles, (s) => s.totalAmount),
    singleVisits: singles.length,
    avgMembershipCheck: avg(membershipRevenue, sold.length),
    avgMembershipPayment: avg(paid, payments.length),
    avgOtherCheck: avg(otherRevenue, others.length),
  };
}

/**
 * LTV — сколько денег принёс клиент за всё время: платежи по абонементам и
 * прочим продажам минус возвраты по его продажам.
 */
export function clientLtv(history: {
  sales: SaleRecord[];
  otherSales: OtherSaleRecord[];
  refunds: RefundRecord[];
}): Map<string, number> {
  const ltv = new Map<string, number>();
  const add = (clientId: string | null | undefined, amount: number) => {
    if (clientId) ltv.set(clientId, (ltv.get(clientId) ?? 0) + amount);
  };
  for (const p of [...membershipPayments(history.sales), ...otherPayments(history.otherSales)])
    add(p.clientId, p.amount);
  const saleClient = new Map(history.sales.map((s) => [s.id, s.clientId]));
  const otherClient = new Map(history.otherSales.map((s) => [s.id, s.clientId]));
  for (const r of history.refunds) {
    const clientId = r.saleId
      ? saleClient.get(r.saleId)
      : r.otherSaleId && otherClient.get(r.otherSaleId);
    add(clientId, -r.amount);
  }
  return ltv;
}
