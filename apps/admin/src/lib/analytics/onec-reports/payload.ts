/**
 * Данные шести досок 1С — перенос их full_reports.py (боевой портал
 * аналитики, /1c): те же агрегаты за период и сравнения, те же поля и
 * порядок, что получали их HTML-доски. Агрегаты даёт база (RPC
 * an_onec_aggregate, их aggregate() с проверкой прав и городов партнёра),
 * здесь — только их сборка. Без React и запросов: зависимости передаются.
 *
 * Python → TS: sorted() строк — по кодам символов (pyCompare), сравнение
 * кортежей — pyCompareTuple, round() — банковское (pyRound), словари — в
 * порядке вставки (ключи не похожи на числа, порядок у объектов JS тот же).
 */
import { pyCompare, pyCompareTuple } from "../onec/rules";

export type OnecBoard = "revenue" | "sales" | "activities" | "funnel" | "zero" | "partner";
export type OnecDataReport =
  | "revenue"
  | "sales"
  | "activities"
  | "funnel"
  | "trial_products"
  | "zero";
export type OnecGrain = "detail" | "studio" | "monthly" | "daily" | "monthly_detail";

/** Строка их aggregate(): ключ разреза, позиция, суммы v1…v8. */
export type AggRow = {
  period: string;
  day: string;
  city: string;
  studio: string;
  status: string;
  dimension: string;
  code: string;
  v1: number;
  v2: number;
  v3: number;
  v4: number;
  v5: number;
  v6: number;
  v7: number;
  v8: number;
};

export type Aggregate = (
  report: OnecDataReport,
  start: string,
  end: string,
  grain?: OnecGrain,
) => Promise<AggRow[]>;

/** Сведения о снимке для доски (RPC an_onec_report_meta). */
export type OnecReportMeta = {
  generated_at: string;
  coverage: { min: string | null; max: string | null };
  breakEven: Record<string, number> | null;
  zeroControls: Record<string, number> | null;
  studioOptions: Record<string, string[]> | null;
};

export type OnecParams = { start?: string; end?: string; studio?: string; city?: string };

export const BOARD_NAMES: Record<OnecBoard, string> = {
  revenue: "Выручка",
  sales: "Продажи абонементов",
  activities: "Занятия",
  funnel: "Воронка пробных",
  zero: "Нулевая номенклатура",
  partner: "Мой город",
};

const MONTHS = [
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

// --- Даты (их datetime) ------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const iso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const parts = (day: string) => [+day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10)];
export const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Дата ГГГГ-ММ-ДД со сдвигом в днях. */
export function addDaysIso(day: string, days: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Дни между датами (их (b - a).days). */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Их shift: та же дата N месяцев спустя, день — не дальше конца месяца. */
export function shift(day: string, months: number): string {
  const [y, m, d] = parts(day);
  const index = y * 12 + m - 1 + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return iso(year, month, Math.min(d, monthDays(year, month)));
}

/** «Октябрь 2026». */
export const label = (period: string) => `${MONTHS[+period.slice(5, 7) - 1]} ${period.slice(0, 4)}`;

/** Месяцы от конца к началу: ['2026-10', '2026-09', …]. */
export function periodList(start: string, end: string): string[] {
  let cursor = end.slice(0, 7) + "-01";
  const first = start.slice(0, 7) + "-01";
  const out: string[] = [];
  while (cursor >= first) {
    out.push(cursor.slice(0, 7));
    cursor = shift(cursor, -1);
  }
  return out;
}

/** Понедельник = 0 (их date.weekday()). */
const weekday = (day: string) => {
  const [y, m, d] = parts(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
};

const isValidDay = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = parts(day);
  return m >= 1 && m <= 12 && d >= 1 && d <= monthDays(y, m);
};

/** Дата и время по Москве в их формате strftime. */
function mskFormat(isoTime: string, pattern: "%d.%m.%Y %H:%M" | "%Y-%m-%d %H:%M"): string {
  const t = new Date(new Date(isoTime).getTime() + 3 * 3_600_000);
  const [Y, mo, d, H, M] = [
    pad(t.getUTCFullYear(), 4),
    pad(t.getUTCMonth() + 1),
    pad(t.getUTCDate()),
    pad(t.getUTCHours()),
    pad(t.getUTCMinutes()),
  ];
  return pattern === "%d.%m.%Y %H:%M" ? `${d}.${mo}.${Y} ${H}:${M}` : `${Y}-${mo}-${d} ${H}:${M}`;
}

/** Сегодня и вчера по Москве (их default: min(покрытие, вчера МСК)). */
export function mskToday(now = Date.now()): string {
  const t = new Date(now + 3 * 3_600_000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Их round(x, n): округление до ближайшего, ровно посередине — к чётному. */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const fixed = Number(x.toFixed(digits));
  // Проверка «ровно посередине» по точному значению двоичного числа.
  const scale = 10 ** digits;
  const lower = Math.floor(x * scale);
  const mid = (lower + 0.5) / scale;
  if (x !== mid || !exactlyMidpoint(x, digits)) return fixed;
  return (lower % 2 === 0 ? lower : lower + 1) / scale;
}

/** Точное значение x — ровно середина между двумя числами с digits знаками. */
function exactlyMidpoint(x: number, digits: number): boolean {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const bits = buf.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn;
  if (exp === 0) return false;
  mant |= 1n << 52n;
  const e = exp - 1075; // x = mant * 2^e
  // x * 10^digits * 2 должно быть нечётным целым.
  let num = mant * 10n ** BigInt(digits) * 2n;
  if (e >= 0) num <<= BigInt(e);
  else {
    const den = 1n << BigInt(-e);
    if (num % den !== 0n) return false;
    num /= den;
  }
  return num % 2n === 1n;
}

// --- Общее -------------------------------------------------------------------------

const sortStrings = (values: Iterable<string>) => [...new Set(values)].sort(pyCompare);
const sum = (values: Iterable<number>) => {
  let s = 0;
  for (const v of values) s += v;
  return s;
};
const v = (r: AggRow, n: number) => r[`v${n}` as "v1"] as number;

export type BaseMeta = {
  generatedAt: string;
  sourceFile: string;
  start: string;
  end: string;
  currentPeriod: string;
  minDate: string;
  maxDate: string;
  periods: { key: string; label: string }[];
};

export class OnecReportError extends Error {}

/** Их base_meta: период по умолчанию — с 1-го по вчера (МСК), не позже данных. */
export function baseMeta(meta: OnecReportMeta, params: OnecParams, now = Date.now()): BaseMeta {
  const yesterday = addDaysIso(mskToday(now), -1);
  const covMax = meta.coverage.max || mskToday(now);
  const fallback = covMax < yesterday ? covMax : yesterday;
  const end = params.end || fallback;
  const start = params.start || end.slice(0, 7) + "-01";
  for (const day of [start, end]) {
    if (!isValidDay(day)) throw new OnecReportError("Неверная дата");
  }
  if (start > end) throw new OnecReportError("Начало периода позже конца");
  const minDate = meta.coverage.min || start;
  const maxDate = meta.coverage.max || end;
  return {
    generatedAt: mskFormat(meta.generated_at, "%d.%m.%Y %H:%M"),
    sourceFile: "Сводные 1С · база портала",
    start,
    end,
    currentPeriod: start.slice(0, 7),
    minDate,
    maxDate,
    periods: periodList(minDate, maxDate).map((p) => ({ key: p, label: label(p) })),
  };
}

/** Их indexed_payload: справочники городов, студий, направлений и индексы. */
function indexedPayload(rows: AggRow[]) {
  const cities = sortStrings(rows.map((r) => r.city));
  const studios = sortStrings(rows.map((r) => r.studio));
  const directions = sortStrings(rows.map((r) => r.dimension));
  const status = new Map<string, string>();
  for (const r of rows) status.set(r.studio, r.status);
  const index = (values: string[]) => new Map(values.map((x, n) => [x, n]));
  return {
    lists: { cities, studios, directions, studioStatuses: studios.map((s) => status.get(s)!) },
    city: index(cities),
    studio: index(studios),
    dimension: index(directions),
  };
}

// --- Доски ---------------------------------------------------------------------------

export type SalesRecord = {
  date: string;
  period: string;
  city: string;
  studio: string;
  product: string;
  sales: number;
  newSales: number;
  repeatSales: number;
  newPayments: number;
  repeatPayments: number;
  salesAmount: number;
};
export type SalesPayload = BaseMeta & {
  records: SalesRecord[];
  cities: string[];
  studios: string[];
  /** [ГГГГ-ММ-01 сравнения, индекс города, индекс студии, сумма продаж]. */
  dailyRecords: [string, number, number, number][];
  periodLastDays: Record<string, number>;
  /** Период → [31, город, студия, v1…v6] за интервал. */
  dailyMetrics: Record<
    string,
    [number, string, string, number, number, number, number, number, number][]
  >;
};

export type ActivitiesPayload = BaseMeta & {
  previousPeriod: {
    start: string;
    end: string;
    records: {
      city: string;
      studio: string;
      status: string;
      direction: string;
      held: number;
      scheduled: number;
      attended: number;
    }[];
  };
  cities: string[];
  studios: string[];
  directions: string[];
  studioStatuses: string[];
  /** [дата начала, период, город, студия, направление, проведено, записей, посещений]. */
  records: [string, string, number, number, number, number, number, number][];
};

export type FunnelPayload = BaseMeta & {
  cities: string[];
  studios: string[];
  directions: string[];
  studioStatuses: string[];
  /** [начало, период, город, студия, направление, v1…v8]. */
  records: (string | number)[][];
};

export type ZeroPayload = BaseMeta & {
  records: {
    period: string;
    city: string;
    studio: string;
    code: string;
    product: string;
    sales: number;
  }[];
  blankCostRows?: number;
  explicitZeroRows?: number;
  excludedTrialRows: number;
};

export type RevenueRow = {
  name: string;
  type: "network" | "city" | "studio";
  group: string;
  current: number;
  forecast: number | null;
  breakEven: number | null;
  breakEvenDelta: number | null;
  months: Record<string, number>;
  buckets: Record<string, number>;
  status?: string;
};
export type RevenuePayload = BaseMeta & {
  currentMonth: string;
  currentDays: number;
  monthDays: number;
  monthHeaders: { key: string; label: string }[];
  bucketHeaders: string[];
  networkRows: RevenueRow[];
  rows: RevenueRow[];
  studios: Record<string, RevenueRow[]>;
  summary: {
    totalCurrent: number;
    totalForecast: number | null;
    openCurrent: number;
    closedCurrent: number;
    cities: number;
    studios: number;
    openStudios: number;
  };
};

export type PartnerPayload = Omit<BaseMeta, "periods"> & {
  studioOptions: Record<string, string[]>;
  selectedStudio: string;
  selectedCity: string;
  /** Их partner_payload заменяет periods: месяцы истории, от текущего назад. */
  periods: string[];
  cities: string[];
  /** [период, город, студия, выручка, 6 продаж, 3 занятий, 5 воронки]. */
  records: (string | number)[][];
  previousRecords: Record<string, string | number>[];
  /** [период, город, номенклатура, продажи, сумма, новые, оплаты новых, повторные, оплаты продлений]. */
  productRecords: (string | number)[][];
  /** [период, город, вид пробного, записались, пришли, купили в день, за 14 дней]. */
  trialProductRecords: (string | number)[][];
  /** [период, город, направление, проведено, записей, посещений]. */
  directionRecords: (string | number)[][];
  breakEven: Record<string, number>;
};

export type OnecPayload =
  | RevenuePayload
  | SalesPayload
  | ActivitiesPayload
  | FunnelPayload
  | ZeroPayload
  | PartnerPayload;

const SALES_FIELDS = [
  "sales",
  "newSales",
  "repeatSales",
  "newPayments",
  "repeatPayments",
  "salesAmount",
] as const;
const salesValues = (r: AggRow) =>
  Object.fromEntries(SALES_FIELDS.map((f, i) => [f, v(r, i + 1)])) as Record<
    (typeof SALES_FIELDS)[number],
    number
  >;

/** Их payload(): данные доски за период. */
export async function onecPayload(
  board: OnecBoard,
  params: OnecParams,
  meta: OnecReportMeta,
  aggregate: Aggregate,
  now = Date.now(),
): Promise<OnecPayload> {
  const base = baseMeta(meta, params, now);
  if (board === "revenue") return revenuePayload(meta, base, aggregate);
  if (board === "partner") return partnerPayload(meta, base, aggregate, params);
  const { start, end, currentPeriod: period } = base;

  if (board === "sales") {
    const rows = await aggregate("sales", start, end);
    const records: SalesRecord[] = rows.map((r) => ({
      date: start,
      period,
      city: r.city,
      studio: r.studio,
      product: r.dimension,
      ...salesValues(r),
    }));
    const [monthly, prevMonth, prevYear, currentStudios] = await Promise.all([
      aggregate("sales", shift(period + "-01", -8), period + "-01", "monthly"),
      aggregate("sales", shift(start, -1), shift(end, -1), "studio"),
      aggregate("sales", shift(start, -12), shift(end, -12), "studio"),
      aggregate("sales", start, end, "studio"),
    ]);
    for (const r of monthly) {
      if (r.period === period) continue;
      records.push({
        date: r.period + "-01",
        period: r.period,
        city: r.city,
        studio: r.studio,
        product: "",
        ...salesValues(r),
      });
    }
    const comparisons: [string, AggRow][] = [];
    for (const [offset, list] of [
      [-1, prevMonth],
      [-12, prevYear],
    ] as const) {
      const tag = shift(start.slice(0, 7) + "-01", offset).slice(0, 7);
      for (const r of list) comparisons.push([tag, r]);
    }
    const all = [...rows, ...comparisons.map(([, r]) => r)];
    const cities = sortStrings(all.map((r) => r.city));
    const studios = sortStrings(all.map((r) => r.studio));
    const ci = new Map(cities.map((x, n) => [x, n]));
    const si = new Map(studios.map((x, n) => [x, n]));
    const metric = (r: AggRow) =>
      [
        31,
        r.city,
        r.studio,
        v(r, 1),
        v(r, 2),
        v(r, 3),
        v(r, 4),
        v(r, 5),
        v(r, 6),
      ] as SalesPayload["dailyMetrics"][string][number];
    const dailyMetrics: SalesPayload["dailyMetrics"] = { [period]: currentStudios.map(metric) };
    for (const [tag, r] of comparisons) (dailyMetrics[tag] ??= []).push(metric(r));
    return {
      ...base,
      records,
      cities,
      studios,
      dailyRecords: comparisons.map(([tag, r]) => [
        tag + "-01",
        ci.get(r.city)!,
        si.get(r.studio)!,
        r.v6,
      ]),
      periodLastDays: { [period]: 31 },
      dailyMetrics,
    };
  }

  if (board === "activities") {
    const duration = daysBetween(start, end) + 1;
    const precedingEnd = addDaysIso(start, -1);
    const precedingStart = addDaysIso(precedingEnd, -(duration - 1));
    const [rows, preceding, prevMonth, prevYear] = await Promise.all([
      aggregate("activities", start, end),
      aggregate("activities", precedingStart, precedingEnd),
      aggregate("activities", shift(start, -1), shift(end, -1)),
      aggregate("activities", shift(start, -12), shift(end, -12)),
    ]);
    const tagged: [string, string, AggRow][] = rows.map((r) => [start, period, r]);
    for (const [offset, list] of [
      [-1, prevMonth],
      [-12, prevYear],
    ] as const) {
      const tag = shift(start.slice(0, 7) + "-01", offset).slice(0, 7);
      for (const r of list) tagged.push([shift(start, offset), tag, r]);
    }
    const idx = indexedPayload(tagged.map(([, , r]) => r));
    return {
      ...base,
      previousPeriod: {
        start: precedingStart,
        end: precedingEnd,
        records: preceding.map((r) => ({
          city: r.city,
          studio: r.studio,
          status: r.status,
          direction: r.dimension,
          held: r.v1,
          scheduled: r.v2,
          attended: r.v3,
        })),
      },
      ...idx.lists,
      records: tagged.map(([date, tag, r]) => [
        date,
        tag,
        idx.city.get(r.city)!,
        idx.studio.get(r.studio)!,
        idx.dimension.get(r.dimension)!,
        r.v1,
        r.v2,
        r.v3,
      ]),
    };
  }

  if (board === "funnel") {
    const rows = await aggregate("funnel", start, end);
    const idx = indexedPayload(rows);
    return {
      ...base,
      ...idx.lists,
      records: rows.map((r) => [
        start,
        period,
        idx.city.get(r.city)!,
        idx.studio.get(r.studio)!,
        idx.dimension.get(r.dimension)!,
        r.v1,
        r.v2,
        r.v3,
        r.v4,
        r.v5,
        r.v6,
        r.v7,
        r.v8,
      ]),
    };
  }

  // zero
  const rows = await aggregate("zero", start, end);
  return {
    ...base,
    records: rows.map((r) => ({
      period,
      city: r.city,
      studio: r.studio,
      code: r.code,
      product: r.dimension,
      sales: r.v1,
    })),
    ...(meta.zeroControls ?? {}),
    excludedTrialRows: meta.zeroControls?.excludedTrialRows ?? 0,
  };
}

/** Их revenue_payload. */
async function revenuePayload(
  meta: OnecReportMeta,
  base0: BaseMeta,
  aggregate: Aggregate,
): Promise<RevenuePayload> {
  const base = { ...base0, generatedAt: mskFormat(meta.generated_at, "%Y-%m-%d %H:%M") };
  const { start, end, currentPeriod: period } = base;
  const [current, history, daily] = await Promise.all([
    aggregate("revenue", start, end, "studio"),
    aggregate("revenue", base.minDate, end, "monthly"),
    aggregate("revenue", start, end, "daily"),
  ]);
  const periods = periodList(base.minDate, end);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  // Календарные недели (пн–вс), обрезанные по выбранному интервалу.
  const buckets: [string, string, string][] = [];
  let cursor = start;
  let last = end;
  if (sameMonth && start.endsWith("-01")) {
    const [y, m] = parts(end);
    last = iso(y, m, monthDays(y, m));
  }
  while (cursor <= last) {
    const weekEnd = addDaysIso(cursor, 6 - weekday(cursor));
    const finish = weekEnd < last ? weekEnd : last;
    const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const title = sameMonth
      ? `${+cursor.slice(8, 10)}-${+finish.slice(8, 10)}`
      : `${dm(cursor)}–${dm(finish)}`;
    buckets.push([title, cursor, finish]);
    cursor = addDaysIso(finish, 1);
  }

  type Key = [string, string, string];
  const keyOf = (r: AggRow): Key => [r.city, r.studio, r.status];
  const ks = (k: Key) => k.join("\u0001");
  const keyMap = new Map<string, Key>();
  const monthly = new Map<string, Map<string, number>>();
  const weeks = new Map<string, Map<string, number>>();
  const actual = new Map<string, number>();
  for (const r of history) {
    const k = keyOf(r);
    keyMap.set(ks(k), k);
    let m = monthly.get(ks(k));
    if (!m) monthly.set(ks(k), (m = new Map()));
    m.set(r.period, r.v3);
  }
  for (const r of current) {
    const k = keyOf(r);
    keyMap.set(ks(k), k);
    actual.set(ks(k), r.v3);
  }
  for (const r of daily) {
    for (const [title, first, lastDay] of buckets) {
      if (first <= r.day && r.day <= lastDay) {
        const k = ks(keyOf(r));
        let w = weeks.get(k);
        if (!w) weeks.set(k, (w = new Map()));
        w.set(title, (w.get(title) ?? 0) + r.v3);
        break;
      }
    }
  }
  const [ey, em] = parts(end);
  const days = monthDays(ey, em);
  const monthlySelection = sameMonth && start.endsWith("-01");
  const breakEven = meta.breakEven ?? {};

  const row = (
    name: string,
    kind: RevenueRow["type"],
    group: string,
    keys: Key[],
    status?: string,
  ): RevenueRow => {
    const value = sum(keys.map((k) => actual.get(ks(k)) ?? 0));
    const result: RevenueRow = {
      name,
      type: kind,
      group,
      current: value,
      forecast: monthlySelection ? pyRound((value / +end.slice(8)) * days, 2) : null,
      breakEven: null,
      breakEvenDelta: null,
      months: Object.fromEntries(
        periods.map((p) => [p, sum(keys.map((k) => monthly.get(ks(k))?.get(p) ?? 0))]),
      ),
      buckets: Object.fromEntries(
        buckets.map(([title]) => [title, sum(keys.map((k) => weeks.get(ks(k))?.get(title) ?? 0))]),
      ),
    };
    if (status !== undefined) result.status = status;
    if (kind === "city" && sameMonth) {
      result.breakEven = breakEven[name] ?? null;
      if (result.breakEven !== null) result.breakEvenDelta = value - result.breakEven;
    }
    return result;
  };

  const keys = [...keyMap.values()].sort(pyCompareTuple);
  const hasOpen = (name: string) => keys.some((k) => k[0] === name && k[2] === "Открыта");
  const names = sortStrings(keys.map((k) => k[0])).sort(
    (a, b) => Number(!hasOpen(a)) - Number(!hasOpen(b)) || pyCompare(a, b),
  );
  const networkRows = (
    [
      ["Итого по сети", "Все"],
      ["Итого открытые", "Открыта"],
      ["Итого закрытые", "Закрыта"],
    ] as const
  ).map(([title, status]) =>
    row(
      title,
      "network",
      "Итого",
      keys.filter((k) => status === "Все" || k[2] === status),
      status,
    ),
  );
  const studios: Record<string, RevenueRow[]> = {};
  for (const name of names) {
    studios[name] = keys
      .filter((k) => k[0] === name)
      .sort(
        (a, b) => Number(a[2] !== "Открыта") - Number(b[2] !== "Открыта") || pyCompare(a[1], b[1]),
      )
      .map((k) => row(k[1], "studio", name, [k], k[2]));
  }
  const actualEntries = [...actual.entries()].map(([k, value]) => ({ key: keyMap.get(k)!, value }));
  return {
    ...base,
    currentMonth: sameMonth ? label(period) : `${start} — ${end}`,
    currentDays: daysBetween(start, end) + 1,
    monthDays: days,
    maxDate: end,
    monthHeaders: periods.map((p) => ({ key: p, label: label(p) })),
    bucketHeaders: buckets.map((b) => b[0]),
    networkRows,
    rows: names.map((name) =>
      row(
        name,
        "city",
        name,
        keys.filter((k) => k[0] === name),
      ),
    ),
    studios,
    summary: {
      totalCurrent: sum(actualEntries.map((e) => e.value)),
      totalForecast: networkRows[0].forecast,
      openCurrent: sum(actualEntries.filter((e) => e.key[2] === "Открыта").map((e) => e.value)),
      closedCurrent: sum(actualEntries.filter((e) => e.key[2] === "Закрыта").map((e) => e.value)),
      cities: names.length,
      studios: new Set(keys.map((k) => k[1])).size,
      openStudios: new Set(keys.filter((k) => k[2] === "Открыта").map((k) => k[1])).size,
    },
  };
}

const PREVIOUS_FIELDS = [
  "city",
  "studio",
  "revenue",
  "sales",
  "new_sales",
  "repeat_sales",
  "new_payments",
  "repeat_payments",
  "sales_amount",
  "classes",
  "booked",
  "attended",
  "trials",
  "trial_attended",
  "bought_day",
  "bought_14",
  "bought_later",
];

/** Их partner_payload («Мой город»; студия — фильтр выбранного города). */
async function partnerPayload(
  meta: OnecReportMeta,
  base: BaseMeta,
  aggregate: Aggregate,
  params: OnecParams,
): Promise<PartnerPayload> {
  const selectedStudio = params.studio ?? "";
  const selectedCity = params.city ?? "";
  const studioOptions = meta.studioOptions ?? {};
  if (selectedStudio && !(studioOptions[selectedCity] ?? []).includes(selectedStudio)) {
    throw new OnecReportError("Выбранная студия недоступна в этом городе");
  }
  const { start, end, currentPeriod: period } = base;
  const historyStart = shift(period + "-01", -5);

  type Acc = Map<string, { key: string[]; values: number[] }>;
  const acc = (m: Acc, key: string[], size: number) => {
    const k = key.join("\u0001");
    let e = m.get(k);
    if (!e) m.set(k, (e = { key, values: new Array(size).fill(0) }));
    return e.values;
  };
  const data: Acc = new Map();
  const previous: Acc = new Map();
  const products: Acc = new Map();
  const trialProducts: Acc = new Map();
  const directions: Acc = new Map();

  const layouts: [OnecDataReport, [number, number][]][] = [
    ["revenue", [[0, 3]]],
    ["sales", [0, 1, 2, 3, 4, 5].map((n) => [n + 1, n + 1] as [number, number])],
    ["activities", [0, 1, 2].map((n) => [n + 7, n + 1] as [number, number])],
    [
      "funnel",
      [
        [10, 1],
        [11, 2],
        [12, 4],
        [13, 6],
        [14, 7],
      ],
    ],
  ];
  const fetched = await Promise.all(
    layouts.map(([report]) =>
      Promise.all([
        aggregate(report, start, end, "studio"),
        aggregate(report, historyStart, period + "-01", "monthly"),
        aggregate(report, shift(start, -1), shift(end, -1), "studio"),
      ]),
    ),
  );
  layouts.forEach(([, mapping], i) => {
    const [selected, history, prev] = fetched[i];
    for (const r of selected) {
      const values = acc(data, [period, r.city, r.studio], 15);
      for (const [dest, src] of mapping) values[dest] += v(r, src);
    }
    for (const r of history) {
      if (r.period === period) continue;
      const values = acc(data, [r.period, r.city, r.studio], 15);
      for (const [dest, src] of mapping) values[dest] += v(r, src);
    }
    for (const r of prev) {
      const values = acc(previous, [r.city, r.studio], 15);
      for (const [dest, src] of mapping) values[dest] += v(r, src);
    }
  });
  const [salesHistory, salesNow, trialsNow, activitiesNow] = await Promise.all([
    aggregate("sales", historyStart, end, "monthly_detail"),
    aggregate("sales", start, end),
    aggregate("trial_products", start, end),
    aggregate("activities", start, end),
  ]);
  const productOrder = [1, 6, 2, 4, 3, 5];
  for (const r of salesHistory) {
    if (r.period === period || r.period > period) continue;
    const values = acc(products, [r.period, r.city, r.dimension], 6);
    productOrder.forEach((src, n) => (values[n] += v(r, src)));
  }
  for (const r of salesNow) {
    const values = acc(products, [period, r.city, r.dimension], 6);
    productOrder.forEach((src, n) => (values[n] += v(r, src)));
  }
  for (const r of trialsNow) {
    const values = acc(trialProducts, [period, r.city, r.dimension], 4);
    for (let n = 0; n < 4; n++) values[n] += v(r, n + 1);
  }
  for (const r of activitiesNow) {
    const values = acc(directions, [period, r.city, r.dimension], 3);
    for (let n = 0; n < 3; n++) values[n] += v(r, n + 1);
  }
  const sorted = (m: Acc) =>
    [...m.values()]
      .sort((a, b) => pyCompareTuple(a.key, b.key))
      .map((e) => [...e.key, ...e.values]);
  const names = new Set([...data.values()].map((e) => e.key[1]));
  const breakEven: Record<string, number> = {};
  if (start.slice(0, 7) === end.slice(0, 7) && !selectedStudio) {
    for (const [city, value] of Object.entries(meta.breakEven ?? {})) {
      if (names.has(city)) breakEven[city] = value;
    }
  }
  return {
    ...base,
    studioOptions,
    selectedStudio,
    selectedCity,
    periods: periodList(historyStart, period + "-01"),
    cities: Object.keys(studioOptions).sort(pyCompare),
    records: sorted(data),
    previousRecords: [...previous.values()].map((e) =>
      Object.fromEntries(PREVIOUS_FIELDS.map((f, n) => [f, [...e.key, ...e.values][n]])),
    ),
    productRecords: sorted(products),
    trialProductRecords: sorted(trialProducts),
    directionRecords: sorted(directions),
    breakEven,
  };
}

/** Строки RPC an_onec_aggregate → AggRow. */
export function parseAggregate(
  grain: OnecGrain,
  rows: [string | null, string, string, string, string | null, string | null, ...number[]][],
): AggRow[] {
  return rows.map((r) => ({
    period: grain === "monthly" || grain === "monthly_detail" ? (r[0] ?? "") : "",
    day: grain === "daily" ? (r[0] ?? "") : "",
    city: r[1],
    studio: r[2],
    status: r[3],
    dimension: r[4] ?? "",
    code: r[5] ?? "",
    v1: r[6] ?? 0,
    v2: r[7] ?? 0,
    v3: r[8] ?? 0,
    v4: r[9] ?? 0,
    v5: r[10] ?? 0,
    v6: r[11] ?? 0,
    v7: r[12] ?? 0,
    v8: r[13] ?? 0,
  }));
}
