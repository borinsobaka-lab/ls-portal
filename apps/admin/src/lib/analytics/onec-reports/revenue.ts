/**
 * Доска «Выручка» — логика их revenue.html (боевой портал аналитики,
 * /1c?report=revenue) без React: формат денег, плитки сводки, колонки,
 * сортировка по клику на заголовок, поиск и фильтр статуса, раскрытие
 * городов, суммы города по видимым студиям. Перенесено как есть, вместе с
 * особенностями (ANALYTICS_PLAN.md, §9 — не «чинить»):
 *
 * - сортировка: первый клик — по убыванию, второй — по возрастанию, третий —
 *   выключает; при равенстве — по названию (localeCompare "ru");
 * - города сортируются по своим полным суммам, даже когда фильтр статуса
 *   показывает суммы только открытых или закрытых студий;
 * - при фильтре статуса прогноз города — сумма прогнозов студий: вне
 *   периода с 1-го числа это 0, а не «—»;
 * - «Итого месяца» — первый месяц истории (месяц даты окончания), а не
 *   выбранный период; недели — выбранный период;
 * - отрицательное число, округлённое до 0, — «0» красным.
 */
import type { RevenuePayload, RevenueRow } from "./payload";

// --- Формат (их money / cell) -----------------------------------------------------

const formatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Их money(): null — «—», иначе целое с пробелами по разрядам и «-» у минуса. */
export function revenueMoney(value: number | null | undefined): string {
  if (value === null) return "—";
  const rounded = Math.round(value || 0);
  if (rounded === 0) return "0";
  return (rounded < 0 ? "-" : "") + formatter.format(Math.abs(rounded));
}

/** Их cell(): нет значения — приглушённое «—»; меньше нуля — красное. */
export function revenueCell(value: number | null | undefined): {
  text: string;
  muted: boolean;
  negative: boolean;
} {
  if (value === null || value === undefined) return { text: "—", muted: true, negative: false };
  return { text: revenueMoney(value), muted: false, negative: value < 0 };
}

// --- Сводка (их renderSummary) ----------------------------------------------------

export type RevenueMetric = { key: string; label: string; value: string; note: string };

export function revenueSummary(data: RevenuePayload): RevenueMetric[] {
  const s = data.summary;
  return [
    {
      key: "current",
      label: "Факт текущего месяца",
      value: revenueMoney(s.totalCurrent),
      note: "по текущему месяцу",
    },
    {
      key: "forecast",
      label: "Прогноз месяца",
      value: revenueMoney(s.totalForecast),
      note: "по текущему темпу",
    },
    {
      key: "open",
      label: "Факт открытые",
      value: revenueMoney(s.openCurrent),
      note: "активные студии",
    },
    {
      key: "closed",
      label: "Факт закрытые",
      value: revenueMoney(s.closedCurrent),
      note: "без изменений",
    },
    { key: "cities", label: "Городов", value: String(s.cities), note: "в отчёте" },
    {
      key: "studios",
      label: "Студий всего",
      value: `${s.studios} / открытых ${s.openStudios}`,
      note: "по справочнику",
    },
  ];
}

// --- Фильтр статуса ---------------------------------------------------------------

export type RevenueStatus = "all" | "Открыта" | "Закрыта";

/** Их select#statusFilter. */
export const REVENUE_STATUS_OPTIONS: { value: RevenueStatus; label: string }[] = [
  { value: "all", label: "Все студии" },
  { value: "Открыта", label: "Только открытые" },
  { value: "Закрыта", label: "Только закрытые" },
];

/** Значение фильтра из адреса: неизвестное — «Все студии». */
export function parseRevenueStatus(value: string | undefined): RevenueStatus {
  return REVENUE_STATUS_OPTIONS.some((o) => o.value === value) ? (value as RevenueStatus) : "all";
}

// --- Сортировка (их tableSort) ----------------------------------------------------

export type RevenueSortKey =
  | "forecast"
  | "break-even"
  | "break-even-delta"
  | `bucket:${string}`
  | `month:${string}`;
export type RevenueSort = { key: RevenueSortKey; direction: "asc" | "desc" } | null;

/** Их cycleTableSort: новая колонка — по убыванию, затем по возрастанию, затем выкл. */
export function cycleRevenueSort(sort: RevenueSort, key: RevenueSortKey): RevenueSort {
  if (sort?.key !== key) return { key, direction: "desc" };
  if (sort.direction === "desc") return { key, direction: "asc" };
  return null;
}

/** Их sortValue. */
export function revenueSortValue(row: RevenueRow, sort: RevenueSort): number {
  if (!sort) return 0;
  const key = sort.key;
  if (key === "forecast") return row.forecast || 0;
  if (key === "break-even") return row.breakEven ?? 0;
  if (key === "break-even-delta") return row.breakEvenDelta ?? 0;
  if (key.startsWith("bucket:")) return row.buckets[key.slice(7)] || 0;
  if (key.startsWith("month:")) return row.months[key.slice(6)] || 0;
  return 0;
}

/** Их sortRows: без сортировки — порядок данных; при равенстве — по названию. */
export function sortRevenueRows(rows: RevenueRow[], sort: RevenueSort): RevenueRow[] {
  if (!sort) return [...rows];
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort(
    (left, right) =>
      multiplier * (revenueSortValue(left, sort) - revenueSortValue(right, sort)) ||
      left.name.localeCompare(right.name, "ru"),
  );
}

// --- Колонки (их renderHead / appendDataCells) ------------------------------------

export type RevenueColumnKind =
  | "bucket"
  | "current-month"
  | "forecast"
  | "break-even"
  | "break-even-delta"
  | "month";

export type RevenueColumn = {
  id: string;
  kind: RevenueColumnKind;
  /** Подпись; у двухстрочных — верхняя строка. */
  label: string;
  /** Нижняя строка двухстрочного заголовка. */
  sub?: string;
  /** Нет — колонка не сортируется (у них «Прогноз месяца»). */
  sortKey?: RevenueSortKey;
  /** Колонки текущего месяца — их прячет «Свернуть текущий месяц». */
  currentMonth: boolean;
  /** «Точка 0» — видны после «Показать точку 0». */
  breakEven: boolean;
  value: (row: RevenueRow) => number | null | undefined;
};

export function revenueColumns(data: RevenuePayload): RevenueColumn[] {
  const columns: RevenueColumn[] = data.bucketHeaders.map((bucket) => ({
    id: `bucket:${bucket}`,
    kind: "bucket",
    label: bucket,
    sortKey: `bucket:${bucket}`,
    currentMonth: true,
    breakEven: false,
    value: (row) => row.buckets[bucket],
  }));
  const currentMonth = data.monthHeaders[0];
  if (currentMonth) {
    columns.push({
      id: "current-month",
      kind: "current-month",
      label: "Итого месяца",
      sub: currentMonth.label,
      sortKey: `month:${currentMonth.key}`,
      currentMonth: true,
      breakEven: false,
      value: (row) => row.months[currentMonth.key],
    });
  }
  columns.push(
    {
      id: "forecast",
      kind: "forecast",
      label: "Прогноз",
      sub: "месяца",
      currentMonth: true,
      breakEven: false,
      value: (row) => row.forecast,
    },
    {
      id: "break-even",
      kind: "break-even",
      label: "Точка 0",
      sortKey: "break-even",
      currentMonth: false,
      breakEven: true,
      value: (row) => row.breakEven,
    },
    {
      id: "break-even-delta",
      kind: "break-even-delta",
      label: "Факт − точка 0",
      sortKey: "break-even-delta",
      currentMonth: false,
      breakEven: true,
      value: (row) => row.breakEvenDelta,
    },
  );
  for (const month of data.monthHeaders.slice(1)) {
    const [monthName, year] = month.label.split(" ");
    columns.push({
      id: `month:${month.key}`,
      kind: "month",
      label: monthName,
      sub: year,
      sortKey: `month:${month.key}`,
      currentMonth: false,
      breakEven: false,
      value: (row) => row.months[month.key],
    });
  }
  return columns;
}

/** Колонки на экране: их .current-month-hidden и .break-even-hidden. */
export function visibleRevenueColumns(
  columns: RevenueColumn[],
  view: { currentMonthVisible: boolean; breakEvenVisible: boolean },
): RevenueColumn[] {
  return columns.filter(
    (c) => (view.currentMonthVisible || !c.currentMonth) && (view.breakEvenVisible || !c.breakEven),
  );
}

// --- Строки (их rowMatches / sumChildRows / renderBody) ---------------------------

/** Их rowMatches; query — уже trim().toLowerCase(). */
export function revenueRowMatches(
  row: RevenueRow,
  query: string,
  statusFilter: RevenueStatus,
): boolean {
  const haystack = `${row.name} ${row.group || ""} ${row.status || ""}`.toLowerCase();
  if (query && !haystack.includes(query)) return false;
  if (row.type === "studio" && statusFilter !== "all" && row.status !== statusFilter) return false;
  if (row.type === "network" && statusFilter !== "all" && row.status !== statusFilter) return false;
  return true;
}

/**
 * Их sumChildRows: строка города по видимым студиям (фильтр статуса).
 * «Точка 0» задана городу, не студии, — остаётся городской.
 */
export function sumChildRows(
  data: RevenuePayload,
  baseRow: RevenueRow,
  childRows: RevenueRow[],
): RevenueRow {
  const row: RevenueRow = {
    ...baseRow,
    buckets: {},
    months: {},
    current: 0,
    forecast: 0,
    breakEven: baseRow.breakEven,
    breakEvenDelta: baseRow.breakEven == null ? null : 0,
  };
  for (const bucket of data.bucketHeaders) {
    row.buckets[bucket] = childRows.reduce((sum, child) => sum + (child.buckets[bucket] || 0), 0);
  }
  for (const month of data.monthHeaders) {
    row.months[month.key] = childRows.reduce(
      (sum, child) => sum + (child.months[month.key] || 0),
      0,
    );
  }
  row.current = childRows.reduce((sum, child) => sum + (child.current || 0), 0);
  row.forecast = childRows.reduce((sum, child) => sum + (child.forecast || 0), 0);
  row.breakEvenDelta = row.breakEven == null ? null : row.current - row.breakEven;
  return row;
}

export type RevenueBodyRow =
  | { kind: "network"; key: string; row: RevenueRow }
  | { kind: "city"; key: string; row: RevenueRow; expanded: boolean }
  | { kind: "studio"; key: string; row: RevenueRow };

/** Их renderBody: итог сети, города (по сортировке) и раскрытые студии. */
export function revenueBodyRows(
  data: RevenuePayload,
  view: {
    search: string;
    statusFilter: RevenueStatus;
    expanded: ReadonlySet<string>;
    sort: RevenueSort;
  },
): RevenueBodyRow[] {
  const query = view.search.trim().toLowerCase();
  const { statusFilter, expanded, sort } = view;
  const out: RevenueBodyRow[] = [];

  for (const networkRow of data.networkRows) {
    const shouldShowNetworkRow =
      (statusFilter === "all" && networkRow.status === "Все") ||
      (statusFilter !== "all" && networkRow.status === statusFilter);
    if (shouldShowNetworkRow && revenueRowMatches(networkRow, query, statusFilter)) {
      out.push({ kind: "network", key: `network:${networkRow.name}`, row: networkRow });
    }
  }

  for (const cityRow of sortRevenueRows(data.rows, sort)) {
    const studioRows = data.studios[cityRow.name] || [];
    const visibleStudios = sortRevenueRows(
      studioRows.filter((row) => revenueRowMatches(row, query, statusFilter)),
      sort,
    );
    const cityMatches = revenueRowMatches(cityRow, query, "all");

    if (!cityMatches && visibleStudios.length === 0) continue;
    if (statusFilter !== "all" && visibleStudios.length === 0) continue;
    const displayCityRow =
      statusFilter === "all" ? cityRow : sumChildRows(data, cityRow, visibleStudios);
    out.push({
      kind: "city",
      key: `city:${cityRow.name}`,
      row: displayCityRow,
      expanded: expanded.has(cityRow.name),
    });

    const shouldShowStudios = expanded.has(cityRow.name) || (query && visibleStudios.length > 0);
    if (shouldShowStudios) {
      visibleStudios.forEach((studioRow, index) =>
        out.push({
          kind: "studio",
          key: `studio:${cityRow.name}:${index}:${studioRow.name}`,
          row: studioRow,
        }),
      );
    }
  }
  return out;
}

/** Их «Раскрыть все»: все города отчёта. */
export const allRevenueCities = (data: RevenuePayload) => new Set(data.rows.map((r) => r.name));

/** Подпись статуса после названия строки (у итога сети «Все» не пишется). */
export function revenueStatusLabel(row: RevenueRow): string {
  if (row.type === "network") return row.status === "Все" ? "" : (row.status ?? "");
  return row.status || "";
}
