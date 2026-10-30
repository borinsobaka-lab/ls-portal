/**
 * FitBase — расчёты сетевых отчётов, как у них (fitbase_runtime.py и
 * страницы app.py): «Выручка по городам» (revenue_report,
 * fitbase_revenue_page), «Продажи абонементов» (sales_report,
 * fitbase_sales_page), «Маркетинговый отчёт» (report, fitbase_report_page).
 * Без React и запросов: факты студий отдают RPC an_fb_revenue_data /
 * an_fb_sales_data / an_fb_marketing_data (data.ts), здесь — их правила
 * отбора студий, суммы, сравнения и форматы чисел.
 */
import { pyRound } from "../onec-reports/payload";
import { casefold } from "../onec/rules";
import { pyStr } from "../vk/lf";
import { VK_VAT } from "../vk/view";
import {
  FB_REVENUE_TZ,
  FbError,
  daysIn,
  fbAddDays,
  fbCanonicalCity,
  fbDaysBetween,
  fbDay,
  fbIsoDate,
  fbRevenuePeriod,
  fbShiftMonths,
  pyFalsy,
} from "./rules";

/** Подключение в отчётах (их connections(): ORDER BY brand, city, name). */
export type FbReportConnection = {
  id: number;
  name: string;
  brand: string;
  city: string;
  domain: string;
  club_id: string;
  studio_status: "active" | "archived";
  marketing_disabled: boolean;
  partner_name: string;
  synced_at: number | null;
  sales_payments_at: number | null;
  sales_state: string;
  revenue_synced_at: number | null;
  revenue_from: string;
  revenue_to: string;
  revenue_state: string;
};

// --- Форматы их страниц ------------------------------------------------------------------

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** format(n, ',').replace(',', ' ') для целых. */
export const fbInteger = (n: number) => (n < 0 ? "-" : "") + group(String(Math.abs(n)));

/**
 * format(x, '<+>.<d>f') Python: двоичное значение, половина — к чётному;
 * у отрицательного, округлённого до нуля, остаётся «-».
 */
export function fbFixed(x: number, digits: number, plus = false): string {
  const neg = x < 0 || Object.is(x, -0);
  const text = Math.abs(pyRound(x, digits)).toFixed(digits);
  return (neg ? "-" : plus ? "+" : "") + text;
}

/** format(x, '<+>.<d>%') Python: умножение на 100 во float, затем «f». */
export const fbPercent = (x: number, digits: number, plus = false) =>
  `${fbFixed(x * 100, digits, plus)}%`;

/** f"{x:,.0f}" Python с пробелами: и «-0» у отрицательного, округлённого до нуля. */
export function fbWhole(x: number): string {
  const text = fbFixed(x, 0);
  return text.startsWith("-") ? `-${group(text.slice(1))}` : group(text);
}

/** Их money отчётов продаж: f"{cents / 100:,.0f}" с пробелами. */
export const fbSalesMoney = (cents: number | null) => (cents === null ? "—" : fbWhole(cents / 100));

/**
 * Их money «Выручки»: Decimal(копейки) / 100, ROUND_HALF_UP до рубля,
 * format(…, ',') — у отрицательной суммы, округлённой до нуля, «-0».
 */
export function fbRevenueMoney(cents: number | null): string {
  if (cents === null) return "—";
  const rub = Math.floor((Math.abs(cents) + 50) / 100);
  return (cents < 0 ? "-" : "") + group(String(rub));
}

/** int(Decimal(a) * b / c).quantize(1, ROUND_HALF_UP) — точная дробь. */
function halfUpRatio(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return Number(neg ? -q : q);
}

/** strftime('%d.%m.%Y %H:%M') по зоне (у «Выручки» — '%d.%m.%y', Самара). */
export function fbTimestamp(sec: number, zone = "Europe/Moscow", shortYear = false): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(sec * 1000))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month}.${shortYear ? p.year.slice(2) : p.year} ${p.hour}:${p.minute}`;
}

/** «ГГГГ-ММ-ДД» → «ДД.ММ.ГГГГ». */
export const fbDots = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

const RU_MONTHS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
export const fbMonthName = (iso: string) => RU_MONTHS[Number(iso.slice(5, 7)) - 1];

/** Одна студия на пару «домен + клуб» — с самой свежей загрузкой (их owners). */
function owners<T extends { id: number; domain: string; club_id: string }>(
  list: T[],
  stamp: (c: T) => number | null,
): T[] {
  const byKey = new Map<string, T>();
  for (const c of list) {
    const key = `${c.domain}\u0000${c.club_id}`;
    const prev = byKey.get(key);
    if (
      !prev ||
      (stamp(c) || 0) > (stamp(prev) || 0) ||
      ((stamp(c) || 0) === (stamp(prev) || 0) && c.id > prev.id)
    ) {
      byKey.set(key, c);
    }
  }
  return [...byKey.values()];
}

/** bisect_left / bisect_right Python по отсортированным строкам. */
function bisect(list: string[], x: string, right: boolean): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (right ? x < list[mid] : x <= list[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// --- «Выручка по городам» -----------------------------------------------------------------

export type FbRevenueData = {
  admin: boolean;
  connections: FbReportConnection[];
  /** [connection_id, день «ГГГГ-ММ-ДД», копейки] */
  daily: [number, string, number][];
};

export type FbCoverage = { known: number; expected: number };

export type FbRevenueRow = {
  current: number | null;
  forecast: number | null;
  weeks: (number | null)[];
  months: (number | null)[];
  coverage?: { current: FbCoverage; weeks: FbCoverage[]; months: FbCoverage[] };
};

export type FbRevenueReport = {
  period: ReturnType<typeof fbRevenuePeriod>;
  connections: FbReportConnection[];
  studios: Record<number, FbRevenueRow>;
  cities: [string, Required<FbRevenueRow>][];
  total: Required<FbRevenueRow>;
  opened: Required<FbRevenueRow>;
  closed: Required<FbRevenueRow>;
  ready: boolean;
  updated: number | null;
};

/** Сегодня по Самаре — их REVENUE_TZ. */
export const fbRevenueToday = (now = Date.now()) => fbDay(now / 1000, FB_REVENUE_TZ);

/** Их revenue_report: факт, недели, прогноз и шесть прошлых месяцев по студиям и городам. */
export function fbRevenueReport(
  data: Pick<FbRevenueData, "connections" | "daily">,
  opts: { offset: number; search: string; status: string; today?: string },
): FbRevenueReport {
  const period = fbRevenuePeriod(opts.offset, opts.today ?? fbRevenueToday());
  if (!["", "active", "archived"].includes(opts.status)) {
    throw new FbError("Выберите статус студии.");
  }
  const q = casefold(opts.search);
  const connections = data.connections.filter(
    (c) =>
      c.club_id &&
      (!opts.status || c.studio_status === opts.status) &&
      (!opts.search || casefold(c.city).includes(q) || casefold(c.name).includes(q)),
  );
  const selected = owners(connections, (c) => c.revenue_synced_at);
  const ids = new Set(selected.map((c) => c.id));
  const daily = new Map<number, Map<string, number>>(selected.map((c) => [c.id, new Map()]));
  for (const [id, day, cents] of data.daily) {
    if (ids.has(id) && day >= period.fromDate && day <= period.cutoff)
      daily.get(id)!.set(day, cents);
  }
  const series = new Map<number, { dates: string[]; sums: number[] }>();
  for (const [id, values] of daily) {
    const dates = [...values.keys()].sort(codeSort);
    const sums = [0];
    for (const d of dates) sums.push(sums[sums.length - 1] + values.get(d)!);
    series.set(id, { dates, sums });
  }
  const { first, cutoff, elapsed, days } = period;
  const sumFor = (c: FbReportConnection, lo: string, hi: string): number | null => {
    if (hi < lo) return 0;
    if (!c.revenue_synced_at || c.revenue_from > lo || c.revenue_to < hi) return null;
    const { dates, sums } = series.get(c.id)!;
    return sums[bisect(dates, hi, true)] - sums[bisect(dates, lo, false)];
  };
  const forecast = (amount: number | null) =>
    amount === null || !elapsed ? null : halfUpRatio(amount, days, elapsed);
  const dayOf = (d: number) => `${first.slice(0, 8)}${String(d).padStart(2, "0")}`;
  const minIso = (a: string, b: string) => (a < b ? a : b);
  const studios: Record<number, FbRevenueRow> = {};
  for (const c of selected) {
    const current = sumFor(c, first, cutoff);
    const weeks = (
      [
        [1, 4],
        [5, 11],
        [12, 18],
        [19, 25],
        [26, days],
      ] as const
    ).map(([lo, hi]) => sumFor(c, dayOf(lo), minIso(dayOf(Math.min(hi, days)), cutoff)));
    const months = period.history.map((m) => {
      const { y, m: mo } = fbIsoDate(m);
      return sumFor(c, m, `${m.slice(0, 8)}${String(daysIn(y, mo)).padStart(2, "0")}`);
    });
    studios[c.id] = { current, forecast: forecast(current), weeks, months };
  }
  const add = (list: number[]): Required<FbRevenueRow> => {
    const rows = list.map((id) => studios[id]);
    const complete = (items: (number | null)[]) => {
      const known = items.filter((v): v is number => v !== null);
      return known.length || !items.length ? known.reduce((s, v) => s + v, 0) : null;
    };
    const coverage = (items: (number | null)[]): FbCoverage => ({
      known: items.filter((v) => v !== null).length,
      expected: items.length,
    });
    const current = complete(rows.map((r) => r.current));
    return {
      coverage: {
        current: coverage(rows.map((r) => r.current)),
        weeks: [0, 1, 2, 3, 4].map((i) => coverage(rows.map((r) => r.weeks[i]))),
        months: [0, 1, 2, 3, 4, 5].map((i) => coverage(rows.map((r) => r.months[i]))),
      },
      current,
      forecast: forecast(current),
      weeks: [0, 1, 2, 3, 4].map((i) => complete(rows.map((r) => r.weeks[i]))),
      months: [0, 1, 2, 3, 4, 5].map((i) => complete(rows.map((r) => r.months[i]))),
    };
  };
  const cityNames = [...new Set(selected.map((c) => c.city))].sort(codeSort);
  const cities = cityNames.map(
    (name) =>
      [name, add(selected.filter((c) => c.city === name).map((c) => c.id))] as [
        string,
        Required<FbRevenueRow>,
      ],
  );
  let total = add(selected.map((c) => c.id));
  const opened = add(selected.filter((c) => c.studio_status === "active").map((c) => c.id));
  const closed = add(selected.filter((c) => c.studio_status === "archived").map((c) => c.id));
  if (!selected.length) {
    total = {
      ...total,
      current: null,
      forecast: null,
      weeks: Array(5).fill(null),
      months: Array(6).fill(null),
    };
  }
  const stamps = selected.map((c) => c.revenue_synced_at).filter((v): v is number => !!v);
  return {
    period,
    connections: selected,
    studios,
    cities,
    total,
    opened,
    closed,
    ready: selected.length > 0 && total.coverage.current.known === selected.length,
    updated: stamps.length ? Math.min(...stamps) : null,
  };
}

/** Строка «Город — все его студии без выручки» (их data-fbr-zero). */
export const fbRevenueZero = (row: FbRevenueRow) =>
  [row.current, ...row.months].every((v) => v === 0);

/** Подсказка «Выручки»; link — их ссылка на «Интеграцию FitBase» (только администратору). */
export type FbNote = { text: string; link?: string };

/** Их подсказки под фильтрами «Выручки» — в их порядке. */
export function fbRevenueNotes(r: FbRevenueReport, notice: boolean): FbNote[] {
  const notes: FbNote[] = [];
  let note: FbNote | null = null;
  if (!r.ready && r.connections.length) {
    note = {
      text: "Выручка текущего месяца ещё не загружена полностью. Нажмите «Обновить выручку» или загрузите её в карточке студии.",
    };
  } else if (r.connections.some((c) => !c.revenue_state.startsWith("Выручка загружена"))) {
    note = {
      text: "Последняя попытка загрузки выручки завершилась ошибкой. Показаны предыдущие успешные данные.",
      link: "Проверить состояние",
    };
  } else if (r.total.months.some((v) => v === null) && r.connections.length) {
    note = {
      text: "Часть выбранной истории ещё не загружена. Нажмите «Обновить выручку», чтобы получить эти месяцы.",
    };
  }
  const counts = r.total.coverage.current;
  if (counts.known < counts.expected) {
    const missing = r.connections
      .filter((c) => r.studios[c.id].current === null)
      .map((c) => c.name)
      .join(", ");
    notes.push({
      text: `Учтено студий: ${counts.known} из ${counts.expected}. Итоги и прогноз рассчитаны по доступным данным. Не учтены: ${missing}. Если данных нет ни у одной студии, показан прочерк.`,
      link: "Проверить загрузку",
    });
  }
  if (note) notes.push(note);
  if ([...r.total.coverage.months, ...r.total.coverage.weeks].some((c) => c.known < c.expected)) {
    notes.push({
      text: "* Неполная сумма по доступным студиям. Наведите на значение, чтобы увидеть число учтённых студий.",
    });
  }
  if (notice)
    notes.unshift({ text: "Загрузка выполняется в фоне. Страница обновится после её завершения." });
  return notes;
}

// --- «Продажи абонементов» ------------------------------------------------------------------

export type FbSalesData = {
  connections: FbReportConnection[];
  /** [connection_id, contract_id, client_id, purchased_at, price_cents, paid_cents] */
  sales: [number, string, string, number, number, number][];
  /** [connection_id, contract_id, client_id, purchased_at, price_cents] */
  history: [number, string, string, number, number][];
  /** [connection_id, operation, step_id, contract_id, client_id, pay_at, day, amount_cents] */
  payments: [number, string, string, string, string, number, string, number][];
};

export type FbSalesBucket = {
  count: number;
  new: number;
  repeat: number;
  new_paid: number | null;
  repeat_paid: number | null;
  amount: number | null;
  new_amount: number | null;
  repeat_amount: number | null;
  unassigned_paid: number | null;
  gross: number | null;
  refund: number | null;
  paid_count: number | null;
  new_paid_count: number | null;
  repeat_paid_count: number | null;
};

export type FbSalesPaymentRow = {
  connection_id: number;
  operation: string;
  step_id: string;
  contract_id: string;
  client_id: string;
  pay_at: number;
  amount_cents: number;
  studio: string;
  city: string;
  new: boolean | null;
  paid_cents: number;
};

export type FbSalesReport = {
  total: FbSalesBucket;
  previous: FbSalesBucket;
  last_year: FbSalesBucket;
  /** [город, итоги] — в порядке появления (страница сортирует). */
  cities: [string, FbSalesBucket][];
  /** [[город, id, студия], итоги] */
  studios: [[string, number, string], FbSalesBucket][];
  city_comparison: Map<string, [FbSalesBucket, FbSalesBucket]>;
  studio_comparison: Map<number, [FbSalesBucket, FbSalesBucket]>;
  months: (FbSalesBucket & { month: string })[];
  connections: FbReportConnection[];
  ready: boolean;
  updated: number | null;
  pending: number;
  payment_rows: FbSalesPaymentRow[];
  unclassified: number;
};

type SalesEntry = {
  connection_id: number;
  contract_id: string;
  client_id: string;
  city: string;
  studio: string;
  new: boolean | null;
  day: string;
  is_payment: boolean;
  operation: string;
  amount_cents: number;
  paid_cents: number;
};

/** Их shift(d, months, years): день — не больше дней месяца. */
const shift = (d: string, months: number) => fbShiftMonths(d, months);

/** Их sales_report: новые и повторные покупки, оплаты, сравнения с прошлым месяцем и годом. */
export function fbSalesReport(
  data: FbSalesData,
  opts: { start: string; end: string; brand: string; city: string; studio: string; search: string },
): FbSalesReport {
  const city = fbCanonicalCity(opts.brand, opts.city);
  const { start, end } = opts;
  fbIsoDate(start);
  fbIsoDate(end);
  if (end < start || fbDaysBetween(start, end) >= 366) {
    throw new FbError("Выберите период не больше 366 дней.");
  }
  const q = casefold(opts.search);
  const filtered = data.connections.filter(
    (c) =>
      c.club_id &&
      (!opts.brand || c.brand === opts.brand) &&
      (!city || c.city === city) &&
      (!opts.studio || String(c.id) === String(opts.studio)) &&
      (!opts.search || casefold(c.city).includes(q)),
  );
  const selected = owners(filtered, (c) => c.sales_payments_at);
  const byId = new Map(selected.map((c) => [c.id, c]));
  const complete = selected.every((c) => !!c.sales_payments_at);

  // История покупок: новая — первая платная покупка клиента в клубе.
  type Candidate = {
    connection_id: number;
    contract_id: string;
    client_id: string;
    purchased_at: number;
    price_cents: number;
  };
  const candidates = new Map<string, Candidate>();
  const ident = (conn: number, contract: string) => `${conn}\u0000${contract}`;
  for (const [conn, contract, client, at, price] of data.sales) {
    if (byId.has(conn))
      candidates.set(ident(conn, contract), {
        connection_id: conn,
        contract_id: contract,
        client_id: client,
        purchased_at: at,
        price_cents: price,
      });
  }
  for (const [conn, contract, client, at, price] of data.history) {
    if (byId.has(conn))
      candidates.set(ident(conn, contract), {
        connection_id: conn,
        contract_id: contract,
        client_id: client,
        purchased_at: at,
        price_cents: price,
      });
  }
  const paidIds = new Set(
    data.payments.filter((p) => p[1] === "purchase" && p[7] > 0).map((p) => ident(p[0], p[3])),
  );
  const numeric = (s: string) => (/^[0-9]+$/.test(s) ? Number(s) : 0);
  const ordered = [...candidates.entries()].sort(([, a], [, b]) => {
    if (a.purchased_at !== b.purchased_at) return a.purchased_at - b.purchased_at;
    const na = numeric(a.contract_id);
    const nb = numeric(b.contract_id);
    if (na !== nb) return na - nb;
    return codeSort(a.contract_id, b.contract_id);
  });
  const firstSeen = new Set<string>();
  const history = new Map<string, { new: boolean | null; client_id: string }>();
  for (const [identity, r] of ordered) {
    if (r.price_cents <= 0 && !paidIds.has(identity)) continue;
    const c = byId.get(r.connection_id)!;
    const key = `${c.domain}\u0000${c.club_id}\u0000${r.client_id}`;
    const isNew = !firstSeen.has(key);
    firstSeen.add(key);
    history.set(identity, { new: isNew, client_id: r.client_id });
  }

  const entries: SalesEntry[] = [];
  const paymentRows: FbSalesPaymentRow[] = [];
  // Их ORDER BY purchased_at, CAST(contract_id AS INTEGER), contract_id (SQLite: ведущее число).
  const castInt = (s: string) => {
    const m = /^\s*([+-]?\d+)/.exec(s);
    return m ? Number(m[1]) : 0;
  };
  const salesOrdered = [...data.sales].sort((a, b) => {
    if (a[3] !== b[3]) return a[3] - b[3];
    const na = castInt(a[1]);
    const nb = castInt(b[1]);
    if (na !== nb) return na - nb;
    return codeSort(a[1], b[1]);
  });
  for (const [conn, contract, client, at] of salesOrdered) {
    const c = byId.get(conn);
    if (!c) continue;
    const known = history.get(ident(conn, contract))!;
    entries.push({
      connection_id: conn,
      contract_id: contract,
      client_id: client,
      city: c.city,
      studio: c.name,
      new: known.new,
      day: fbDay(at),
      is_payment: false,
      operation: "",
      amount_cents: 0,
      paid_cents: 0,
    });
    history.set(ident(conn, contract), { new: known.new, client_id: client });
  }
  const paymentsOrdered = [...data.payments].sort((a, b) =>
    a[5] !== b[5] ? a[5] - b[5] : codeSort(a[2], b[2]),
  );
  for (const [conn, operation, step, contract, client, payAt, day, amount] of paymentsOrdered) {
    const c = byId.get(conn);
    if (!c || !c.sales_payments_at) continue;
    const purchase = history.get(ident(conn, contract));
    const entry: SalesEntry = {
      connection_id: conn,
      contract_id: contract,
      client_id: !client && purchase ? purchase.client_id : client,
      city: c.city,
      studio: c.name,
      new: purchase ? purchase.new : null,
      day,
      is_payment: true,
      operation,
      amount_cents: amount,
      paid_cents: amount * (operation === "purchase" ? 1 : -1),
    };
    entries.push(entry);
    if (start <= day && day <= end) {
      paymentRows.push({
        connection_id: conn,
        operation,
        step_id: step,
        contract_id: contract,
        client_id: entry.client_id,
        pay_at: payAt,
        amount_cents: amount,
        studio: c.name,
        city: c.city,
        new: entry.new,
        paid_cents: entry.paid_cents,
      });
    }
  }

  type Acc = FbSalesBucket & { seen: Set<string> };
  const empty = (): Acc => ({
    count: 0,
    new: 0,
    repeat: 0,
    new_paid: complete ? 0 : null,
    repeat_paid: complete ? 0 : null,
    amount: complete ? 0 : null,
    new_amount: complete ? 0 : null,
    repeat_amount: complete ? 0 : null,
    unassigned_paid: complete ? 0 : null,
    gross: complete ? 0 : null,
    refund: complete ? 0 : null,
    paid_count: 0,
    new_paid_count: 0,
    repeat_paid_count: 0,
    seen: new Set(),
  });
  const plus = (v: number | null, d: number) => (v === null ? null : v + d);
  const add = (t: Acc, r: SalesEntry) => {
    if (!r.is_payment) {
      t.count += 1;
      if (r.new) t.new += 1;
      else t.repeat += 1;
      return;
    }
    t.amount = plus(t.amount, r.paid_cents);
    if (r.operation === "purchase") {
      const identity = ident(r.connection_id, r.contract_id);
      if (!r.contract_id) t.paid_count = null;
      else if (!t.seen.has(identity)) {
        t.seen.add(identity);
        t.paid_count = plus(t.paid_count, 1);
        if (r.new !== null) {
          if (r.new) t.new_paid_count = plus(t.new_paid_count, 1);
          else t.repeat_paid_count = plus(t.repeat_paid_count, 1);
        }
      }
    }
    if (r.operation === "purchase") t.gross = plus(t.gross, r.amount_cents);
    else t.refund = plus(t.refund, r.amount_cents);
    if (r.new === null) t.unassigned_paid = plus(t.unassigned_paid, r.paid_cents);
    else if (r.new) {
      t.new_paid = plus(t.new_paid, r.paid_cents);
      t.new_amount = plus(t.new_amount, r.paid_cents);
    } else {
      t.repeat_paid = plus(t.repeat_paid, r.paid_cents);
      t.repeat_amount = plus(t.repeat_amount, r.paid_cents);
    }
  };
  const done = (t: Acc): FbSalesBucket => {
    const { seen: _seen, ...rest } = t;
    void _seen;
    return rest;
  };
  const summarize = (lo: string, hi: string) => {
    const t = empty();
    for (const r of entries) if (lo <= r.day && r.day <= hi) add(t, r);
    return done(t);
  };
  const prevStart = shift(start, -1);
  const prevEnd = shift(end, -1);
  const yearStart = shift(start, -12);
  const yearEnd = shift(end, -12);
  const cities = new Map<string, Acc>();
  const studios = new Map<string, { key: [string, number, string]; acc: Acc }>();
  for (const r of entries) {
    if (start <= r.day && r.day <= end) {
      if (!cities.has(r.city)) cities.set(r.city, empty());
      add(cities.get(r.city)!, r);
      const sk = `${r.city}\u0000${r.connection_id}\u0000${r.studio}`;
      if (!studios.has(sk))
        studios.set(sk, { key: [r.city, r.connection_id, r.studio], acc: empty() });
      add(studios.get(sk)!.acc, r);
    }
  }
  const compare = (match: (r: SalesEntry) => boolean): [FbSalesBucket, FbSalesBucket] => {
    const prior = empty();
    const year = empty();
    for (const r of entries) {
      if (!match(r)) continue;
      if (prevStart <= r.day && r.day <= prevEnd) add(prior, r);
      if (yearStart <= r.day && r.day <= yearEnd) add(year, r);
    }
    return [done(prior), done(year)];
  };
  const cityComparison = new Map<string, [FbSalesBucket, FbSalesBucket]>();
  for (const name of cities.keys())
    cityComparison.set(
      name,
      compare((r) => r.city === name),
    );
  const studioComparison = new Map<number, [FbSalesBucket, FbSalesBucket]>();
  for (const { key } of studios.values()) {
    studioComparison.set(
      key[1],
      compare((r) => r.connection_id === key[1]),
    );
  }
  const months: (FbSalesBucket & { month: string })[] = [];
  const cursor = shift(`${end.slice(0, 8)}01`, -8);
  for (let i = 0; i < 9; i++) {
    const lo = shift(cursor, i);
    const { y, m } = fbIsoDate(lo);
    const hi = `${lo.slice(0, 8)}${String(daysIn(y, m)).padStart(2, "0")}`;
    months.push({ month: lo.slice(0, 7), ...summarize(lo, hi < end ? hi : end) });
  }
  const stamps = selected.map((c) => c.sales_payments_at).filter((v): v is number => !!v);
  return {
    total: summarize(start, end),
    previous: summarize(prevStart, prevEnd),
    last_year: summarize(yearStart, yearEnd),
    cities: [...cities.entries()].map(([k, v]) => [k, done(v)]),
    studios: [...studios.values()].map((s) => [s.key, done(s.acc)]),
    city_comparison: cityComparison,
    studio_comparison: studioComparison,
    months,
    connections: selected,
    ready: selected.length > 0 && complete,
    updated: stamps.length ? Math.min(...stamps) : null,
    pending: selected.filter((c) => !c.sales_payments_at).length,
    payment_rows: paymentRows,
    unclassified: paymentRows.filter((r) => r.new === null).length,
  };
}

/** Их avg: средний чек по числу разных абонементов с оплатой. */
export function fbSalesAverage(v: FbSalesBucket, key: "new" | "repeat" | "all"): string {
  const count =
    key === "all" ? v.paid_count : key === "new" ? v.new_paid_count : v.repeat_paid_count;
  const paid = key === "all" ? v.amount : key === "new" ? v.new_paid : v.repeat_paid;
  return count && paid !== null ? fbSalesMoney(paid / count) : "—";
}

export type FbDelta = { text: string; tone: "up" | "down" | "neutral" };

/** Их delta плиток: «↑ +12%» к тому же периоду прошлого месяца. */
export function fbSalesDelta(value: number | null, before: number | null, ready: boolean): FbDelta {
  if (!ready) return { text: "—", tone: "neutral" };
  if (value === null || before === null || !before)
    return { text: "Нет базы сравнения", tone: "neutral" };
  const diff = value - before;
  const tone = diff > 0 ? "up" : diff < 0 ? "down" : "neutral";
  const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
  return { text: `${arrow} ${fbPercent(diff / before, 0, true)}`, tone };
}

/** Их amount_delta таблицы: «↑ 1 200 (+10%)». */
export function fbSalesAmountDelta(
  value: number | null,
  before: number | null,
  ready: boolean,
): FbDelta {
  if (!ready || value === null || before === null || !before) return { text: "—", tone: "neutral" };
  const d = value - before;
  const tone = d > 0 ? "up" : d < 0 ? "down" : "neutral";
  const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  return { text: `${arrow} ${fbSalesMoney(d)} (${fbPercent(d / before, 0, true)})`, tone };
}

/** Их подписи месяцев графиков. */
export const FB_SHORT_MONTHS = [
  "Янв",
  "Фев",
  "Мар",
  "Апр",
  "Май",
  "Июн",
  "Июл",
  "Авг",
  "Сен",
  "Окт",
  "Ноя",
  "Дек",
];

// --- «Маркетинговый отчёт» ------------------------------------------------------------------

export type FbMarketingConnection = {
  id: number;
  name: string;
  brand: string;
  city: string;
  domain: string;
  club_id: string;
  partner_name: string;
  synced_at: number | null;
  step_rules: Record<string, unknown>;
  source_rules: Record<string, unknown>;
  sources: { id: unknown; name: unknown }[];
};

export type FbMarketingData = {
  brand: string;
  from: string;
  to: string;
  connections: FbMarketingConnection[];
  /** [connection_id, lead_id, client_key, created_at, step_id, source_id] */
  leads: [number, string, string, number, string, string][];
  /** [город, расход VK без НДС, из него лид-формы] */
  budgets: [string, number | null, number | null][];
};

export type FbMarketingRow = {
  city: string;
  source: string;
  bucket: string;
  leads: number;
  duplicates: number;
  booked: number;
  attended: number;
  paid: number;
  no_show: number;
  no_purchase: number;
  lost: number;
  unmapped: number;
  duplicate_groups?: { sources: string[]; count: number }[];
};

/** Их report(): лиды по городу, источнику и бюджетному типу; повторные заявки клиента — дубли. */
export function fbMarketingRows(data: FbMarketingData, city: string): FbMarketingRow[] {
  const canonical = fbCanonicalCity(data.brand, city);
  const connections = new Map(
    data.connections
      .filter((c) => c.brand === data.brand && (!canonical || c.city === canonical))
      .map((c) => [c.id, c]),
  );
  if (!connections.size) return [];
  const lookups = new Map<
    number,
    {
      rules: Record<string, unknown>;
      sourceRules: Record<string, unknown>;
      sources: Map<string, string>;
    }
  >();
  for (const [id, c] of connections) {
    const sources = new Map<string, string>();
    for (const s of c.sources) {
      const key = pyStr(s.id);
      if (!sources.has(key)) sources.set(key, pyFalsy(s.name) ? "Без источника" : pyStr(s.name));
    }
    lookups.set(id, { rules: c.step_rules ?? {}, sourceRules: c.source_rules ?? {}, sources });
  }
  type Item = { city: string; source: string; bucket: string; outcome: string; duplicate: boolean };
  const clients = new Set<string>();
  const seenLeads = new Set<string>();
  const items: Item[] = [];
  const clientItems = new Map<string, Item[]>();
  for (const [conn, leadId, clientKey, , stepId, sourceId] of data.leads) {
    const c = connections.get(conn);
    if (!c) continue;
    const identity = `${c.domain}\u0000${c.club_id}\u0000${leadId}`;
    if (seenLeads.has(identity)) continue;
    seenLeads.add(identity);
    const { rules, sourceRules, sources } = lookups.get(conn)!;
    const outcome = rules[stepId];
    if (outcome === "ignore") continue;
    let source = sources.get(sourceId) ?? "Без источника";
    const rawBucket = sourceRules[sourceId];
    const bucket = rawBucket === undefined ? "none" : String(rawBucket);
    if (bucket === "community_messages") source = "VK · сообщения";
    else if (bucket === "lead_forms") source = "VK · лид-формы";
    const key = `${c.domain}\u0000${c.club_id}\u0000${clientKey}`;
    const item: Item = {
      city: c.city,
      source,
      bucket,
      outcome: typeof outcome === "string" && outcome ? outcome : "unmapped",
      duplicate: clients.has(key),
    };
    items.push(item);
    if (!clientItems.has(key)) clientItems.set(key, []);
    clientItems.get(key)!.push(item);
    clients.add(key);
  }
  const result = new Map<string, FbMarketingRow>();
  const rowKey = (i: { city: string; source: string; bucket: string }) =>
    `${i.city}\u0000${i.source}\u0000${i.bucket}`;
  for (const item of items) {
    const k = rowKey(item);
    if (!result.has(k)) {
      result.set(k, {
        city: item.city,
        source: item.source,
        bucket: item.bucket,
        leads: 0,
        duplicates: 0,
        booked: 0,
        attended: 0,
        paid: 0,
        no_show: 0,
        no_purchase: 0,
        lost: 0,
        unmapped: 0,
      });
    }
    const r = result.get(k)!;
    const o = item.outcome;
    r.leads += 1;
    r.duplicates += item.duplicate ? 1 : 0;
    r.booked += ["booked", "attended", "paid", "no_show", "no_purchase"].includes(o) ? 1 : 0;
    r.attended += ["attended", "paid", "no_purchase"].includes(o) ? 1 : 0;
    if (o === "paid") r.paid += 1;
    if (o === "no_show") r.no_show += 1;
    if (o === "no_purchase") r.no_purchase += 1;
    if (o === "lost") r.lost += 1;
    if (o === "unmapped") r.unmapped += 1;
  }
  const combinations = new Map<string, Map<string, { names: string[]; count: number }>>();
  for (const requests of clientItems.values()) {
    if (requests.length < 2) continue;
    const anchor = rowKey(requests[0]);
    const unique = [...new Set(requests.map((r) => r.source))];
    let names = [...unique].sort((a, b) => codeSort(casefold(a), casefold(b)));
    if (names.length === 1) names = [names[0], names[0]];
    if (!combinations.has(anchor)) combinations.set(anchor, new Map());
    const counts = combinations.get(anchor)!;
    const nk = names.join("\u0000");
    const prev = counts.get(nk);
    if (prev) prev.count += 1;
    else counts.set(nk, { names, count: 1 });
  }
  for (const [anchor, counts] of combinations) {
    result.get(anchor)!.duplicate_groups = [...counts.values()]
      .sort((a, b) => tupleCompare(a.names, b.names))
      .map((g) => ({ sources: g.names, count: g.count }));
  }
  return [...result.values()];
}

/** Сравнение кортежей строк Python. */
function tupleCompare(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = codeSort(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Их бюджеты города по VK: лид-формы и сообщения (с НДС). */
export function fbMarketingBudgets(
  data: Pick<FbMarketingData, "budgets">,
  city: string,
): Map<string, { community_messages: number; lead_forms: number }> {
  const budgets = new Map<string, { community_messages: number; lead_forms: number }>();
  for (const [name, spent, lf] of data.budgets) {
    if (city && name !== city) continue;
    const key = name ?? "";
    if (!budgets.has(key)) budgets.set(key, { community_messages: 0, lead_forms: 0 });
    const b = budgets.get(key)!;
    const total = (spent || 0) * VK_VAT;
    const forms = (lf || 0) * VK_VAT;
    b.lead_forms += forms;
    b.community_messages += Math.max(0, total - forms);
  }
  return budgets;
}

export type FbMarketingCells = {
  source: string;
  budget: string;
  leads: string;
  lead_price: string;
  booked: string;
  lead_booked: string;
  attended: string;
  booked_attended: string;
  paid: string;
  attended_paid: string;
  lead_paid: string;
  sale_price: string;
};

/** Их money маркетинга: «—» или f"{n:,.0f} ₽". */
export const fbMarketingMoney = (n: number | null) => (n === null ? "—" : `${fbWhole(n)} ₽`);
/** Их display_rate: «—» при нулевой базе, иначе f"{a / b:.0%}". */
export const fbMarketingRate = (a: number, b: number) => (!b ? "—" : fbPercent(a / b, 0));

const SOURCE_LABEL: Record<string, string> = {
  community_messages: "Вконтакте Сообщения",
  lead_forms: "Вконтакте ЛФ НК",
};
const DUPLICATE_LABEL: Record<string, string> = {
  "VK · сообщения": "ВКонтакте Сообщения",
  "VK · лид-формы": "ВКонтакте ЛФ НК",
};

type Counts = Pick<FbMarketingRow, "leads" | "booked" | "attended" | "paid">;

/** Их report_cells: строка канала или итога города. */
export function fbMarketingCells(
  source: string,
  budget: number | null,
  v: Counts,
  loaded: boolean,
): FbMarketingCells {
  if (!loaded) {
    return {
      source,
      budget: fbMarketingMoney(budget),
      leads: "—",
      lead_price: "—",
      booked: "—",
      lead_booked: "—",
      attended: "—",
      booked_attended: "—",
      paid: "—",
      attended_paid: "—",
      lead_paid: "—",
      sale_price: "—",
    };
  }
  return {
    source,
    budget: fbMarketingMoney(budget),
    leads: String(v.leads),
    lead_price: budget !== null && v.leads ? fbMarketingMoney(budget / v.leads) : "—",
    booked: String(v.booked),
    lead_booked: fbMarketingRate(v.booked, v.leads),
    attended: String(v.attended),
    booked_attended: fbMarketingRate(v.attended, v.booked),
    paid: String(v.paid),
    attended_paid: fbMarketingRate(v.paid, v.attended),
    lead_paid: fbMarketingRate(v.paid, v.leads),
    sale_price: budget !== null && v.paid ? fbMarketingMoney(budget / v.paid) : "—",
  };
}

export type FbMarketingCity = {
  city: string;
  partners: string;
  loaded: boolean;
  channels: FbMarketingCells[];
  total: FbMarketingCells;
  overview: { leads: string; booked: string; attended: string; paid: string };
  duplicates: { names: string; count: number }[];
  duplicateCount: number;
  syncedAt: number | null;
};

/** Их fitbase_report_page: карточки городов направления. */
export function fbMarketingCities(data: FbMarketingData, city: string): FbMarketingCity[] {
  const rows = fbMarketingRows(data, city);
  const budgets = fbMarketingBudgets(data, city);
  const brandConnections = data.connections.filter((c) => c.brand === data.brand);
  const names = [
    ...new Set([
      ...rows.map((r) => r.city),
      ...brandConnections.filter((c) => !city || c.city === city).map((c) => c.city),
    ]),
  ].sort(codeSort);
  return names.map((name) => {
    const channels = rows
      .filter((r) => r.city === name && r.leads > 0)
      .sort((a, b) => {
        const na = a.bucket === "none" ? 1 : 0;
        const nb = b.bucket === "none" ? 1 : 0;
        if (na !== nb) return na - nb;
        if (a.leads !== b.leads) return b.leads - a.leads;
        return codeSort(a.source, b.source);
      });
    const cityConnections = brandConnections.filter((c) => c.city === name);
    const loaded = cityConnections.some((c) => !!c.synced_at) || rows.some((r) => r.city === name);
    const total: Counts = { leads: 0, booked: 0, attended: 0, paid: 0 };
    for (const r of channels) {
      total.leads += r.leads;
      total.booked += r.booked;
      total.attended += r.attended;
      total.paid += r.paid;
    }
    let cityBudget = 0;
    let hasBudget = false;
    const cells = channels.map((r) => {
      const b = budgets.get(name);
      const budget =
        r.bucket !== "none" && b && (r.bucket === "community_messages" || r.bucket === "lead_forms")
          ? b[r.bucket]
          : null;
      if (budget !== null) {
        cityBudget += budget;
        hasBudget = true;
      }
      return fbMarketingCells(SOURCE_LABEL[r.bucket] ?? r.source, budget, r, loaded);
    });
    const combos = new Map<string, { names: string[]; count: number }>();
    for (const r of channels) {
      for (const g of r.duplicate_groups ?? []) {
        const names = g.sources.map((v) => DUPLICATE_LABEL[v] ?? v);
        const k = names.join("\u0000");
        const prev = combos.get(k);
        if (prev) prev.count += g.count;
        else combos.set(k, { names, count: g.count });
      }
    }
    const duplicates = [...combos.values()]
      .sort((a, b) => b.count - a.count || tupleCompare(a.names, b.names))
      .map((d) => ({ names: d.names.join(" / "), count: d.count }));
    const stamps = cityConnections.map((c) => c.synced_at).filter((v): v is number => !!v);
    const partners = [
      ...new Set(cityConnections.map((c) => (c.partner_name ?? "").trim()).filter(Boolean)),
    ]
      .sort(codeSort)
      .join(" · ");
    return {
      city: name,
      partners,
      loaded,
      channels: cells,
      total: fbMarketingCells("Итого по городу", hasBudget ? cityBudget : null, total, loaded),
      overview: {
        leads: loaded ? String(total.leads) : "—",
        booked: loaded ? String(total.booked) : "—",
        attended: loaded ? String(total.attended) : "—",
        paid: loaded ? String(total.paid) : "—",
      },
      duplicates,
      duplicateCount: duplicates.reduce((s, d) => s + d.count, 0),
      syncedAt: stamps.length ? Math.max(...stamps) : null,
    };
  });
}

/** Период отчётов «с» / «по» по умолчанию — с 1-го числа по сегодня (МСК). */
export function fbDefaultPeriod(today: string) {
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** Проверка периода их отчётов: начало не позже конца, не больше 366 дней. */
export function fbPeriodOk(from: string, to: string): boolean {
  try {
    fbIsoDate(from);
    fbIsoDate(to);
  } catch {
    return false;
  }
  return to >= from && fbDaysBetween(from, to) < 366;
}

export { fbAddDays };
