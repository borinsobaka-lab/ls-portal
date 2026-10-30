/**
 * Доска «Продажи абонементов» — перенос их sales.html: скрипт доски (фильтры,
 * плитки, таблица «город → студия → номенклатура», сравнения, сортировка) и
 * слой оформления поверх него (decorate / normalize / renderCharts: сравнение
 * плиток с прошлым месяцем, «₽» снят с сумм, три графика). Расчёты, подписи и
 * форматирование — как у них, вместе с их особенностями (ANALYTICS_PLAN.md,
 * §9: не «чинить»). Без React.
 */
import type { SalesPayload, SalesRecord } from "./payload";

export const SALES_METRIC_KEYS = [
  "sales",
  "newSales",
  "repeatSales",
  "newPayments",
  "repeatPayments",
  "salesAmount",
] as const;
export type SalesMetricKey = (typeof SALES_METRIC_KEYS)[number];
export type SalesTotals = Record<SalesMetricKey, number>;

/** «Все города» / «Все студии» — их значение `all` у списков. */
export const SALES_ALL = "all";
export type SalesFilters = { city: string; studio: string };

// --- Форматирование (их fmt / money / count) -----------------------------------------

const fmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat("ru-RU");

/** Их money: «₽ 1 234» (без копеек). */
export const salesMoney = (v: number) => "₽ " + fmt.format(Math.round(v || 0));
/** Их count: «1 234». */
export const salesCount = (v: number) => fmt.format(Math.round(v || 0));
/** Их decorate / normalize: «₽» снят с плиток и ячеек. */
export const stripRuble = (text: string) => text.replace(/₽\s*/g, "").trim();

// --- Период --------------------------------------------------------------------------

/**
 * Значение их скрытого списка месяцев (#period): месяц начала периода, если
 * он есть среди месяцев снимка, иначе пусто — тогда у плиток нет сравнения,
 * «₽» не снят, графиков нет (decorate и renderCharts выходят сразу).
 */
export function salesBoardPeriod(p: Pick<SalesPayload, "periods" | "currentPeriod">): string {
  return p.periods.some((x) => x.key === p.currentPeriod) ? p.currentPeriod : "";
}

/** Их shiftPeriod: «ГГГГ-ММ» со сдвигом в месяцах (у пустого — «NaN-NaN»). */
export function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const value = year * 12 + month - 1 + delta;
  return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
}

/** Их previousPeriod слоя оформления — прошлый месяц через Date. */
export function salesPreviousPeriod(value: string): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(year, month - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// --- Строки и фильтры ----------------------------------------------------------------

/**
 * Их inRange: месяц выбран (их onecInitPeriod отдаёт месяц начала периода) и
 * дата строки внутри периода — строки истории по месяцам сюда не входят.
 */
export function salesInRange(p: SalesPayload, r: SalesRecord): boolean {
  return (
    r.period === p.currentPeriod && (!p.start || r.date >= p.start) && (!p.end || r.date <= p.end)
  );
}

/** Их filtered(): строки периода выбранного города и студии. */
export function salesFiltered(p: SalesPayload, f: SalesFilters): SalesRecord[] {
  return p.records.filter(
    (r) =>
      salesInRange(p, r) &&
      (f.city === SALES_ALL || r.city === f.city) &&
      (f.studio === SALES_ALL || r.studio === f.studio),
  );
}

const sortRu = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b, "ru"));

/** Города списка (их updateOptions): из строк периода, по алфавиту. */
export function salesCityOptions(p: SalesPayload): string[] {
  return sortRu(new Set(p.records.filter((r) => salesInRange(p, r)).map((r) => r.city)));
}

/** Студии списка: строки периода выбранного города. */
export function salesStudioOptions(p: SalesPayload, city: string): string[] {
  return sortRu(
    new Set(
      p.records
        .filter((r) => salesInRange(p, r) && (city === SALES_ALL || r.city === city))
        .map((r) => r.studio),
    ),
  );
}

/** Их filterCityOptions: «Найти город» прячет города без запроса в названии. */
export function salesCityVisible(city: string, search: string): boolean {
  const query = search.trim().toLocaleLowerCase("ru");
  return !query || city.toLocaleLowerCase("ru").includes(query);
}

/**
 * Город и студия из адреса (их server-controls: значение ставится, только
 * если такой пункт есть в списке; студия — из студий выбранного города).
 */
export function salesSelection(
  p: SalesPayload,
  search: { city?: string; studio?: string },
): SalesFilters {
  const city =
    search.city && (search.city === SALES_ALL || salesCityOptions(p).includes(search.city))
      ? search.city
      : SALES_ALL;
  const studio =
    search.studio &&
    (search.studio === SALES_ALL || salesStudioOptions(p, city).includes(search.studio))
      ? search.studio
      : SALES_ALL;
  return { city, studio };
}

/** Смена города (их change → updateOptions): студия остаётся, если она есть у города. */
export function salesSelectCity(p: SalesPayload, f: SalesFilters, city: string): SalesFilters {
  const keep = f.studio !== SALES_ALL && salesStudioOptions(p, city).includes(f.studio);
  return { city, studio: keep ? f.studio : SALES_ALL };
}

/** Что держать в адресе: «все» и пустое значение у них не сохранялись. */
export const salesUrlValue = (v: string) => (v && v !== SALES_ALL ? v : undefined);

// --- Плитки ----------------------------------------------------------------------------

const emptyTotals = (): SalesTotals => ({
  sales: 0,
  newSales: 0,
  repeatSales: 0,
  newPayments: 0,
  repeatPayments: 0,
  salesAmount: 0,
});

/** Их sum по каждому показателю. */
export function salesTotals(rows: Pick<SalesRecord, SalesMetricKey>[]): SalesTotals {
  const t = emptyTotals();
  for (const r of rows) for (const k of SALES_METRIC_KEYS) t[k] += r[k] || 0;
  return t;
}

/** Девять значений плиток: шесть сумм и три средних чека (их render). */
export function salesCardValues(t: SalesTotals): number[] {
  return [
    t.sales,
    t.newSales,
    t.repeatSales,
    t.newPayments,
    t.repeatPayments,
    t.salesAmount,
    t.newSales ? t.newPayments / t.newSales : 0,
    t.repeatSales ? t.repeatPayments / t.repeatSales : 0,
    t.sales ? (t.newPayments + t.repeatPayments) / t.sales : 0,
  ];
}

export const SALES_CARD_LABELS = [
  "Продажи абонементов",
  "Новые продажи",
  "Повторные продажи",
  "Оплаты новых",
  "Оплаты повторных продаж",
  "Сумма продаж",
  "Средний чек новых",
  "Средний чек повторных продаж",
  "Средний чек общий",
] as const;

/** Шесть верхних плиток со сравнением, три средних чека — второй строкой. */
export const SALES_TOP_CARDS = 6;

/** Текст плиток: счётчики — числом, суммы — с «₽», который снимает слой оформления. */
export function salesCardTexts(t: SalesTotals, decorated: boolean): string[] {
  return salesCardValues(t).map((v, i) => {
    const text = i < 3 ? salesCount(v) : salesMoney(v);
    return decorated ? stripRuble(text) : text;
  });
}

/**
 * Их dailyTotals: суммы снимка сравнения (dailyMetrics — интервал целиком,
 * день = 31) города и студии.
 */
export function salesDailyTotals(
  p: Pick<SalesPayload, "dailyMetrics">,
  period: string,
  limit: number,
  city: string,
  studio: string,
): SalesTotals {
  const acc = emptyTotals();
  for (const row of p.dailyMetrics[period] ?? []) {
    const [
      day,
      rowCity,
      rowStudio,
      sales,
      newSales,
      repeatSales,
      newPayments,
      repeatPayments,
      amount,
    ] = row;
    if (
      day > limit ||
      (city !== SALES_ALL && rowCity !== city) ||
      (studio !== SALES_ALL && rowStudio !== studio)
    )
      continue;
    acc.sales += sales;
    acc.newSales += newSales;
    acc.repeatSales += repeatSales;
    acc.newPayments += newPayments;
    acc.repeatPayments += repeatPayments;
    acc.salesAmount += amount;
  }
  return acc;
}

/**
 * Сравнение плиток с тем же диапазоном прошлого месяца (их decorate): %
 * округлён, без базы — null («—»). Девять чисел — по плиткам; у средних
 * чеков сравнение у них посчитано, но не показано.
 */
export function salesCardTrends(
  p: Pick<SalesPayload, "dailyMetrics">,
  period: string,
  city: string,
  studio: string,
): (number | null)[] {
  const loaded = (p.dailyMetrics[period] ?? [])
    .map((row) => Number(row[0]))
    .filter(Number.isFinite);
  const days = loaded.length ? Math.max(...loaded) : 31;
  const now = salesCardValues(salesDailyTotals(p, period, days, city, studio));
  const before = salesCardValues(
    salesDailyTotals(p, salesPreviousPeriod(period), days, city, studio),
  );
  return now.map((v, i) => (before[i] ? Math.round((v / before[i] - 1) * 100) : null));
}

/** Подпись сравнения плитки: «↑ +8%», «↓ -1%», без базы — «—». */
export function salesCardTrendText(delta: number | null): {
  arrow: "up" | "down" | null;
  text: string;
} {
  if (delta === null) return { arrow: null, text: "—" };
  const down = delta < 0;
  return { arrow: down ? "down" : "up", text: `${down ? "" : "+"}${delta}%` };
}

export const SALES_CARD_TREND_NOTE = "к тем же дням прошлого месяца";

// --- Сравнения строк таблицы ----------------------------------------------------------

/**
 * Их comparisonAmount: сумма продаж снимка сравнения (dailyRecords) за месяц
 * period до дня limit, город и студия — по индексам справочников.
 */
export function salesComparisonAmount(
  p: Pick<SalesPayload, "cities" | "studios" | "dailyRecords">,
  period: string,
  limit: number,
  city: string,
  studio: string,
): number {
  const cityId = city === SALES_ALL ? null : p.cities.indexOf(city);
  const studioId = studio === SALES_ALL ? null : p.studios.indexOf(studio);
  return p.dailyRecords.reduce((total, row) => {
    const day = Number(row[0].slice(8));
    return row[0].slice(0, 7) === period &&
      day <= limit &&
      (cityId === null || row[1] === cityId) &&
      (studioId === null || row[2] === studioId)
      ? total + row[3]
      : total;
  }, 0);
}

export type SalesTrendCell = {
  text: string;
  /** Их класс up / down: стрелка ↑ / ↓ перед текстом. */
  dir: "up" | "down";
  /** «нет базы» — без стрелки. */
  noBase: boolean;
};

/** Ячейка «К прошлому месяцу / году»: «+154 783 (+88%)», без базы — «нет базы». */
export function salesTrendCell(delta: number, base: number): SalesTrendCell {
  const sign = delta >= 0 ? "+" : "";
  const raw = base
    ? `${sign}${salesMoney(delta)} (${sign}${Math.round((delta / base) * 100)}%)`
    : "нет базы";
  const text = stripRuble(raw);
  return { text, dir: delta >= 0 ? "up" : "down", noBase: text.includes("нет базы") };
}

/** Строка номенклатуры: «—» (их класс up — стрелка ↑ остаётся). */
const PRODUCT_TREND: SalesTrendCell = { text: "—", dir: "up", noBase: false };

// --- Таблица -----------------------------------------------------------------------------

export type SalesSortKey = SalesMetricKey | "avgNew" | "avgRepeat" | "avgAll";
export type SalesSort = { key: SalesSortKey; direction: "desc" | "asc" } | null;

/** Колонки таблицы: подпись, ключ сортировки (у сравнений нет). */
export const SALES_GROUPS = [
  { label: "Продажи", span: 3 },
  { label: "Оплаты и сумма", span: 3 },
  { label: "Средний чек", span: 3 },
  { label: "Динамика суммы продаж", span: 2 },
] as const;

export const SALES_COLUMNS: { label: string; sortKey: SalesSortKey | null }[] = [
  { label: "Всего", sortKey: "sales" },
  { label: "Новые", sortKey: "newSales" },
  { label: "Повторные", sortKey: "repeatSales" },
  { label: "Новых", sortKey: "newPayments" },
  { label: "Повторных продаж", sortKey: "repeatPayments" },
  { label: "Сумма продаж", sortKey: "salesAmount" },
  { label: "Новый", sortKey: "avgNew" },
  { label: "Повторная продажа", sortKey: "avgRepeat" },
  { label: "Общий", sortKey: "avgAll" },
  { label: "К прошлому месяцу", sortKey: null },
  { label: "К прошлому году", sortKey: null },
];

type SortableRow = SalesTotals & { city: string; studio: string };

/** Их sortValue (вторая, действующая версия: по колонке таблицы). */
export function salesSortValue(row: SortableRow, key: SalesSortKey): number {
  if (key === "avgNew") return row.newSales ? row.newPayments / row.newSales : 0;
  if (key === "avgRepeat") return row.repeatSales ? row.repeatPayments / row.repeatSales : 0;
  if (key === "avgAll") return row.sales ? (row.newPayments + row.repeatPayments) / row.sales : 0;
  return row[key] || 0;
}

/** Их sortRows: без сортировки — город и студия по алфавиту, при равенстве — тоже. */
export function salesSortRows<T extends SortableRow>(rows: T[], sort: SalesSort): T[] {
  const fallback = (a: T, b: T) =>
    a.city.localeCompare(b.city, "ru") || a.studio.localeCompare(b.studio, "ru");
  if (!sort) return [...rows].sort(fallback);
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort(
    (a, b) =>
      multiplier * (salesSortValue(a, sort.key) - salesSortValue(b, sort.key)) || fallback(a, b),
  );
}

/** Их cycleTableSort: первое нажатие — по убыванию, второе — по возрастанию, третье — выкл. */
export function cycleSalesSort(sort: SalesSort, key: SalesSortKey): SalesSort {
  if (sort?.key !== key) return { key, direction: "desc" };
  if (sort.direction === "desc") return { key, direction: "asc" };
  return null;
}

type StudioNode = SortableRow & { products: SalesRecord[] };
type CityNode = SortableRow & { studioMap: Map<string, StudioNode> };

/** Их свод строк: город (итог) → студия → номенклатуры, в порядке строк. */
export function salesTree(rows: SalesRecord[]): CityNode[] {
  const cities = new Map<string, CityNode>();
  for (const row of rows) {
    let city = cities.get(row.city);
    if (!city) {
      city = { city: row.city, studio: "Итого по городу", ...emptyTotals(), studioMap: new Map() };
      cities.set(row.city, city);
    }
    let studio = city.studioMap.get(row.studio);
    if (!studio) {
      studio = { city: row.city, studio: row.studio, ...emptyTotals(), products: [] };
      city.studioMap.set(row.studio, studio);
    }
    for (const key of SALES_METRIC_KEYS) {
      city[key] += row[key] || 0;
      studio[key] += row[key] || 0;
    }
    studio.products.push(row);
  }
  return [...cities.values()];
}

/** Ключ раскрытой студии — их `${город} ${студия}`. */
export const salesStudioKey = (city: string, studio: string) => `${city} ${studio}`;

export type SalesTableRow = {
  level: "city" | "studio" | "product";
  /** Ключ строки для React. */
  id: string;
  /** Что раскрывает кнопка строки: город или ключ студии. */
  toggle: string | null;
  expanded: boolean;
  name: string;
  /** Девять чисел: продажи, оплаты и сумма, средние чеки (без «₽»). */
  cells: string[];
  prev: SalesTrendCell;
  year: SalesTrendCell;
};

/** Строки таблицы (их render): раскрытые города и студии, сортировка на каждом уровне. */
export function salesTableRows(
  p: SalesPayload,
  rows: SalesRecord[],
  period: string,
  sort: SalesSort,
  expandedCities: ReadonlySet<string>,
  expandedStudios: ReadonlySet<string>,
): SalesTableRow[] {
  const days = p.periodLastDays[period] || 0;
  const previousPeriod = shiftPeriod(period, -1);
  const lastYearPeriod = shiftPeriod(period, -12);
  const out: SalesTableRow[] = [];
  const row = (
    r: SortableRow,
    level: SalesTableRow["level"],
    name: string,
    id: string,
    toggle: string | null,
    expanded: boolean,
  ): SalesTableRow => {
    const values = salesCardValues(r);
    const cells = values.map((v, i) => stripRuble(i < 3 ? salesCount(v) : salesMoney(v)));
    if (level === "product") {
      return { level, id, toggle, expanded, name, cells, prev: PRODUCT_TREND, year: PRODUCT_TREND };
    }
    const studio = level === "city" ? SALES_ALL : r.studio;
    const prev = salesComparisonAmount(p, previousPeriod, days, r.city, studio);
    const year = salesComparisonAmount(p, lastYearPeriod, days, r.city, studio);
    return {
      level,
      id,
      toggle,
      expanded,
      name,
      cells,
      prev: salesTrendCell(r.salesAmount - prev, prev),
      year: salesTrendCell(r.salesAmount - year, year),
    };
  };
  for (const city of salesSortRows(salesTree(rows), sort)) {
    const cityOpen = expandedCities.has(city.city);
    out.push(row(city, "city", city.city, `c\u0000${city.city}`, city.city, cityOpen));
    if (!cityOpen) continue;
    for (const studio of salesSortRows([...city.studioMap.values()], sort)) {
      const key = salesStudioKey(studio.city, studio.studio);
      const studioOpen = expandedStudios.has(key);
      const id = `s\u0000${studio.city}\u0000${studio.studio}`;
      out.push(row(studio, "studio", studio.studio, id, key, studioOpen));
      if (!studioOpen) continue;
      salesSortRows(studio.products, sort).forEach((product, i) =>
        out.push(row(product, "product", product.product, `${id}\u0000${i}`, null, false)),
      );
    }
  }
  return out;
}

// --- Графики -----------------------------------------------------------------------------

const SHORT_MONTHS = [
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

/** Их shortMonth: «2026-10» → «Окт». */
export const salesShortMonth = (key: string) => SHORT_MONTHS[Number(key.slice(5)) - 1];

export type SalesChartMonth = { key: string; label: string; sales: number; amount: number };

export type SalesCharts = {
  /** Девять месяцев до месяца периода включительно, от старых к новым. */
  months: SalesChartMonth[];
  /** Верх шкалы столбиков и линии (их max(…, 1)). */
  maxSales: number;
  maxAmount: number;
  /** Плашка последнего столбика: «1 698». */
  salesBadge: string;
  /** Плашка последней точки суммы: «38,5 млн» или «987 654». */
  amountBadge: string;
  /** «Структура продаж» за месяц периода. */
  donut: {
    total: string;
    newSales: string;
    repeatSales: string;
    /** Доля новых — дуга кольца, повторные — остаток (1 − доля новых). */
    newShare: number;
    newPercent: string;
    repeatPercent: string;
  };
};

const share = (v: number) => (v * 100).toFixed(1).replace(".", ",");

/**
 * Их renderCharts: продажи и сумма по месяцам (месяц периода — строки
 * периода, прежние — история по месяцам), структура продаж месяца периода.
 * Без месяца периода графиков нет (null).
 */
export function salesCharts(p: SalesPayload, period: string, f: SalesFilters): SalesCharts | null {
  if (!period) return null;
  const match = (r: SalesRecord) =>
    (f.city === SALES_ALL || r.city === f.city) &&
    (f.studio === SALES_ALL || r.studio === f.studio);
  const index = p.periods.findIndex((item) => item.key === period);
  const keys = p.periods
    .slice(index, index + 9)
    .reverse()
    .map((item) => item.key);
  const monthTotals = (key: string) =>
    salesTotals(p.records.filter((r) => r.period === key && match(r)));
  const months = keys.map((key) => {
    const t = monthTotals(key);
    return { key, label: salesShortMonth(key), sales: t.sales, amount: t.salesAmount };
  });
  const current = monthTotals(period);
  const newest = months.at(-1)?.amount || 0;
  const millions =
    newest >= 1_000_000
      ? (newest / 1_000_000).toFixed(1).replace(".", ",") + " млн"
      : fmt.format(newest);
  const newShare = current.sales ? current.newSales / current.sales : 0;
  return {
    months,
    maxSales: Math.max(...months.map((m) => m.sales), 1),
    maxAmount: Math.max(...months.map((m) => m.amount), 1),
    salesBadge: plain.format(months.at(-1)?.sales || 0),
    amountBadge: stripRuble("₽ " + millions),
    donut: {
      total: plain.format(current.sales),
      newSales: plain.format(current.newSales),
      repeatSales: plain.format(current.repeatSales),
      newShare,
      newPercent: share(newShare),
      repeatPercent: share(1 - newShare),
    },
  };
}
