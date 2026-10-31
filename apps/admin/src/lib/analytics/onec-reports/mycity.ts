/**
 * Доска «Мой город» (их partner.html + partner-reference.js, боевой портал
 * аналитики, /1c?report=partner) — расчёты и подписи, построчно как у них,
 * без React. Данные — PartnerPayload (их partner_payload, ./payload.ts).
 *
 * Их особенности сохранены намеренно (решение владельца: перенос как есть):
 * - месяц доски — первый из `periods` (их скрытый выбор периода стоит на
 *   первом варианте), «к прошлому месяцу» — по `previousRecords`, рост при
 *   разнице ≥ 0 (и при нуле), процент от |прошлой выручки|, без неё — «—»;
 * - столбики выручки — доля от максимума (не меньше 2 %, отрицательная
 *   выручка — тоже 2 %);
 * - точка 0 — 0 или нет значения → «Не задана»; при выбранной студии —
 *   «Для всего города»;
 * - студии города — по убыванию строки их таблицы (localeCompare "ru"),
 *   то есть по названию от Я к А;
 * - числа — Intl ru-RU без дробной части (пусто и NaN → 0), проценты —
 *   toFixed(1) с запятой, деление на ноль — «—».
 */
import { label as monthLabel, type PartnerPayload } from "./payload";
import type { OnecSearch } from "./search";

// --- Форматирование (их fmt / rub / pct) -------------------------------------------

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Их fmt: целое с пробелами по разрядам; пусто, 0 и NaN — «0». */
export const fmt = (v: number | null | undefined) => NUMBER.format(v || 0);

/** Их rub: «357 308 ₽». */
export const rub = (v: number | null | undefined) => fmt(v) + " ₽";

/** Их pct: доля a от b с одним знаком после запятой; b = 0 — «—». */
export const pct = (a: number, b: number) =>
  b ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%" : "—";

/** «4,0 на занятие» (записано или посетило на проведённое занятие). */
export const perClass = (n: number, classes: number) =>
  classes ? (n / classes).toFixed(1).replace(".", ",") + " на занятие" : "—";

/** Их format в partner-reference.js: 2026-10-01 → 01.10.2026. */
export const dotDate = (day: string) => day.split("-").reverse().join(".");

// --- Строки данных ------------------------------------------------------------------

/** Порядок значений в `records` (после периода, города и студии). */
export const PARTNER_FIELDS = [
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
] as const;
export type PartnerField = (typeof PARTNER_FIELDS)[number];
export type PartnerTotals = Record<PartnerField, number>;
export type PartnerRow = { period: string; city: string; studio: string } & PartnerTotals;

/** Их rows: записи доски объектами. */
export function partnerRows(payload: PartnerPayload): PartnerRow[] {
  return payload.records.map((r) => {
    const x = { period: r[0], city: r[1], studio: r[2] } as PartnerRow;
    PARTNER_FIELDS.forEach((f, i) => (x[f] = r[i + 3] as number));
    return x;
  });
}

/** Их sum: суммы всех показателей по строкам. */
export function sumTotals(items: Record<string, unknown>[]): PartnerTotals {
  const out = {} as PartnerTotals;
  for (const f of PARTNER_FIELDS) out[f] = items.reduce<number>((s, r) => s + (r[f] as number), 0);
  return out;
}

/** Месяц доски: их скрытый выбор периода — первый вариант из `periods`. */
export const boardPeriod = (payload: PartnerPayload) => payload.periods[0] ?? "";

/**
 * Город доски: из адреса (их select #city; server-controls.js переносил его
 * через смену периода), при выбранной студии — город, с которым база
 * отфильтровала данные; нет такого — первый город.
 */
export function boardCity(payload: PartnerPayload, wanted: string | undefined): string {
  const want = payload.selectedStudio ? payload.selectedCity : (wanted ?? "");
  return payload.cities.includes(want) ? want : (payload.cities[0] ?? "");
}

/** Варианты студии города: «Все студии» (пусто) и студии из studioOptions. */
export function studioChoices(payload: PartnerPayload, city: string): string[] {
  return ["", ...(payload.studioOptions[city] ?? [])];
}

/**
 * Доска ещё показывает прежние данные: адрес уже просит другую студию,
 * город при студии или период (город без студии данные не меняет) (рамка перезагружает данные, прежние остаются
 * на экране).
 */
export function filtersPending(search: OnecSearch, payload: PartnerPayload): boolean {
  return (
    (search.studio ?? "") !== payload.selectedStudio ||
    (!!search.studio && (search.city ?? "") !== payload.selectedCity) ||
    (search.start !== undefined && search.start !== payload.start) ||
    (search.end !== undefined && search.end !== payload.end)
  );
}

// --- Сводка города ------------------------------------------------------------------

export type RevenueBar = {
  period: string;
  /** Подпись столбика — номер месяца («05»). */
  tick: string;
  /** Полное название месяца для подсказки («Май 2026»). */
  label: string;
  value: number;
  /** Подпись суммы, если не rub(value) (доска FitBase: нет данных — «—»). */
  text?: string;
  /** Высота в процентах от самого высокого столбика (не меньше 2). */
  height: number;
  current: boolean;
};

export type BreakEven =
  | { kind: "studio"; value: string; detail: string }
  | { kind: "missing"; value: string; detail: string }
  | { kind: "set"; value: string; above: boolean; amount: string };

export type PartnerSummary = {
  title: string;
  subtitle: string;
  total: PartnerTotals;
  revenue: string;
  /** null — «Нет периода для сравнения». */
  revenueDelta: { up: boolean; text: string } | null;
  sales: string;
  newSalesDetail: string;
  attendance: string;
  attendanceDetail: string;
  conversion: string;
  conversionDetail: string;
  revenueBars: RevenueBar[];
  breakEven: BreakEven;
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
};

/** Их render(): плитки, выручка по месяцам, точка 0, продажи, занятия, воронка. */
export function partnerSummary(
  payload: PartnerPayload,
  city: string,
  rows: PartnerRow[] = partnerRows(payload),
): PartnerSummary {
  const p = boardPeriod(payload);
  const total = sumTotals(rows.filter((r) => r.period === p && r.city === city));
  const prev = payload.periods[payload.periods.indexOf(p) + 1];
  const prevTotal = sumTotals(payload.previousRecords.filter((r) => r.city === city));
  const d = total.revenue - prevTotal.revenue;

  const history = payload.periods
    .slice(0, 6)
    .reverse()
    .map((x) => ({
      period: x,
      value: sumTotals(rows.filter((r) => r.period === x && r.city === city)).revenue,
    }));
  const max = Math.max(...history.map((x) => x.value), 1);

  const be = payload.breakEven[city];
  const breakEven: BreakEven = payload.selectedStudio
    ? {
        kind: "studio",
        value: "Для всего города",
        detail: "Цель студии отдельно не задана. Для сравнения с точкой 0 выберите все студии.",
      }
    : be
      ? {
          kind: "set",
          value: rub(be),
          above: total.revenue >= be,
          amount: rub(Math.abs(total.revenue - be)),
        }
      : {
          kind: "missing",
          value: "Не задана",
          detail: "Для города нет числового значения в справочнике",
        };

  const funnel: [string, number][] = [
    ["Записались", total.trials],
    ["Пришли", total.trial_attended],
    ["Купили в день", total.bought_day],
    ["Купили за 14 дней", total.bought_14],
  ];

  return {
    title: "Мой город — " + city,
    subtitle:
      "Главные показатели сети студий · " +
      dotDate(payload.start) +
      " — " +
      dotDate(payload.end) +
      (payload.selectedStudio ? " · " + payload.selectedStudio : ""),
    total,
    revenue: rub(total.revenue),
    revenueDelta: prev ? { up: d >= 0, text: pct(Math.abs(d), Math.abs(prevTotal.revenue)) } : null,
    sales: fmt(total.sales),
    newSalesDetail: "из них " + fmt(total.new_sales) + " новых клиентов",
    attendance: pct(total.attended, total.booked),
    attendanceDetail: fmt(total.attended) + " из " + fmt(total.booked) + " записавшихся",
    conversion: pct(total.bought_14, total.trial_attended),
    conversionDetail: fmt(total.bought_14) + " покупок за 14 дней",
    revenueBars: history.map((x) => ({
      period: x.period,
      tick: x.period.slice(5),
      label: monthLabel(x.period),
      value: x.value,
      height: Math.max(2, (x.value / max) * 100),
      current: x.period === p,
    })),
    breakEven,
    newSales: fmt(total.new_sales),
    newPayments: "Оплаты: " + rub(total.new_payments),
    repeatSales: fmt(total.repeat_sales),
    repeatPayments: "Оплаты: " + rub(total.repeat_payments),
    newCheck: total.new_sales ? rub(total.new_payments / total.new_sales) : "—",
    repeatCheck: total.repeat_sales ? rub(total.repeat_payments / total.repeat_sales) : "—",
    classes: fmt(total.classes),
    booked: fmt(total.booked),
    bookedRate: perClass(total.booked, total.classes),
    attended: fmt(total.attended),
    attendedRate: perClass(total.attended, total.classes),
    funnel: funnel.map(([l, v]) => ({
      label: l,
      value: fmt(v),
      width: total.trials ? Math.min(100, (v / total.trials) * 100) : 0,
    })),
    trialAttendance: pct(total.trial_attended, total.trials),
    trialAttendanceDetail: fmt(total.trial_attended) + " из " + fmt(total.trials) + " записавшихся",
    dayConversion: pct(total.bought_day, total.trial_attended),
    dayConversionDetail: fmt(total.bought_day) + " из " + fmt(total.trial_attended) + " пришедших",
    laterConversion: total.trial_attended
      ? "+" + pct(total.bought_later, total.trial_attended)
      : "—",
  };
}

// --- Динамика продаж ----------------------------------------------------------------

const TREND_MONTHS = [
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

/** Подпись месяца на графике динамики: «Окт 26». */
export function trendLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${TREND_MONTHS[Number(month) - 1]} ${year.slice(2)}`;
}

/** Высота графика динамики, px (по ней — место подписей значений). */
export const TREND_CHART_HEIGHT = 260;

export type TrendPoint = {
  key: string;
  label: string;
  newSales: number;
  repeatSales: number;
  /** Подписи значений, если не fmt (доска FitBase: нет данных — «—»). */
  text?: Partial<Record<"newSales" | "repeatSales", string>>;
};
export type SalesTrend = {
  points: TrendPoint[];
  /** Верх шкалы: чётный, не меньше 2. */
  ceiling: number;
  /** Деления шкалы сверху вниз: верх, середина, 0. */
  ticks: number[];
};

/** Их renderSalesTrend: новые продажи и продления за шесть месяцев до месяца доски. */
export function salesTrend(
  payload: PartnerPayload,
  city: string,
  rows: PartnerRow[] = partnerRows(payload),
): SalesTrend {
  const index = payload.periods.indexOf(boardPeriod(payload));
  const periods = (index < 0 ? payload.periods : payload.periods.slice(index, index + 6))
    .slice(0, 6)
    .reverse();
  const points = periods.map((key) => {
    const total = sumTotals(rows.filter((r) => r.period === key && r.city === city));
    return {
      key,
      label: trendLabel(key),
      newSales: total.new_sales,
      repeatSales: total.repeat_sales,
    };
  });
  const maximum = Math.max(...points.flatMap((x) => [x.newSales, x.repeatSales]), 1);
  const ceiling = Math.max(2, Math.ceil(maximum / 2) * 2);
  return { points, ceiling, ticks: [0, 0.5, 1].map((f) => Math.round(ceiling * (1 - f))) };
}

export type TrendSeries = "newSales" | "repeatSales";

/**
 * Их размещение подписи значения у точки (в пикселях графика): над точкой,
 * если она выше второй линии, иначе под ней; у верхнего и нижнего края —
 * наоборот и со сдвигом вбок; точки ближе 22 px — тоже вбок (новые —
 * влево, продления — вправо). Возвращает сдвиг по x и y подписи.
 */
export function trendLabelPosition({
  series,
  pointY,
  otherY,
  top,
  plotHeight,
}: {
  series: TrendSeries;
  pointY: number;
  otherY: number;
  top: number;
  plotHeight: number;
}): { dx: number; y: number } {
  const side = series === "newSales" ? -10 : 10;
  const close = Math.abs(pointY - otherY) < 22;
  let y = pointY <= otherY ? pointY - 12 : pointY + 19;
  let dx = 0;
  if (y < top + 11) {
    y = pointY + 19;
    dx = side;
  } else if (y > top + plotHeight - 10) {
    y = pointY - 12;
    dx = side;
  } else if (close) {
    dx = side;
  }
  return { dx, y };
}

// --- Таблицы ------------------------------------------------------------------------

export type ProductSegment = "all" | "new" | "repeat";
export const PRODUCT_SEGMENTS: { value: ProductSegment; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "new", label: "Новые" },
  { value: "repeat", label: "Продления" },
];

export type ProductRow = { name: string; count: number; amount: number };

/**
 * «Что покупают»: номенклатуры месяца доски в городе — продано и сумма
 * (все / новые / продления), только с продажами больше нуля, по убыванию.
 */
export function productRows(
  payload: PartnerPayload,
  city: string,
  segment: ProductSegment,
): ProductRow[] {
  const [count, amount] = segment === "new" ? [5, 6] : segment === "repeat" ? [7, 8] : [3, 4];
  const p = boardPeriod(payload);
  return payload.productRecords
    .filter((row) => row[0] === p && row[1] === city && (row[count] as number) > 0)
    .sort((left, right) => (right[count] as number) - (left[count] as number))
    .map((row) => ({
      name: String(row[2]),
      count: row[count] as number,
      amount: row[amount] as number,
    }));
}

export type TrialProductRow = {
  name: string;
  trials: number;
  attended: number;
  boughtDay: number;
  bought14: number;
};

/** «Номенклатуры пробных занятий»: по убыванию записавшихся. */
export function trialProductRows(payload: PartnerPayload, city: string): TrialProductRow[] {
  const p = boardPeriod(payload);
  return payload.trialProductRecords
    .filter((row) => row[0] === p && row[1] === city)
    .sort((left, right) => (right[3] as number) - (left[3] as number))
    .map((row) => ({
      name: String(row[2]),
      trials: row[3] as number,
      attended: row[4] as number,
      boughtDay: row[5] as number,
      bought14: row[6] as number,
    }));
}

export type DirectionSortKey = "classes" | "booked" | "attended" | "attendance";
export type SortOrder = "desc" | "asc";
export type DirectionSort = { key: DirectionSortKey; order: SortOrder };
/** Их порядок при открытии: по числу занятий, по убыванию. */
export const DIRECTION_SORT: DirectionSort = { key: "classes", order: "desc" };

export type DirectionRow = { name: string; classes: number; booked: number; attended: number };

/** Их directionValue: доходимость без записей — −1 (в конце по убыванию). */
export function directionValue(row: DirectionRow, key: DirectionSortKey): number {
  return key === "classes"
    ? row.classes
    : key === "booked"
      ? row.booked
      : key === "attended"
        ? row.attended
        : row.booked
          ? row.attended / row.booked
          : -1;
}

/** Нажатие на показатель: тот же — смена направления, другой — по убыванию. */
export function nextDirectionSort(current: DirectionSort, key: DirectionSortKey): DirectionSort {
  return {
    key,
    order: key === current.key ? (current.order === "desc" ? "asc" : "desc") : "desc",
  };
}

/** «Направления занятий» месяца доски в городе в выбранном порядке. */
export function directionRows(
  payload: PartnerPayload,
  city: string,
  sort: DirectionSort,
): DirectionRow[] {
  const p = boardPeriod(payload);
  return payload.directionRecords
    .filter((row) => row[0] === p && row[1] === city)
    .map((row) => ({
      name: String(row[2]),
      classes: row[3] as number,
      booked: row[4] as number,
      attended: row[5] as number,
    }))
    .sort((left, right) =>
      sort.order === "desc"
        ? directionValue(right, sort.key) - directionValue(left, sort.key)
        : directionValue(left, sort.key) - directionValue(right, sort.key),
    );
}

export type StudioRow = {
  name: string;
  total: PartnerTotals;
  revenue: string;
  sales: string;
  attendance: string;
  conversion: string;
};

/**
 * «Студии города»: свод по студиям месяца доски. Порядок — их: строки
 * таблицы (разметка с названием в начале) по убыванию localeCompare "ru".
 */
export function studioRows(
  payload: PartnerPayload,
  city: string,
  rows: PartnerRow[] = partnerRows(payload),
): StudioRow[] {
  const p = boardPeriod(payload);
  const groups = new Map<string, PartnerRow[]>();
  for (const r of rows) {
    if (r.period !== p || r.city !== city) continue;
    let list = groups.get(r.studio);
    if (!list) groups.set(r.studio, (list = []));
    list.push(r);
  }
  return [...groups]
    .map(([name, list]) => {
      const t = sumTotals(list);
      const row: StudioRow = {
        name,
        total: t,
        revenue: rub(t.revenue),
        sales: fmt(t.sales),
        attendance: pct(t.attended, t.booked),
        conversion: pct(t.bought_14, t.trial_attended),
      };
      const html = `<tr><td class="studio">${name}</td><td>${row.revenue}</td><td>${row.sales}</td><td>${row.attendance}</td><td>${row.conversion}</td></tr>`;
      return { row, html };
    })
    .sort((a, b) => b.html.localeCompare(a.html, "ru"))
    .map((x) => x.row);
}

/** Доля для сортировки колонки процента (их pct без «—» → null). */
export const ratio = (a: number, b: number) => (b ? a / b : null);

/** Ссылка «Маркетинговый отчет» — их DataLens, как есть. */
export const MARKETING_REPORT_URL = "https://datalens.yandex/2gcqcqyn2fkcm";
