/**
 * «Воронка пробных» — расчёты их доски funnel.html (боевой портал аналитики,
 * /1c?report=funnel, с поведенческим слоем funnel-reference.js) без React:
 * распаковка записей, каскад фильтров «Статус студии» → «Город» → «Студия»
 * → «Направление», плитки, дерево город → студия → направление и формат
 * чисел. Логика и её особенности — как у них, построчно (ANALYTICS_PLAN.md,
 * §9 — не «чинить»):
 * - доля — `toFixed(1)` с точкой («57.0%»), при нулевой базе — «—»;
 * - число — ru-RU без дробной части после Math.round (−0,4 → «-0»);
 * - конверсия «в день» и «за 14 дней» делится не на «Пришли», а на свои
 *   базы v3 / v5 (их «База конверсии»), «Ожидают 14 дней» (v8) не
 *   показывается нигде;
 * - сортировка названий — localeCompare('ru') (без числового сравнения:
 *   «10» раньше «9»), одинаковые — в порядке записей;
 * - выбранное значение фильтра, которого нет в новом списке, сбрасывается
 *   во «все» насовсем (их opt / renderDirections), раскрытые строки таблицы
 *   при смене фильтров не сворачиваются.
 */
import type { FunnelPayload } from "./payload";

/** Их unpack(): запись доски. */
export type FunnelRow = {
  date: string;
  period: string;
  city: string;
  studio: string;
  status: string;
  direction: string;
  scheduled: number;
  attended: number;
  closedDay: number;
  boughtDay: number;
  closed14: number;
  bought14: number;
  boughtLater: number;
};

const TOTAL_KEYS = [
  "scheduled",
  "attended",
  "closedDay",
  "boughtDay",
  "closed14",
  "bought14",
  "boughtLater",
] as const;
type TotalKey = (typeof TOTAL_KEYS)[number];
export type FunnelTotals = Record<TotalKey, number>;

/** Значение «все» у их селектов. */
export const FUNNEL_ALL = "all";

/** Их select#status: значение — статус студии из 1С. */
export const FUNNEL_STATUS_OPTIONS = [
  { value: FUNNEL_ALL, label: "Все студии" },
  { value: "Открыта", label: "Только открытые" },
  { value: "Закрыта", label: "Только закрытые" },
] as const;

export const FUNNEL_ALL_CITIES = "Все города";
export const FUNNEL_ALL_STUDIOS = "Все студии";

/** Колонки таблицы — их thead, слово в слово. */
export const FUNNEL_COLUMNS = [
  "Записались",
  "Пришли",
  "Доходимость",
  "Купили в день пробного",
  "Конверсия продажи в день пробного",
  "Купили в течение 14 дней с пробного",
  "Конверсия продажи в течение 14 дней с пробного",
  "Купили не в день пробного",
] as const;

// --- Формат (их fmt / count / rate) ----------------------------------------------

const fmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Их count: целое ru-RU, пусто — 0. */
export const funnelCount = (v: number) => fmt.format(Math.round(v || 0));

/** Их rate: доля в процентах с точкой и одним знаком, без базы — «—». */
export const funnelRate = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

// --- Записи и период -------------------------------------------------------------

/** Их unpack по всем записям: индексы → названия, v1…v7 (v8 доска не читает). */
export function unpackFunnel(payload: FunnelPayload): FunnelRow[] {
  return payload.records.map((r) => {
    const studio = r[3] as number;
    return {
      date: r[0] as string,
      period: r[1] as string,
      city: payload.cities[r[2] as number],
      studio: payload.studios[studio],
      status: payload.studioStatuses[studio] || "",
      direction: payload.directions[r[4] as number],
      scheduled: r[5] as number,
      attended: r[6] as number,
      closedDay: r[7] as number,
      boughtDay: r[8] as number,
      closed14: r[9] as number,
      bought14: r[10] as number,
      boughtLater: r[11] as number,
    };
  });
}

/** Что отдаёт их onecInitPeriod: период запроса и его месяц. */
export type FunnelRange = { start: string; end: string; months: string[] };

export const funnelRange = (payload: FunnelPayload): FunnelRange => ({
  start: payload.start,
  end: payload.end,
  months: [payload.currentPeriod],
});

/** Их inRange: месяц из выбранных (пусто — любой) и дата в границах. */
export const funnelInRange = (r: FunnelRow, range: FunnelRange) =>
  (range.months.length === 0 || range.months.includes(r.period)) &&
  (!range.start || r.date >= range.start) &&
  (!range.end || r.date <= range.end);

// --- Фильтры ---------------------------------------------------------------------

/** Значения фильтров: селекты и отмеченные направления (в порядке отметки). */
export type FunnelFilters = {
  status: string;
  city: string;
  studio: string;
  directions: string[];
};

export const FUNNEL_NO_FILTERS: FunnelFilters = {
  status: FUNNEL_ALL,
  city: FUNNEL_ALL,
  studio: FUNNEL_ALL,
  directions: [],
};

const byName = (a: string, b: string) => a.localeCompare(b, "ru");
const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort(byName);

export type FunnelOptions = {
  /** Фильтры после сверки со списками (их opt / renderDirections). */
  filters: FunnelFilters;
  cities: string[];
  studios: string[];
  directions: string[];
};

/**
 * Их updateOptions: списки городов (по статусу), студий (и по городу) и
 * направлений (и по студии); выбранное, которого в списке нет, — «все».
 */
export function funnelOptions(
  rows: FunnelRow[],
  range: FunnelRange,
  filters: FunnelFilters,
): FunnelOptions {
  const base = rows.filter(
    (r) =>
      funnelInRange(r, range) && (filters.status === FUNNEL_ALL || r.status === filters.status),
  );
  const cities = sortedUnique(base.map((r) => r.city));
  const city =
    filters.city === FUNNEL_ALL || cities.includes(filters.city) ? filters.city : FUNNEL_ALL;
  const inCity = base.filter((r) => city === FUNNEL_ALL || r.city === city);
  const studios = sortedUnique(inCity.map((r) => r.studio));
  const studio =
    filters.studio === FUNNEL_ALL || studios.includes(filters.studio) ? filters.studio : FUNNEL_ALL;
  const directions = sortedUnique(
    inCity.filter((r) => studio === FUNNEL_ALL || r.studio === studio).map((r) => r.direction),
  );
  return {
    filters: {
      status: filters.status,
      city,
      studio,
      directions: filters.directions.filter((d) => directions.includes(d)),
    },
    cities,
    studios,
    directions,
  };
}

export type FunnelSelectKey = "city" | "studio" | "status";

/** Смена селекта (их change → updateOptions): новые фильтры, сверенные со списками. */
export function funnelSelect(
  rows: FunnelRow[],
  range: FunnelRange,
  filters: FunnelFilters,
  key: FunnelSelectKey,
  value: string,
): FunnelFilters {
  return funnelOptions(rows, range, { ...filters, [key]: value }).filters;
}

/** Отметка направления (их change у чекбокса — без пересчёта списков). */
export function funnelToggleDirection(
  filters: FunnelFilters,
  direction: string,
  checked: boolean,
): FunnelFilters {
  const rest = filters.directions.filter((d) => d !== direction);
  return { ...filters, directions: checked ? [...rest, direction] : rest };
}

/** Их «Сбросить выбор»: направления снимаются, списки пересчитываются. */
export function funnelClearDirections(
  rows: FunnelRow[],
  range: FunnelRange,
  filters: FunnelFilters,
): FunnelFilters {
  return funnelOptions(rows, range, { ...filters, directions: [] }).filters;
}

/**
 * Фильтры из адреса — их server-controls.js после загрузки: по очереди
 * город, студия, статус; значение ставится, только если оно есть в списке
 * селекта в этот момент, и каждое пересчитывает списки.
 */
export function funnelRestore(
  rows: FunnelRow[],
  range: FunnelRange,
  search: Partial<Record<FunnelSelectKey, string>>,
): FunnelFilters {
  let filters = funnelOptions(rows, range, FUNNEL_NO_FILTERS).filters;
  for (const key of ["city", "studio", "status"] as const) {
    const value = search[key];
    if (!value) continue;
    const { cities, studios } = funnelOptions(rows, range, filters);
    const choices =
      key === "city"
        ? [FUNNEL_ALL, ...cities]
        : key === "studio"
          ? [FUNNEL_ALL, ...studios]
          : FUNNEL_STATUS_OPTIONS.map((o) => o.value as string);
    if (choices.includes(value)) filters = funnelSelect(rows, range, filters, key, value);
  }
  return filters;
}

/** Что держать в адресе (их форма периода передаёт селекты не «all»). */
export const funnelSearchFilters = (f: FunnelFilters) => ({
  city: f.city === FUNNEL_ALL ? undefined : f.city,
  studio: f.studio === FUNNEL_ALL ? undefined : f.studio,
  status: f.status === FUNNEL_ALL ? undefined : f.status,
});

/** Их rows(): записи под всеми фильтрами. */
export function funnelFiltered(
  rows: FunnelRow[],
  range: FunnelRange,
  f: FunnelFilters,
): FunnelRow[] {
  return rows.filter(
    (r) =>
      funnelInRange(r, range) &&
      (f.status === FUNNEL_ALL || r.status === f.status) &&
      (f.city === FUNNEL_ALL || r.city === f.city) &&
      (f.studio === FUNNEL_ALL || r.studio === f.studio) &&
      (f.directions.length === 0 || f.directions.includes(r.direction)),
  );
}

/** Подпись поля направлений (их updateDirectionLabel). */
export function funnelDirectionLabel(selected: string[]): string {
  return selected.length === 0
    ? "Все направления"
    : selected.length === 1
      ? selected[0]
      : `Направлений выбрано: ${selected.length}`;
}

/** Счётчик рядом со «Сбросить выбор»: пусто, если ничего не отмечено. */
export const funnelDirectionCount = (selected: string[]) =>
  selected.length ? `Выбрано: ${selected.length}` : "";

/** Их поиск в списках города и направлений: без регистра, по вхождению. */
export function funnelMatches(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("ru");
  return text.toLocaleLowerCase("ru").includes(q);
}

// --- Плитки ----------------------------------------------------------------------

const emptyTotals = (): FunnelTotals => ({
  scheduled: 0,
  attended: 0,
  closedDay: 0,
  boughtDay: 0,
  closed14: 0,
  bought14: 0,
  boughtLater: 0,
});

/** Их sum по каждому показателю. */
export function funnelTotals(rows: FunnelRow[]): FunnelTotals {
  const t = emptyTotals();
  for (const key of TOTAL_KEYS) t[key] = rows.reduce((x, r) => x + r[key], 0);
  return t;
}

/** Их cards в render(): подпись и значение, в их порядке. */
export function funnelCards(t: FunnelTotals): { label: string; value: string }[] {
  return [
    { label: "Записались на пробное", value: funnelCount(t.scheduled) },
    { label: "Пришли на пробное", value: funnelCount(t.attended) },
    { label: "Доходимость", value: funnelRate(t.attended, t.scheduled) },
    { label: "Купили в день пробного", value: funnelCount(t.boughtDay) },
    { label: "Конверсия продажи в день пробного", value: funnelRate(t.boughtDay, t.closedDay) },
    { label: "Купили в течение 14 дней с пробного", value: funnelCount(t.bought14) },
    {
      label: "Конверсия продажи в течение 14 дней с пробного",
      value: funnelRate(t.bought14, t.closed14),
    },
    { label: "Купили не в день пробного", value: funnelCount(t.boughtLater) },
  ];
}

/** Ячейки строки таблицы — их tr(): числа и доли в порядке FUNNEL_COLUMNS. */
export function funnelCells(t: FunnelTotals): { value: string; rate: boolean }[] {
  return [
    { value: funnelCount(t.scheduled), rate: false },
    { value: funnelCount(t.attended), rate: false },
    { value: funnelRate(t.attended, t.scheduled), rate: true },
    { value: funnelCount(t.boughtDay), rate: false },
    { value: funnelRate(t.boughtDay, t.closedDay), rate: true },
    { value: funnelCount(t.bought14), rate: false },
    { value: funnelRate(t.bought14, t.closed14), rate: true },
    { value: funnelCount(t.boughtLater), rate: false },
  ];
}

// --- Таблица ---------------------------------------------------------------------

type GroupField = "city" | "studio" | "status" | "direction";
export type FunnelGroup = FunnelTotals & Partial<Record<GroupField, string>>;

/** Их aggregate(rs, fields): суммы по ключу полей, в порядке первой встречи. */
export function funnelAggregate(rows: FunnelRow[], fields: GroupField[]): FunnelGroup[] {
  const m = new Map<string, FunnelGroup>();
  for (const r of rows) {
    const k = fields.map((f) => r[f]).join("\x01");
    let x = m.get(k);
    if (!x) {
      x = emptyTotals();
      for (const f of fields) x[f] = r[f];
      m.set(k, x);
    }
    for (const key of TOTAL_KEYS) x[key] += r[key];
  }
  return [...m.values()];
}

/** Ключ раскрытой студии — их id `город\x01студия`. */
export const funnelStudioId = (city: string, studio: string) => `${city}\x01${studio}`;

export type FunnelTableRow = {
  level: "city" | "studio" | "direction";
  /** Уникален в таблице: город, город\x01студия, город\x01студия\x01направление. */
  key: string;
  /** Чем раскрывается строка: город — expandedCities, студия — expandedStudios. */
  toggleId?: string;
  expanded?: boolean;
  name: string;
  /** Статус студии под названием (у строки студии, если есть). */
  status?: string;
  totals: FunnelTotals;
};

/**
 * Их renderTable: города по алфавиту; у раскрытого города — его студии, у
 * раскрытой студии — её направления.
 */
export function funnelTable(
  rows: FunnelRow[],
  expandedCities: ReadonlySet<string>,
  expandedStudios: ReadonlySet<string>,
): FunnelTableRow[] {
  const out: FunnelTableRow[] = [];
  const name = (g: FunnelGroup, f: GroupField) => g[f] ?? "";
  for (const c of funnelAggregate(rows, ["city"]).sort((a, b) =>
    byName(name(a, "city"), name(b, "city")),
  )) {
    const city = name(c, "city");
    const cityOpen = expandedCities.has(city);
    out.push({
      level: "city",
      key: city,
      toggleId: city,
      expanded: cityOpen,
      name: city,
      totals: c,
    });
    if (!cityOpen) continue;
    for (const s of funnelAggregate(
      rows.filter((r) => r.city === city),
      ["city", "studio", "status"],
    ).sort((a, b) => byName(name(a, "studio"), name(b, "studio")))) {
      const studio = name(s, "studio");
      const id = funnelStudioId(city, studio);
      const studioOpen = expandedStudios.has(id);
      out.push({
        level: "studio",
        key: `${id}\x01${name(s, "status")}`,
        toggleId: id,
        expanded: studioOpen,
        name: studio,
        status: name(s, "status") || undefined,
        totals: s,
      });
      if (!studioOpen) continue;
      for (const d of funnelAggregate(
        rows.filter((r) => r.city === city && r.studio === studio),
        ["city", "studio", "direction"],
      ).sort((a, b) => byName(name(a, "direction"), name(b, "direction")))) {
        out.push({
          level: "direction",
          key: `${id}\x01${name(s, "status")}\x01${name(d, "direction")}`,
          name: name(d, "direction"),
          totals: d,
        });
      }
    }
  }
  return out;
}

/** Их toggle: раскрыть или свернуть (Set — новый, для состояния React). */
export function funnelToggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
