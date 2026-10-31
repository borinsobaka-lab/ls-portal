/**
 * «Мой город · FitBase» — их fitbase_partner.py (build, revenue, filters) и
 * fitbase_partner_view.py (payload, product_segments, trial_dimensions,
 * правки шаблона доски партнёра 1С): доска «Мой город» 1С на фактах FitBase
 * только выбранных студий. Без React: данные — RPC an_fb_mycity_data,
 * расчёты отчётов — те же, что у сетевых отчётов FitBase (продажи,
 * посещаемость, воронка), вид — доска «Мой город» (components/analytics/fitbase/
 * mycity-board.tsx).
 *
 * Их особенности сохранены: прочерк вместо нуля там, где данных нет (их
 * правки fmt / rub / pct / sum шаблона), итоги доски — их totals, а не сумма
 * строк; конверсии — из воронки FitBase; точка 0 — только для всего города.
 */
import { PARTNER_FIELDS, type PartnerField } from "../onec-reports/mycity";
import {
  fbAttendanceReport,
  fbAttGroup,
  type FbAttendanceData,
  type FbAttendanceReport,
  type FbAttMetrics,
  type FbAttAvailability,
} from "./attendance";
import { fbSalesReport, fbTimestamp, type FbReportConnection, type FbSalesReport } from "./reports";
import { FB_REVENUE_TZ, fbDay, fbShiftMonths } from "./rules";
import {
  fbTrialAggregate,
  fbTrialCalculateByLabel,
  fbTrialsReport,
  type FbTrialBucket,
  type FbTrialRecord,
  type FbTrialsData,
} from "./trials";

export type FbMyCityConnection = FbReportConnection & {
  sales_synced_at: number | null;
  attendance_synced_at: number | null;
};

export type FbMyCityData = {
  now: number;
  admin: boolean;
  start: string;
  end: string;
  city: string;
  studio: string;
  cities: string[];
  /** [id студии, «название · направление»] — студии города. */
  options: [string, string][];
  /** Точка 0 города, копейки (только когда выбраны все студии города). */
  target: number | null;
  connections: FbMyCityConnection[];
  /** [студия, день, копейки] — выручка по дням. */
  daily: [number, string, number][];
  sales: [number, string, string, number, number, number][];
  history: [number, string, string, number, number][];
  payments: [number, string, string, string, string, number, string, number][];
  /** [студия, договор, название абонемента] */
  contract_labels: [number, string, string][];
  attendance: FbAttendanceData;
  trials: FbTrialsData;
  /** [студия, запись, название пробного] — пробные записи с названием. */
  trial_labels: [number, string, string][];
  /** [студия, название] — пары по всем записям студий. */
  label_keys: [number, string][];
  /** Записи периода с неопределённым типом. */
  unknown: number;
};

// --- Выручка (их revenue) -----------------------------------------------------------

export type FbMyCityRevenue = {
  total: number | null;
  forecast: number | null;
  known: number;
  expected: number;
  missing: string[];
  amounts: Map<number, number>;
  cutoff: string;
  complete: boolean;
};

const DAY_MS = 86400000;
const shiftDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysInMonth = (day: string) =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/**
 * Их revenue: те же копейки по дням и владельцы пар «домен + клуб», что у
 * revenue_report; граница — вчера по Самаре; прогноз месяца — только для
 * текущего месяца с первого числа по вчера.
 */
export function fbMyCityRevenue(
  rows: FbMyCityConnection[],
  daily: [number, string, number][],
  start: string,
  end: string,
  now: number,
): FbMyCityRevenue {
  const today = fbDay(now, FB_REVENUE_TZ);
  const yesterday = shiftDays(today, -1);
  const lo = start;
  const hi = end < yesterday ? end : yesterday;
  const owners = new Map<string, FbMyCityConnection>();
  for (const c of rows) {
    const key = `${c.domain}\u0000${c.club_id}`;
    const old = owners.get(key);
    if (
      !old ||
      (c.revenue_synced_at || 0) > (old.revenue_synced_at || 0) ||
      ((c.revenue_synced_at || 0) === (old.revenue_synced_at || 0) && c.id > old.id)
    )
      owners.set(key, c);
  }
  const amounts = new Map<number, number>();
  const missing: string[] = [];
  for (const c of owners.values()) {
    const ready =
      hi >= lo &&
      !!c.revenue_synced_at &&
      (c.revenue_from ?? "") <= start &&
      (c.revenue_to ?? "") >= hi;
    if (ready) {
      let sum = 0;
      for (const [id, day, cents] of daily)
        if (id === c.id && day >= start && day <= hi) sum += cents;
      amounts.set(c.id, sum);
    } else missing.push(c.name);
  }
  const total = amounts.size ? [...amounts.values()].reduce((s, v) => s + v, 0) : null;
  const elapsed =
    Math.round((Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / DAY_MS) + 1;
  const forecast =
    total !== null &&
    lo.slice(8) === "01" &&
    lo.slice(0, 7) === today.slice(0, 7) &&
    hi === yesterday &&
    elapsed > 0
      ? (total / elapsed) * daysInMonth(lo)
      : null;
  return {
    total,
    forecast,
    known: amounts.size,
    expected: owners.size,
    missing,
    amounts,
    cutoff: hi,
    complete: owners.size > 0 && !missing.length,
  };
}

// --- Сборка отчёта (их build) -------------------------------------------------------

const ATT_KEYS = [
  "lessons",
  "registered",
  "visited",
  "avg_registered",
  "avg_visited",
  "attendance",
] as const;
export type FbMyCityAttendance = Record<(typeof ATT_KEYS)[number], number | null>;

/** Их attendance_values: значение показателя — только при полном покрытии. */
function attendanceValues(
  values: FbAttMetrics | undefined,
  coverage: FbAttAvailability | undefined,
): FbMyCityAttendance {
  return Object.fromEntries(
    ATT_KEYS.map((k) => [k, values && coverage?.[k] ? values[k] : null]),
  ) as FbMyCityAttendance;
}

export type FbMyCityStudio = {
  id: number;
  name: string;
  brand: string;
  revenue: number | null;
  sales: number | null;
  attendance: FbMyCityAttendance;
  funnel: FbTrialBucket | null;
};

export type FbMyCityDirection = {
  lessons: number | null;
  registered: number | null;
  visited: number | null;
  attendance: number | null;
};

export type FbMyCityBuild = {
  revenue: FbMyCityRevenue;
  sales: FbSalesReport;
  attendanceReport: FbAttendanceReport;
  attendance: FbMyCityAttendance;
  funnel: FbTrialBucket;
  unknown: number;
  studios: FbMyCityStudio[];
  directions: Map<string, FbMyCityDirection>;
  updated: Record<"Выручка" | "Продажи" | "Посещаемость", number>;
};

/** Их build: выручка, продажи, посещаемость, воронка и строки студий выбранных студий. */
export function fbMyCityBuild(data: FbMyCityData): FbMyCityBuild {
  const rows = data.connections;
  const { start, end, now } = data;
  const sales = fbSalesReport(
    { connections: rows, sales: data.sales, history: data.history, payments: data.payments },
    { start, end, brand: "", city: "", studio: "", search: "" },
  );
  const attendance = fbAttendanceReport(data.attendance);
  const funnel = fbTrialsReport(data.trials);
  const cash = fbMyCityRevenue(rows, data.daily, start, end, now);
  const salesStudios = new Map(sales.studios.map(([k, v]) => [k.join("\u0000"), v]));
  const studios = rows.map((c): FbMyCityStudio => {
    const g = fbAttGroup(attendance, [c.city, c.id, null]);
    const s = salesStudios.get([c.city, c.id, c.name].join("\u0000"));
    const f = funnel.studios.get(c.id);
    return {
      id: c.id,
      name: c.name,
      brand: c.brand,
      revenue: cash.amounts.get(c.id) ?? null,
      sales: c.sales_synced_at ? (s?.count ?? 0) : null,
      attendance: attendanceValues(g?.metrics.current, g?.coverage.current),
      funnel: f ? fbTrialAggregate([f]) : null,
    };
  });
  const directions = new Map<string, FbMyCityDirection>();
  for (const g of attendance.groups.values()) {
    const training = g.key[2];
    if (training === null) continue;
    const cov = g.coverage.current;
    if (!directions.has(training))
      directions.set(training, { lessons: 0, registered: 0, visited: 0, attendance: null });
    const r = directions.get(training)!;
    for (const key of ["lessons", "registered", "visited"] as const) {
      const value = cov[key] ? g.metrics.current[key] : null;
      r[key] = r[key] !== null && value !== null ? r[key]! + value : null;
    }
  }
  for (const r of directions.values()) {
    r.attendance = r.visited !== null && r.registered ? (r.visited / r.registered) * 100 : null;
  }
  const minStamp = (field: "revenue_synced_at" | "sales_payments_at" | "attendance_synced_at") =>
    rows.length ? Math.min(...rows.map((c) => c[field] || 0)) : 0;
  return {
    revenue: cash,
    sales,
    attendanceReport: attendance,
    attendance: attendanceValues(attendance.total.current, attendance.metricCoverage.current),
    funnel: funnel.total,
    unknown: data.unknown,
    studios,
    directions,
    updated: {
      Выручка: minStamp("revenue_synced_at"),
      Продажи: minStamp("sales_payments_at"),
      Посещаемость: minStamp("attendance_synced_at"),
    },
  };
}

// --- «Что покупают» (их product_segments) -------------------------------------------

export type FbMyCityProduct = [
  string,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

const codeCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Их product_segments: продажи периода по названию абонемента (по дате
 * покупки МСК) и оплаты периода (без возвратов), все / новые / продления;
 * новая — первая платная покупка клиента в клубе, как в продажах.
 */
export function fbMyCityProducts(data: FbMyCityData, sales: FbSalesReport): FbMyCityProduct[] {
  const ids = new Set(sales.connections.map((c) => c.id));
  if (!ids.size) return [];
  const labels = new Map(
    data.contract_labels
      .filter(([uid]) => ids.has(uid))
      .map(([uid, id, label]) => [`${uid}\u0000${id}`, label]),
  );
  type Row = {
    connection_id: number;
    contract_id: string;
    client_id: string;
    purchased_at: number;
    price_cents: number;
  };
  const all = new Map<string, Row>();
  const put = (r: Row) => all.set(`${r.connection_id}\u0000${r.contract_id}`, r);
  for (const [conn, contract, client, at, price] of data.sales)
    if (ids.has(conn))
      put({
        connection_id: conn,
        contract_id: contract,
        client_id: client,
        purchased_at: at,
        price_cents: price,
      });
  for (const [conn, contract, client, at, price] of data.history)
    if (ids.has(conn))
      put({
        connection_id: conn,
        contract_id: contract,
        client_id: client,
        purchased_at: at,
        price_cents: price,
      });
  const paid = new Set(
    data.payments
      .filter((p) => ids.has(p[0]) && p[1] === "purchase" && p[7] > 0)
      .map((p) => `${p[0]}\u0000${p[3]}`),
  );
  const owners = new Map(sales.connections.map((c) => [c.id, `${c.domain}\u0000${c.club_id}`]));
  const numeric = (s: string) => (/^[0-9]+$/.test(s) ? Number(s) : 0);
  const ordered = [...all.entries()].sort(
    ([, a], [, b]) =>
      a.purchased_at - b.purchased_at ||
      numeric(a.contract_id) - numeric(b.contract_id) ||
      codeCmp(a.contract_id, b.contract_id),
  );
  const first = new Set<string>();
  const kinds = new Map<string, "new" | "repeat">();
  for (const [identity, r] of ordered) {
    if (r.price_cents <= 0 && !paid.has(identity)) continue;
    const client = `${owners.get(r.connection_id)}\u0000${r.client_id}`;
    kinds.set(identity, first.has(client) ? "repeat" : "new");
    first.add(client);
  }
  const countsReady = sales.connections.every((c) => !!(c as FbMyCityConnection).sales_synced_at);
  type Bucket = Record<
    "all_count" | "all_paid" | "new_count" | "new_paid" | "repeat_count" | "repeat_paid",
    number | null
  >;
  const result = new Map<string, Bucket>();
  const item = (uid: number, cid: string) => {
    const name =
      labels.get(`${uid}\u0000${cid}`) ||
      (cid ? "Название ещё не загружено" : "Без связи с договором");
    if (!result.has(name))
      result.set(name, {
        all_count: countsReady ? 0 : null,
        all_paid: sales.ready ? 0 : null,
        new_count: countsReady ? 0 : null,
        new_paid: sales.ready ? 0 : null,
        repeat_count: countsReady ? 0 : null,
        repeat_paid: sales.ready ? 0 : null,
      });
    return result.get(name)!;
  };
  for (const [conn, contract, , at] of data.sales) {
    if (!ids.has(conn)) continue;
    const day = fbDay(at);
    if (!(data.start <= day && day <= data.end)) continue;
    const b = item(conn, contract);
    const kind = kinds.get(`${conn}\u0000${contract}`);
    for (const key of ["all_count", ...(kind ? [`${kind}_count`] : [])] as (keyof Bucket)[])
      if (b[key] !== null) b[key]! += 1;
  }
  for (const r of sales.payment_rows) {
    const b = item(r.connection_id, r.contract_id);
    const kind = r.new ? "new" : r.new !== null ? "repeat" : null;
    for (const key of ["all_paid", ...(kind ? [`${kind}_paid`] : [])] as (keyof Bucket)[])
      if (b[key] !== null) b[key]! += r.paid_cents / 100;
  }
  return [...result.entries()].map(([name, b]) => [
    name,
    b.all_count,
    b.all_paid,
    b.new_count,
    b.new_paid,
    b.repeat_count,
    b.repeat_paid,
  ]);
}

// --- Номенклатуры пробных (их trial_dimensions) -------------------------------------

export type FbMyCityTrialRow = {
  label: string;
  registered: number | null;
  visited: number | null;
  day: number | null;
  within: number | null;
  attendance: number | null;
  day_conversion: number | null;
  conversion: number | null;
  later_base: number;
  later_count: number;
};

export const FB_TRIAL_LABEL_MISSING = "Пробная услуга — название не загружено";

/**
 * Их trial_dimensions: атрибуция покупок по всем пробным, подсчёт — по
 * названию пробной услуги (основание со страницы FitBase, иначе услуга
 * записи); названия — по алфавиту, без записавшихся — не показываются.
 */
export function fbMyCityTrialRows(data: FbMyCityData): FbMyCityTrialRow[] {
  const t = data.trials;
  const labels = new Map(
    data.trial_labels.map(([uid, rid, label]) => [`${uid}\u0000${rid}`, label]),
  );
  const labelOf = (r: FbTrialRecord) =>
    labels.get(`${r.connection_id}\u0000${r.registration_id}`) ?? FB_TRIAL_LABEL_MISSING;
  const records: FbTrialRecord[] = t.records.map(([cid, rid, client, visited, day, endAt]) => ({
    connection_id: cid,
    registration_id: rid,
    client_key: client,
    status: visited ? "visited" : "",
    kind: 1,
    day,
    end_at: endAt,
  }));
  const buckets = fbTrialCalculateByLabel(
    t.selected,
    records,
    t.sales.map(([cid, contract, client, created, price]) => ({
      connection_id: cid,
      contract_id: contract,
      client_id: client,
      purchased_at: created,
      price_cents: price,
      kind: 0,
    })),
    t.payments.map(([cid, contract, op, amount, at]) => ({
      connection_id: cid,
      contract_id: contract,
      operation: op,
      amount_cents: amount,
      pay_at: at,
    })),
    t.from,
    t.to,
    t.now,
    labelOf,
    data.label_keys,
  );
  const grouped = new Map<string, typeof buckets>();
  for (const b of buckets) {
    if (!grouped.has(b.label)) grouped.set(b.label, []);
    grouped.get(b.label)!.push(b);
  }
  const out: FbMyCityTrialRow[] = [];
  for (const label of [...grouped.keys()].sort(codeCmp)) {
    const list = grouped.get(label)!;
    const b = fbTrialAggregate(list);
    if (!b.registered) continue;
    out.push({
      label,
      registered: b.known ? b.registered : null,
      visited: b.known ? b.visited : null,
      day: b.paid_known ? b.day : null,
      within: b.paid_known ? b.within : null,
      attendance: b.attendance,
      day_conversion: b.day_conversion,
      conversion: b.conversion,
      later_base: b.window_base,
      later_count:
        b.window_mature - list.reduce((s, r) => s + (r.loaded ? r.window_same_day : 0), 0),
    });
  }
  return out;
}

// --- Данные доски (их payload) ------------------------------------------------------

export type FbMyCityTotals = Record<PartnerField, number | null>;

export type FbMyCityPayload = {
  /** [период, город, студия, 15 показателей PARTNER_FIELDS] */
  records: (string | number | null)[][];
  /** Месяц доски и пять прошлых: «ГГГГ-ММ». */
  periods: string[];
  cities: string[];
  previousRecords: (Partial<FbMyCityTotals> & { city: string; studio: string })[];
  /** Точка 0 города, рубли. */
  breakEven: Record<string, number>;
  /** [период, город, название, продано, сумма, новые, оплаты новых, продления, оплаты продлений] */
  productRecords: (string | number | null)[][];
  /** [период, город, направление, занятий, записей, посещений] */
  directionRecords: (string | number | null)[][];
  /** Студии города: название · направление → id. */
  studioIds: Record<string, string>;
  studioLabels: string[];
  selectedStudio: string;
  selectedStudioId: string;
  selectedCity: string;
  start: string;
  end: string;
  currentPeriod: string;
  generatedAt: string;
  fitbase: {
    totals: FbMyCityTotals;
    trialProducts: FbMyCityTrialRow[];
    later_conversion: number | null;
    day_base: number;
    day_mature: number;
    attendance: number | null;
    conversion: number | null;
    day_conversion: number | null;
    trial_attendance: number | null;
    notes: string[];
    studioConversions: Record<string, number | null>;
  };
};

const money = (v: number | null | undefined) => (v === null || v === undefined ? null : v / 100);

const monthShift = (month: string, delta: number) =>
  fbShiftMonths(`${month}-01`, delta).slice(0, 7);

/** Их funnel_values: записались, пришли, купили в день, за 14 дней, не в день. */
function funnelValues(b: FbTrialBucket | null): (number | null)[] {
  if (!b) return [null, null, null, null, null];
  return [
    b.known ? b.registered : null,
    b.known ? b.visited : null,
    b.paid_known ? b.day : null,
    b.paid_known ? b.within : null,
    b.paid_known ? b.within - b.day : null,
  ];
}

/** Их payload: строки доски, прошлые месяцы, точка 0, номенклатуры, заметки. */
export function fbMyCityPayload(data: FbMyCityData, built = fbMyCityBuild(data)): FbMyCityPayload {
  const city = data.city;
  const period = data.end.slice(0, 7);
  const s = built.sales;
  const f = built.funnel;
  const a = built.attendance;
  const countReady =
    s.connections.length > 0 &&
    s.connections.every((c) => !!(c as FbMyCityConnection).sales_synced_at);
  const salesStudios = new Map(s.studios.map(([k, v]) => [k.join("\u0000"), v]));
  const records: (string | number | null)[][] = built.studios.map((row) => {
    const detail = salesStudios.get([city, row.id, row.name].join("\u0000"));
    return [
      period,
      city,
      row.name,
      money(row.revenue),
      row.sales,
      countReady ? (detail?.new ?? 0) : null,
      countReady ? (detail?.repeat ?? 0) : null,
      money(s.ready ? (detail?.new_paid ?? 0) : null),
      money(s.ready ? (detail?.repeat_paid ?? 0) : null),
      money(s.ready ? (detail?.amount ?? 0) : null),
      row.attendance.lessons,
      row.attendance.registered,
      row.attendance.visited,
      ...funnelValues(row.funnel),
    ];
  });
  const periods = [0, -1, -2, -3, -4, -5].map((i) => monthShift(period, i));
  const months = new Map(s.months.map((m) => [m.month, m]));
  for (const month of periods.slice(1)) {
    const lo = `${month}-01`;
    const hi = `${month}-${String(daysInMonth(lo)).padStart(2, "0")}`;
    const cash = fbMyCityRevenue(data.connections, data.daily, lo, hi, data.now);
    const m = months.get(month);
    records.push([
      month,
      city,
      "Все студии",
      money(cash.total),
      countReady ? (m?.count ?? null) : null,
      countReady ? (m?.new ?? null) : null,
      countReady ? (m?.repeat ?? null) : null,
      money(m?.new_paid),
      money(m?.repeat_paid),
      money(m?.amount),
      ...Array<null>(8).fill(null),
    ]);
  }
  const previousCash = fbMyCityRevenue(
    data.connections,
    data.daily,
    data.attendance.pm_from,
    data.attendance.pm_to,
    data.now,
  );
  const totalsList: (number | null)[] = [
    money(built.revenue.total),
    countReady ? s.total.count : null,
    countReady ? s.total.new : null,
    countReady ? s.total.repeat : null,
    money(s.total.new_paid),
    money(s.total.repeat_paid),
    money(s.total.amount),
    a.lessons,
    a.registered,
    a.visited,
    ...funnelValues(f),
  ];
  const totals = Object.fromEntries(
    PARTNER_FIELDS.map((k, i) => [k, totalsList[i]]),
  ) as FbMyCityTotals;
  const studioIds = Object.fromEntries(data.options.map(([id, label]) => [label, id]));
  const selectedLabel = data.options.find(([id]) => id === data.studio)?.[1] ?? "";
  const notes: string[] = [];
  if (built.revenue.missing.length)
    notes.push(
      "Выручка по доступной части: нет полного периода у " + built.revenue.missing.join(", ") + ".",
    );
  if (!s.ready) notes.push("Данные оплат загружены не у всех выбранных студий.");
  if (Object.values(a).some((v) => v === null))
    notes.push("Посещаемость: часть показателей не подтверждена полным периодом.");
  notes.push(
    "Пробные: расчёт по определённым основаниям; неопределённых записей — " + built.unknown + ".",
  );
  if (!f.base_complete || !f.paid_complete)
    notes.push("Воронка неполна. Неподтверждённые конверсии показаны прочерком.");
  notes.push(
    "Конверсия за 14 дней — по завершённым окнам; день пробного и следующие 13 дней. Незавершённых окон: " +
      f.immature +
      ".",
  );
  const stamps = Object.values(built.updated);
  const updated = stamps.length ? Math.min(...stamps) : 0;
  const trialRows = fbMyCityTrialRows(data);
  const laterBase = trialRows.reduce((sum, r) => sum + r.later_base, 0);
  const laterConversion =
    f.paid_complete && laterBase
      ? (trialRows.reduce((sum, r) => sum + r.later_count, 0) / laterBase) * 100
      : null;
  return {
    records,
    periods,
    cities: data.cities,
    previousRecords: [
      {
        ...Object.fromEntries(PARTNER_FIELDS.map((k) => [k, null])),
        city,
        studio: "Все студии",
        revenue: money(previousCash.total),
      },
    ],
    breakEven: data.target !== null ? { [city]: data.target / 100 } : {},
    productRecords: fbMyCityProducts(data, s).map((r) => [period, city, ...r]),
    directionRecords: [...built.directions].map(([name, r]) => [
      period,
      city,
      name,
      r.lessons,
      r.registered,
      r.visited,
    ]),
    studioIds,
    studioLabels: data.options.map(([, label]) => label),
    selectedStudio: selectedLabel,
    selectedStudioId: data.studio,
    selectedCity: city,
    start: data.start,
    end: data.end,
    currentPeriod: period,
    generatedAt: updated ? fbTimestamp(updated) : "не все наборы загружены",
    fitbase: {
      totals,
      trialProducts: trialRows,
      later_conversion: laterConversion,
      day_base: f.day_base,
      day_mature: f.day_mature,
      attendance: a.attendance,
      conversion: f.conversion,
      day_conversion: f.day_conversion,
      trial_attendance: f.attendance,
      notes,
      studioConversions: Object.fromEntries(
        built.studios.map((r) => [r.name, r.funnel?.conversion ?? null]),
      ),
    },
  };
}

// --- Доска (их partner.html с правками fitbase_partner_view.template) --------------

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Их fmt после правки: нет значения — «—». */
export const fbCityFmt = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : NUMBER.format(v);
/** Их rub после правки. */
export const fbCityRub = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : fbCityFmt(v) + " ₽";
/** Их pct после правки: обе величины есть и знаменатель не ноль. */
export const fbCityPct = (a: number | null | undefined, b: number | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && b
    ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%"
    : "—";
/** Их formatFitbasePercent: готовый процент FitBase. */
export const fbCityPercent = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toFixed(1).replace(".", ",") + "%";

const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

type CityRow = { period: string; city: string; studio: string } & FbMyCityTotals;

function cityRows(p: FbMyCityPayload): CityRow[] {
  return p.records.map((r) => {
    const x = { period: r[0], city: r[1], studio: r[2] } as CityRow;
    PARTNER_FIELDS.forEach((f, i) => (x[f] = r[i + 3] as number | null));
    return x;
  });
}

/** Их sum после правки: пропуски не считаются, совсем нет значений — null. */
function sumN(items: Partial<FbMyCityTotals>[]): FbMyCityTotals {
  const out = {} as FbMyCityTotals;
  for (const f of PARTNER_FIELDS)
    out[f] = items.reduce<number | null>((s, r) => {
      const v = r[f];
      return v === null || v === undefined ? s : s === null ? v : s + v;
    }, null);
  return out;
}

/** Их арифметика JS: пусто в выражении — ноль. */
const n0 = (v: number | null | undefined) => v ?? 0;

export type FbCitySummary = {
  title: string;
  subtitle: string;
  revenue: string;
  revenueDelta: { up: boolean; text: string } | null;
  sales: string;
  newSalesDetail: string;
  attendance: string;
  attendanceDetail: string;
  conversion: string;
  conversionDetail: string;
  revenueBars: {
    period: string;
    tick: string;
    value: number;
    text: string;
    height: number;
    current: boolean;
  }[];
  breakEven:
    | { kind: "studio" | "missing"; value: string; detail: string }
    | { kind: "set"; value: string; above: boolean; amount: string };
  newSales: string;
  newPayments: string;
  repeatSales: string;
  repeatPayments: string;
  newCheck: string;
  repeatCheck: string;
  classes: string;
  booked: string;
  bookedRate: string;
  attended: string;
  attendedRate: string;
  funnel: { label: string; value: string; width: number }[];
  trialAttendance: string;
  trialAttendanceDetail: string;
  dayConversion: string;
  dayConversionDetail: string;
  laterConversion: string;
  studios: {
    name: string;
    total: FbMyCityTotals;
    conversionValue: number | null;
    revenue: string;
    sales: string;
    attendance: string;
    conversion: string;
  }[];
  trend: {
    key: string;
    newSales: number | null;
    repeatSales: number | null;
  }[];
};

const dotDate = (day: string) => day.split("-").reverse().join(".");

/** Их render() с правками FitBase: итоги — totals FitBase, конверсии — воронка FitBase. */
export function fbMyCitySummary(p: FbMyCityPayload): FbCitySummary {
  const rows = cityRows(p);
  const period = p.periods[0] ?? "";
  const city = p.selectedCity;
  const rs = rows.filter((r) => r.period === period && r.city === city);
  const total = p.fitbase.totals;
  const prev = p.periods[1];
  const prevRevenue = sumN(p.previousRecords.filter((r) => r.city === city)).revenue;
  const d = n0(total.revenue) - n0(prevRevenue);
  const history = p.periods
    .slice(0, 6)
    .reverse()
    .map((x) => ({
      period: x,
      v: sumN(rows.filter((r) => r.period === x && r.city === city)).revenue,
    }));
  const max = Math.max(...history.map((x) => n0(x.v)), 1);
  const be = p.breakEven[city];
  const groups = new Map<string, CityRow[]>();
  for (const r of rs) {
    if (!groups.has(r.studio)) groups.set(r.studio, []);
    groups.get(r.studio)!.push(r);
  }
  const studios = [...groups]
    .map(([name, list]) => {
      const t = sumN(list);
      const conversionValue = p.fitbase.studioConversions[name] ?? null;
      const row = {
        name,
        total: t,
        conversionValue,
        revenue: fbCityRub(t.revenue),
        sales: fbCityFmt(t.sales),
        attendance: fbCityPct(t.attended, t.booked),
        conversion: fbCityPercent(conversionValue),
      };
      const html = `<tr><td class="studio">${escapeHtml(name)}</td><td>${row.revenue}</td><td>${row.sales}</td><td>${row.attendance}</td><td>${row.conversion}</td></tr>`;
      return { row, html };
    })
    .sort((a, b) => b.html.localeCompare(a.html, "ru"))
    .map((x) => x.row);
  const index = p.periods.indexOf(period);
  const trendPeriods = (index < 0 ? p.periods : p.periods.slice(index, index + 6))
    .slice(0, 6)
    .reverse();
  const funnel: [string, number | null][] = [
    ["Записались", total.trials],
    ["Пришли", total.trial_attended],
    ["Купили в день", total.bought_day],
    ["Купили за 14 дней", total.bought_14],
  ];
  const later = p.fitbase.later_conversion;
  return {
    title: "Мой город — " + city,
    subtitle:
      "Главные показатели сети студий · " +
      dotDate(p.start) +
      " — " +
      dotDate(p.end) +
      (p.selectedStudio ? " · " + p.selectedStudio : ""),
    revenue: fbCityRub(total.revenue),
    revenueDelta:
      prev && total.revenue !== null && prevRevenue !== null && prevRevenue !== 0
        ? { up: d >= 0, text: fbCityPct(Math.abs(d), Math.abs(prevRevenue)) }
        : null,
    sales: fbCityFmt(total.sales),
    newSalesDetail: "из них " + fbCityFmt(total.new_sales) + " новых клиентов",
    attendance: fbCityPercent(p.fitbase.attendance),
    attendanceDetail:
      fbCityFmt(total.attended) + " из " + fbCityFmt(total.booked) + " записавшихся",
    conversion: fbCityPercent(p.fitbase.conversion),
    conversionDetail: fbCityFmt(total.bought_14) + " покупок за 14 дней",
    revenueBars: history.map((x) => ({
      period: x.period,
      tick: x.period.slice(5),
      value: n0(x.v),
      text: fbCityRub(x.v),
      height: Math.max(2, (n0(x.v) / max) * 100),
      current: x.period === period,
    })),
    breakEven: p.selectedStudio
      ? {
          kind: "studio",
          value: "Для всего города",
          detail: "Цель студии отдельно не задана. Для сравнения с точкой 0 выберите все студии.",
        }
      : be
        ? {
            kind: "set",
            value: fbCityRub(be),
            above: n0(total.revenue) >= be,
            amount: fbCityRub(Math.abs(n0(total.revenue) - be)),
          }
        : {
            kind: "missing",
            value: "Не задана",
            detail: "Для города нет числового значения в справочнике",
          },
    newSales: fbCityFmt(total.new_sales),
    newPayments: "Оплаты: " + fbCityRub(total.new_payments),
    repeatSales: fbCityFmt(total.repeat_sales),
    repeatPayments: "Оплаты: " + fbCityRub(total.repeat_payments),
    newCheck: total.new_sales ? fbCityRub(n0(total.new_payments) / total.new_sales) : "—",
    repeatCheck: total.repeat_sales
      ? fbCityRub(n0(total.repeat_payments) / total.repeat_sales)
      : "—",
    classes: fbCityFmt(total.classes),
    booked: fbCityFmt(total.booked),
    bookedRate: total.classes
      ? (n0(total.booked) / total.classes).toFixed(1).replace(".", ",") + " на занятие"
      : "—",
    attended: fbCityFmt(total.attended),
    attendedRate: total.classes
      ? (n0(total.attended) / total.classes).toFixed(1).replace(".", ",") + " на занятие"
      : "—",
    funnel: funnel.map(([label, v]) => ({
      label,
      value: fbCityFmt(v),
      width: total.trials ? Math.min(100, (n0(v) / total.trials) * 100) : 0,
    })),
    trialAttendance: fbCityPercent(p.fitbase.trial_attendance),
    trialAttendanceDetail:
      fbCityFmt(total.trial_attended) + " из " + fbCityFmt(total.trials) + " записавшихся",
    dayConversion: fbCityPercent(p.fitbase.day_conversion),
    dayConversionDetail:
      fbCityFmt(p.fitbase.day_mature) +
      " из " +
      fbCityFmt(p.fitbase.day_base) +
      " в подтверждённом окне",
    laterConversion: later === null ? "—" : "+" + fbCityPercent(later),
    studios,
    trend: trendPeriods.map((key) => {
      const t = sumN(rows.filter((r) => r.period === key && r.city === city));
      return { key, newSales: t.new_sales, repeatSales: t.repeat_sales };
    }),
  };
}

export type FbCityProduct = { name: string; count: number | null; amount: number | null };

/** «Что покупают»: месяц доски, продано больше нуля, по убыванию. */
export function fbCityProducts(
  p: FbMyCityPayload,
  segment: "all" | "new" | "repeat",
): FbCityProduct[] {
  const [count, amount] = segment === "new" ? [5, 6] : segment === "repeat" ? [7, 8] : [3, 4];
  return p.productRecords
    .filter(
      (r) => r[0] === p.periods[0] && r[1] === p.selectedCity && n0(r[count] as number | null) > 0,
    )
    .sort((a, b) => n0(b[count] as number | null) - n0(a[count] as number | null))
    .map((r) => ({
      name: String(r[2]),
      count: r[count] as number | null,
      amount: r[amount] as number | null,
    }));
}

export type FbCityDirection = {
  name: string;
  classes: number | null;
  booked: number | null;
  attended: number | null;
};

/** «Направления занятий» месяца доски: их сортировка (пусто в сравнении — ноль). */
export function fbCityDirections(
  p: FbMyCityPayload,
  sort: { key: "classes" | "booked" | "attended" | "attendance"; order: "desc" | "asc" },
): FbCityDirection[] {
  const value = (r: FbCityDirection) =>
    sort.key === "attendance" ? (r.booked ? n0(r.attended) / r.booked : -1) : n0(r[sort.key]);
  return p.directionRecords
    .filter((r) => r[0] === p.periods[0] && r[1] === p.selectedCity)
    .map((r) => ({
      name: String(r[2]),
      classes: r[3] as number | null,
      booked: r[4] as number | null,
      attended: r[5] as number | null,
    }))
    .sort((a, b) => (sort.order === "desc" ? value(b) - value(a) : value(a) - value(b)));
}
