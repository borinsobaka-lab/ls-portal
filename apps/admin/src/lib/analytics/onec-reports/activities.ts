/**
 * Доска «Занятия» — расчёты их activities.html и activities-reference.js
 * (боевой портал аналитики, /1c?report=activities) построчно, без React:
 * распаковка записей, фильтры и их списки (updateOptions), плитки
 * показателей со сравнением с предыдущим периодом (decorate), таблица
 * «город → студия → направление» с режимами «Текущее / К прошлому месяцу /
 * К прошлому году» и их форматы чисел. Их ошибки не исправляем
 * (ANALYTICS.md): «85.3%» с точкой, «+Infinity%» при нулевой базе,
 * «NaN-NaN» у сравнения, когда месяца периода нет в списке месяцев данных.
 */
import type { ActivitiesPayload } from "./payload";

/** Значение «все» у фильтров (их option value="all"). */
export const ALL = "all";

/** Их unpack(): строка данных доски. */
export type ActivityRow = {
  date: string;
  period: string;
  city: string;
  studio: string;
  status: string;
  direction: string;
  held: number;
  scheduled: number;
  attended: number;
};

/** Строка предыдущего периода (payload.previousPeriod.records). */
export type PrecedingRow = ActivitiesPayload["previousPeriod"]["records"][number];

/** Фильтры доски: #status, #city, #studio и выбранные направления. */
export type ActivityFilters = {
  status: string;
  city: string;
  studio: string;
  /** selectedDirections (порядок — порядок отметки). */
  directions: string[];
};

export const NO_FILTERS: ActivityFilters = { status: ALL, city: ALL, studio: ALL, directions: [] };

/** Их #status. */
export const STATUS_OPTIONS = [
  { value: ALL, label: "Все студии" },
  { value: "Открыта", label: "Только открытые" },
  { value: "Закрыта", label: "Только закрытые" },
] as const;

/** Подписи над фильтрами (activities-reference.js). */
export const FILTER_LABELS = {
  city: "Город",
  studio: "Студия",
  direction: "Направление",
  status: "Статус студии",
} as const;

// --- Форматы (их fmt, averageFmt, count, average, rate) ---------------------------

const fmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const averageFmt = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Целое с пробелами разрядов: «10 881». */
export const count = (v: number | null | undefined) => fmt.format(Math.round(v || 0));
/** Один знак после запятой: «5,6». */
export const average = (v: number | null | undefined) => averageFmt.format(v || 0);
/** Доля с точкой (их toFixed): «90.1%»; без базы — «—». */
export const rate = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

// --- Данные и фильтры --------------------------------------------------------------

/** Их unpack() по всем записям (allRows). */
export function unpackActivities(data: ActivitiesPayload): ActivityRow[] {
  return data.records.map((row) => ({
    date: row[0],
    period: row[1],
    city: data.cities[row[2]],
    studio: data.studios[row[3]],
    status: data.studioStatuses[row[3]] || "",
    direction: data.directions[row[4]],
    held: row[5],
    scheduled: row[6],
    attended: row[7],
  }));
}

/** Их els.dateStart / els.dateEnd: интервал периода (onecInitPeriod). */
export type ActivityRange = { start: string; end: string };

export function inRange(r: { date: string }, range: ActivityRange): boolean {
  return (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end);
}

export function matchesFilters(
  r: { status: string; city: string; studio: string; direction: string },
  f: ActivityFilters,
): boolean {
  return (
    (f.status === ALL || r.status === f.status) &&
    (f.city === ALL || r.city === f.city) &&
    (f.studio === ALL || r.studio === f.studio) &&
    (f.directions.length === 0 || f.directions.includes(r.direction))
  );
}

/** Их filterRows(): строки периода по фильтрам. */
export function filterRows(
  rows: ActivityRow[],
  range: ActivityRange,
  f: ActivityFilters,
): ActivityRow[] {
  return rows.filter((r) => inRange(r, range) && matchesFilters(r, f));
}

/** Их options(): уникальные значения по-русски (localeCompare 'ru'). */
const ruSorted = (values: Iterable<string>) =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b, "ru"));

export type ActivityOptions = { cities: string[]; studios: string[]; directions: string[] };

/**
 * Их updateOptions(): списки городов (по статусу), студий (по городу) и
 * направлений (по городу и студии) за период; выбранное, которого нет в
 * новом списке, становится «все», отметки пропавших направлений снимаются.
 */
export function updateOptions(
  rows: ActivityRow[],
  range: ActivityRange,
  f: ActivityFilters,
): { filters: ActivityFilters; options: ActivityOptions } {
  const base = rows.filter((r) => inRange(r, range) && (f.status === ALL || r.status === f.status));
  const cities = ruSorted(base.map((r) => r.city));
  const city = cities.includes(f.city) ? f.city : ALL;
  const studios = ruSorted(
    base.filter((r) => city === ALL || r.city === city).map((r) => r.studio),
  );
  const studio = studios.includes(f.studio) ? f.studio : ALL;
  const available = new Set(
    base
      .filter((r) => (city === ALL || r.city === city) && (studio === ALL || r.studio === studio))
      .map((r) => r.direction),
  );
  return {
    filters: {
      status: f.status,
      city,
      studio,
      directions: f.directions.filter((d) => available.has(d)),
    },
    options: { cities, studios, directions: ruSorted(available) },
  };
}

/**
 * Их server-controls.js при открытии: город, студия и статус из адреса —
 * по очереди, каждый только если он есть в своём списке, и после каждого —
 * updateOptions (статус последним: может сбросить город и студию).
 */
export function restoreFilters(
  rows: ActivityRow[],
  range: ActivityRange,
  search: { city?: string; studio?: string; status?: string },
): { filters: ActivityFilters; options: ActivityOptions } {
  let state = updateOptions(rows, range, NO_FILTERS);
  for (const id of ["city", "studio", "status"] as const) {
    const value = search[id];
    if (!value) continue;
    const allowed: readonly string[] =
      id === "status"
        ? STATUS_OPTIONS.map((o) => o.value)
        : [ALL, ...(id === "city" ? state.options.cities : state.options.studios)];
    if (!allowed.includes(value)) continue;
    state = updateOptions(rows, range, { ...state.filters, [id]: value });
  }
  return state;
}

/** Фильтры в адресе: «все» не пишется (их форма — только выбранное). */
export function filtersSearch(f: ActivityFilters) {
  const or = (v: string) => (v === ALL ? undefined : v);
  return { city: or(f.city), studio: or(f.studio), status: or(f.status) };
}

/** Подпись поля «Направление» (их updateDirectionLabel). */
export function directionLabel(selected: string[]): string {
  const size = selected.length;
  return size === 0 ? "Все направления" : size === 1 ? selected[0] : `Направлений выбрано: ${size}`;
}

/** Счётчик в списке направлений: «Выбрано: 2», без отметок — пусто. */
export const directionCount = (selected: string[]) =>
  selected.length ? `Выбрано: ${selected.length}` : "";

/** Их поиск по списку (города, направления): без регистра, подстрока. */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("ru");
  return !q || text.toLocaleLowerCase("ru").includes(q);
}

// --- Сравнения ----------------------------------------------------------------------

/** Их shiftPeriod: «ГГГГ-ММ» ± месяцы (пустой месяц даёт «NaN-NaN»). */
export function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const value = year * 12 + month - 1 + delta;
  return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
}

/**
 * Их els.period.value: месяц начала периода, если он есть в списке месяцев
 * данных (payload.periods), иначе пусто — и сравнений в таблице нет.
 */
export function comparisonPeriod(data: ActivitiesPayload): string {
  return data.periods.some((p) => p.key === data.currentPeriod) ? data.currentPeriod : "";
}

/** Их periodRows(): строки сравнения за месяц-метку по фильтрам. */
export function periodRows(rows: ActivityRow[], period: string, f: ActivityFilters): ActivityRow[] {
  return rows.filter((r) => r.period === period && matchesFilters(r, f));
}

// --- Плитки (render + decorate) -------------------------------------------------

type Counts = { held: number; scheduled: number; attended: number };
const sumOf = (rows: Counts[], key: keyof Counts) =>
  rows.reduce((total, row) => total + (row[key] || 0), 0);

/** Их activityMetrics: суммы, средние на занятие и доходимость (null — нет базы). */
export function activityMetrics(rows: Counts[]): (number | null)[] {
  let held = 0;
  let scheduled = 0;
  let attended = 0;
  for (const row of rows) {
    held += row.held;
    scheduled += row.scheduled;
    attended += row.attended;
  }
  return [
    held,
    scheduled,
    attended,
    held ? scheduled / held : null,
    held ? attended / held : null,
    scheduled ? attended / scheduled : null,
  ];
}

/** Их activityDeltas: изменение к предыдущему периоду в %, null — нет базы. */
export function activityDeltas(
  current: (number | null)[],
  previous: (number | null)[],
): (number | null)[] {
  return current.map((value, index) => {
    const base = previous[index];
    return value === null || base === null || base === 0 ? null : (value / base - 1) * 100;
  });
}

export type DeltaKind = "up" | "down" | "flat" | "missing";

export type ActivityKpi = {
  label: string;
  value: string;
  change: { kind: DeltaKind; text: string };
  /** Их всплывающая подсказка у сравнения (нет предыдущего периода — нет). */
  title?: string;
};

export const KPI_LABELS = [
  "Занятий проведено",
  "Клиентов записано",
  "Клиентов посетило",
  "Среднее записано на занятие",
  "Среднее посетило на занятие",
  "Доходимость",
] as const;

/**
 * Плитки: значения — их render() по строкам периода, сравнение — их
 * decorate() с предыдущим периодом той же длины (payload.previousPeriod по
 * тем же фильтрам): «+1,3%» / «−0,4%» (минус — U+2212), у доходимости тоже
 * в %, а разница в п. п. — в подсказке.
 */
export function activityKpis(
  rows: ActivityRow[],
  precedingRows: PrecedingRow[],
  preceding?: { start: string; end: string },
): ActivityKpi[] {
  const held = sumOf(rows, "held");
  const scheduled = sumOf(rows, "scheduled");
  const attended = sumOf(rows, "attended");
  const values = [
    count(held),
    count(scheduled),
    count(attended),
    held ? average(scheduled / held) : "—",
    held ? average(attended / held) : "—",
    rate(attended, scheduled),
  ];
  const current = activityMetrics(rows);
  const previous = precedingRows.length
    ? activityMetrics(precedingRows)
    : [null, null, null, null, null, null];
  const changes = activityDeltas(current, previous);
  return KPI_LABELS.map((label, index) => {
    const change = changes[index];
    const kind: DeltaKind =
      change === null ? "missing" : Math.abs(change) < 1e-10 ? "flat" : change > 0 ? "up" : "down";
    const text =
      change === null
        ? "—"
        : (change > 1e-10 ? "+" : change < -1e-10 ? "−" : "") +
          averageFmt.format(Math.abs(change)) +
          "%";
    const title = preceding
      ? "Предыдущий период: " +
        preceding.start +
        " — " +
        preceding.end +
        (change === null
          ? " · нет базы для сравнения"
          : index === 5
            ? " · изменение в п.п.: " +
              averageFmt.format(((current[5] as number) - (previous[5] as number)) * 100)
            : "")
      : undefined;
    return { label, value: values[index], change: { kind, text }, title };
  });
}

// --- Таблица ------------------------------------------------------------------------

export type TableMode = "current" | "month" | "year";

export const TABLE_MODES: { value: TableMode; label: string }[] = [
  { value: "current", label: "Текущее" },
  { value: "month", label: "К прошлому месяцу" },
  { value: "year", label: "К прошлому году" },
];

type GroupField = "city" | "studio" | "direction";

export type ActivityGroup = Counts & { city: string; studio: string; direction: string };

/** Ключ группы — их join('\x01'). */
const groupKey = (item: Partial<Record<GroupField, string>>, fields: GroupField[]) =>
  fields.map((field) => item[field]).join("\x01");

/** Их aggregate(): суммы по разрезу, в порядке первого появления. */
export function aggregateActivities(rows: ActivityRow[], fields: GroupField[]): ActivityGroup[] {
  const result = new Map<string, ActivityGroup>();
  for (const row of rows) {
    const key = groupKey(row, fields);
    let item = result.get(key);
    if (!item) {
      item = { held: 0, scheduled: 0, attended: 0, city: "", studio: "", direction: "" };
      for (const field of fields) item[field] = row[field];
      result.set(key, item);
    }
    item.held += row.held;
    item.scheduled += row.scheduled;
    item.attended += row.attended;
  }
  return [...result.values()];
}

const indexGroups = (rows: ActivityRow[], fields: GroupField[]) =>
  new Map(aggregateActivities(rows, fields).map((item) => [groupKey(item, fields), item]));

type ItemMetrics = { scheduled: number; attended: number; attendance: number };
export type ActivityMetric = keyof ItemMetrics;

/** Их itemMetrics: средние на занятие и доходимость (без занятий — null). */
export function itemMetrics(item: Counts | undefined): ItemMetrics | null {
  return item && item.held
    ? {
        scheduled: item.scheduled / item.held,
        attended: item.attended / item.held,
        attendance: item.attended / item.scheduled,
      }
    : null;
}

export type TrendCell = { text: string; kind: "up" | "down" | "" };

/** Их trend(): «+0,4 (+7.1%)», у доходимости — «−1,2 п.п.». */
export function trend(
  metric: ActivityMetric,
  current: ItemMetrics | null,
  base: ItemMetrics | null,
): TrendCell {
  if (!current || !base) return { text: "—", kind: "" };
  const delta =
    metric === "attendance"
      ? (current[metric] - base[metric]) * 100
      : current[metric] - base[metric];
  const sign = delta > 0 ? "+" : "";
  const text =
    metric === "attendance"
      ? `${sign}${average(delta)} п.п.`
      : `${sign}${average(delta)} (${sign}${((delta / base[metric]) * 100).toFixed(1)}%)`;
  return { text, kind: delta > 0 ? "up" : delta < 0 ? "down" : "" };
}

/** Их comparisonCell(): значение или изменение к прошлому месяцу / году. */
export function comparisonCell(
  item: Counts,
  previous: Counts | undefined,
  lastYear: Counts | undefined,
  metric: ActivityMetric,
  mode: TableMode,
): TrendCell {
  const current = itemMetrics(item);
  if (mode === "current") {
    const text = !current
      ? "—"
      : metric === "attendance"
        ? rate(item.attended, item.scheduled)
        : average(current[metric]);
    return { text, kind: "" };
  }
  const reference = mode === "month" ? previous : lastYear;
  return trend(metric, current, itemMetrics(reference));
}

export type ActivityLine = {
  level: GroupField;
  /** Уникальный ключ строки; у города и студии — ключ раскрытия. */
  key: string;
  name: string;
  /** Статус студии (их status-label), только у студии. */
  status: string;
  /** Раскрыта ли строка (город, студия). */
  expanded: boolean;
  held: string;
  scheduled: string;
  attended: string;
  /** Среднее записано, среднее посетило, доходимость. */
  cells: [TrendCell, TrendCell, TrendCell];
};

/** Статус студии для подписи в таблице — их studioStatuses[studios.indexOf(…)]. */
export function studioStatusOf(data: ActivitiesPayload): (studio: string) => string {
  return (studio) => data.studioStatuses[data.studios.indexOf(studio)] || "";
}

/** Ключ раскрытия студии — их item.city + '\x01' + item.studio. */
export const studioKey = (city: string, studio: string) => city + "\x01" + studio;

/**
 * Их renderTable(): города по алфавиту, у раскрытого города — его студии,
 * у раскрытой студии — направления; сравнения — с теми же разрезами
 * строк прошлого месяца и прошлого года.
 */
export function activityTable(
  rows: ActivityRow[],
  previousRows: ActivityRow[],
  lastYearRows: ActivityRow[],
  mode: TableMode,
  expandedCities: ReadonlySet<string>,
  expandedStudios: ReadonlySet<string>,
  statusOf: (studio: string) => string,
): ActivityLine[] {
  const cityFields: GroupField[] = ["city"];
  const studioFields: GroupField[] = ["city", "studio"];
  const directionFields: GroupField[] = ["city", "studio", "direction"];
  const previous = {
    city: indexGroups(previousRows, cityFields),
    studio: indexGroups(previousRows, studioFields),
    direction: indexGroups(previousRows, directionFields),
  };
  const year = {
    city: indexGroups(lastYearRows, cityFields),
    studio: indexGroups(lastYearRows, studioFields),
    direction: indexGroups(lastYearRows, directionFields),
  };
  const line = (
    item: ActivityGroup,
    level: GroupField,
    fields: GroupField[],
    name: string,
    key: string,
    expanded: boolean,
    status: string,
  ): ActivityLine => {
    const k = groupKey(item, fields);
    const prev = previous[level].get(k);
    const last = year[level].get(k);
    return {
      level,
      key,
      name,
      status,
      expanded,
      held: count(item.held),
      scheduled: count(item.scheduled),
      attended: count(item.attended),
      cells: [
        comparisonCell(item, prev, last, "scheduled", mode),
        comparisonCell(item, prev, last, "attended", mode),
        comparisonCell(item, prev, last, "attendance", mode),
      ],
    };
  };

  const lines: ActivityLine[] = [];
  const cities = aggregateActivities(rows, cityFields).sort((a, b) =>
    a.city.localeCompare(b.city, "ru"),
  );
  for (const city of cities) {
    const cityOpen = expandedCities.has(city.city);
    lines.push(line(city, "city", cityFields, city.city, city.city, cityOpen, ""));
    if (!cityOpen) continue;
    const studios = aggregateActivities(
      rows.filter((r) => r.city === city.city),
      studioFields,
    ).sort((a, b) => a.studio.localeCompare(b.studio, "ru"));
    for (const studio of studios) {
      const key = studioKey(studio.city, studio.studio);
      const studioOpen = expandedStudios.has(key);
      lines.push(
        line(
          studio,
          "studio",
          studioFields,
          studio.studio,
          key,
          studioOpen,
          statusOf(studio.studio),
        ),
      );
      if (!studioOpen) continue;
      const directions = aggregateActivities(
        rows.filter((r) => r.city === studio.city && r.studio === studio.studio),
        directionFields,
      ).sort((a, b) => a.direction.localeCompare(b.direction, "ru"));
      for (const direction of directions) {
        lines.push(
          line(
            direction,
            "direction",
            directionFields,
            direction.direction,
            key + "\x01" + direction.direction,
            false,
            "",
          ),
        );
      }
    }
  }
  return lines;
}
