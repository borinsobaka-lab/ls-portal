/**
 * «Аналитика сети» — расчёты без React и Supabase (тест — logic.test.ts):
 * студии по городам, недели месяца, прогноз, точка 0 города, сравнения
 * периодов, сводки продаж, занятий и пробных, рейтинг. Правила — как в
 * портале аналитики Lady Stretch (ANALYTICS.md): итоговые доли и средние —
 * из итоговых числителя и знаменателя, нет знаменателя — null («—»);
 * сегодняшний день в факт и прогноз выручки не попадает.
 */
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  getDaysInMonth,
  isLastDayOfMonth,
  parseISO,
  startOfMonth,
} from "date-fns";
import { ru } from "date-fns/locale";

import type {
  AnStudio,
  ClassRow,
  Period,
  RevenueRow,
  SaleOrigin,
  SalesData,
  TrialRow,
  ZeroRow,
} from "./types";

export const NO_CITY = "Без города";

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const byName = (a: string, b: string) => a.localeCompare(b, "ru");

// ---------------------------------------------------------------------------
// Студии и города

/** Студия закрыта к этому дню (closed_on — первый день закрытия). */
export function isClosed(studio: Pick<AnStudio, "closedOn">, today: string): boolean {
  return !!studio.closedOn && studio.closedOn <= today;
}

export type StatusFilter = "all" | "open" | "closed";

export type StudioFilter = {
  brandId: string | null;
  city: string | null;
  clubId: string | null;
  status: StatusFilter;
};

export const cityOf = (s: Pick<AnStudio, "city">) => s.city?.trim() || NO_CITY;

/** Студии под фильтрами страницы. */
export function filterStudios(studios: AnStudio[], f: StudioFilter, today: string): AnStudio[] {
  return studios.filter(
    (s) =>
      (!f.brandId || s.brandId === f.brandId) &&
      (!f.city || cityOf(s) === f.city) &&
      (!f.clubId || s.id === f.clubId) &&
      (f.status === "all" || (f.status === "closed") === isClosed(s, today)),
  );
}

export type CityGroup = { city: string; open: boolean; studios: AnStudio[] };

/**
 * Студии по городам. Порядок — как в отчётах Lady Stretch: сначала города,
 * где есть открытые студии, по алфавиту, затем города только с закрытыми;
 * внутри — открытые по алфавиту, затем закрытые. «Без города» — в конце
 * своей части.
 */
export function groupByCity(studios: AnStudio[], today: string): CityGroup[] {
  const map = new Map<string, AnStudio[]>();
  for (const s of studios) {
    const list = map.get(cityOf(s)) ?? [];
    list.push(s);
    map.set(cityOf(s), list);
  }
  const groups = [...map.entries()].map(([city, list]) => ({
    city,
    open: list.some((s) => !isClosed(s, today)),
    studios: [...list].sort(
      (a, b) => Number(isClosed(a, today)) - Number(isClosed(b, today)) || byName(a.name, b.name),
    ),
  }));
  return groups.sort(
    (a, b) =>
      Number(!a.open) - Number(!b.open) ||
      Number(a.city === NO_CITY) - Number(b.city === NO_CITY) ||
      byName(a.city, b.city),
  );
}

/** Города студий (для фильтра) — в том же порядке, что в отчётах. */
export function cityNames(studios: AnStudio[], today: string): string[] {
  return groupByCity(studios, today).map((g) => g.city);
}

/**
 * Точка 0 набора студий: сумма точек 0 их городов (у города она одна на все
 * его студии, как в справочнике Lady Stretch). Только если набор — целые
 * города: для отдельной студии города точку 0 не показываем.
 */
export function pointZeroOf(
  list: AnStudio[],
  all: AnStudio[],
  targets: Record<string, number>,
): number | null {
  const cities = [...new Set(list.map(cityOf))];
  if (cities.length === 0) return null;
  const whole = cities.every((c) =>
    all.filter((s) => cityOf(s) === c).every((s) => list.some((x) => x.id === s.id)),
  );
  if (!whole) return null;
  const known = cities.filter((c) => targets[c] !== undefined);
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + targets[c], 0);
}

// ---------------------------------------------------------------------------
// Периоды

export function monthPeriod(anyDay: string): Period {
  const d = parseISO(anyDay);
  return { from: iso(startOfMonth(d)), to: iso(endOfMonth(d)) };
}

/**
 * Тот же период на `months` месяцев раньше (-1 — прошлый месяц, -12 —
 * прошлый год): те же числа, день ограничен длиной месяца; конец месяца
 * остаётся концом месяца (1–30 сентября → 1–31 августа).
 */
export function shiftPeriod(p: Period, months: number): Period {
  const from = addMonths(parseISO(p.from), months);
  const toDate = parseISO(p.to);
  const to = isLastDayOfMonth(toDate)
    ? endOfMonth(addMonths(toDate, months))
    : addMonths(toDate, months);
  return { from: iso(from), to: iso(to) };
}

/** Дни периода (включительно). */
export function periodDays(p: Period): number {
  return differenceInCalendarDays(parseISO(p.to), parseISO(p.from)) + 1;
}

/** Начала месяцев: `count` месяцев, заканчивая месяцем `lastDay`. */
export function monthStarts(lastDay: string, count: number): string[] {
  const last = startOfMonth(parseISO(lastDay));
  return Array.from({ length: count }, (_, i) => iso(addMonths(last, i - count + 1)));
}

export function monthLabel(monthStart: string, withYear = false): string {
  return format(parseISO(monthStart), withYear ? "LLLL yyyy" : "LLL", { locale: ru }).replace(
    ".",
    "",
  );
}

export type Week = { from: string; to: string; label: string };

/**
 * Календарные недели месяца — понедельник–воскресенье, обрезанные границами
 * месяца (как в «Выручке» Lady Stretch: август 2026 — 1–2, 3–9, …, 31–31).
 */
export function monthWeeks(monthStart: string): Week[] {
  const start = parseISO(monthStart);
  const end = endOfMonth(start);
  const weeks: Week[] = [];
  let from = start;
  while (from <= end) {
    const toSunday = (7 - from.getDay()) % 7;
    const to = addDays(from, toSunday) > end ? end : addDays(from, toSunday);
    weeks.push({ from: iso(from), to: iso(to), label: `${from.getDate()}–${to.getDate()}` });
    from = addDays(to, 1);
  }
  return weeks;
}

/** Последний учитываемый день: сегодняшний в факт и прогноз не попадает. */
export function lastFullDay(today: string): string {
  return iso(addDays(parseISO(today), -1));
}

/**
 * Прогноз месяца по среднему дневному темпу: выручка за прошедшие полные
 * дни / их число × дней в месяце. Только для текущего месяца; 1-го числа —
 * null.
 */
export function forecast(netToYesterday: number, monthStart: string, today: string): number | null {
  if (monthPeriod(today).from !== monthStart) return null;
  const elapsed = parseISO(today).getDate() - 1;
  if (elapsed <= 0) return null;
  return (netToYesterday / elapsed) * getDaysInMonth(parseISO(monthStart));
}

// ---------------------------------------------------------------------------
// Проценты и сравнения

/** Доля в процентах; знаменатель 0 — null. */
export function rate(part: number, base: number): number | null {
  return base > 0 ? (part / base) * 100 : null;
}

/** Деление; знаменатель 0 — null. */
export function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

/** Изменение к базе в процентах; базы нет или она 0 — null. */
export function change(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// ---------------------------------------------------------------------------
// Выручка

/** «Приход минус расход». */
export const net = (r: RevenueRow) => r.income - r.expense;

/** Выручка студий за даты [from, to] (строки — по дням или по месяцам). */
export function sumRevenue(rows: RevenueRow[], ids: Set<string>, from: string, to: string): number {
  let sum = 0;
  for (const r of rows) if (ids.has(r.studioId) && r.date >= from && r.date <= to) sum += net(r);
  return sum;
}

export type RevenueLine = {
  key: string;
  label: string;
  closed: boolean;
  weeks: number[];
  /** Выручка месяца (у текущего — по вчера). */
  fact: number;
  forecast: number | null;
  pointZero: number | null;
  /** Прогноз (у прошедшего месяца — факт) минус точка 0. */
  pointZeroDiff: number | null;
  /** Прошлые месяцы — от ближнего к дальнему. */
  history: number[];
  studios: number;
};

export type RevenueTable = {
  month: string;
  weeks: Week[];
  historyMonths: string[];
  total: RevenueLine;
  cities: { line: RevenueLine; studios: RevenueLine[] }[];
};

/**
 * Таблица «Выручка»: город → студии, недели выбранного месяца, факт,
 * прогноз, точка 0 и прошлые месяцы. `days` — выручка по дням месяца,
 * `months` — по месяцам истории (корзина month). Прогноз города и сети — от
 * их суммарной выручки. Точка 0 — у города и сети; у студии — нет.
 */
export function revenueTable(input: {
  studios: AnStudio[];
  all: AnStudio[];
  targets: Record<string, number>;
  days: RevenueRow[];
  months: RevenueRow[];
  month: string;
  today: string;
  history: number;
}): RevenueTable {
  const { studios, all, targets, days, months, month, today, history } = input;
  const weeks = monthWeeks(month);
  const historyMonths = monthStarts(iso(addMonths(parseISO(month), -1)), history).reverse();
  const current = monthPeriod(today).from === month;
  const end = current ? lastFullDay(today) : monthPeriod(month).to;

  const line = (
    key: string,
    label: string,
    list: AnStudio[],
    closed: boolean,
    withTarget: boolean,
  ): RevenueLine => {
    const ids = new Set(list.map((s) => s.id));
    const fact = sumRevenue(days, ids, month, end);
    const fc = forecast(fact, month, today);
    const pointZero = withTarget ? pointZeroOf(list, all, targets) : null;
    const reach = current ? fc : fact;
    return {
      key,
      label,
      closed,
      weeks: weeks.map((w) =>
        w.from > end ? 0 : sumRevenue(days, ids, w.from, w.to < end ? w.to : end),
      ),
      fact,
      forecast: fc,
      pointZero,
      pointZeroDiff: pointZero !== null && reach !== null ? reach - pointZero : null,
      history: historyMonths.map((m) => sumRevenue(months, ids, m, monthPeriod(m).to)),
      studios: list.length,
    };
  };

  const cities = groupByCity(studios, today).map((g) => ({
    line: line(`city:${g.city}`, g.city, g.studios, !g.open, true),
    studios: g.studios.map((s) => line(s.id, s.name, [s], isClosed(s, today), false)),
  }));
  return {
    month,
    weeks,
    historyMonths,
    total: line("total", "Итого по сети", studios, false, true),
    cities,
  };
}

// ---------------------------------------------------------------------------
// Продажи абонементов

/** Повторные — продления и возвращённые. */
export const REPEAT_ORIGINS: SaleOrigin[] = ["renewal", "return"];

export type SalesSummary = {
  /** Оплаченных продаж абонементов. */
  sold: number;
  newSold: number;
  repeatSold: number;
  renewals: number;
  returns: number;
  /** Без кода клиента — новый или повторный не определить. */
  unknown: number;
  /** Оплаты по продажам абонементов. */
  paid: number;
  newPaid: number;
  repeatPaid: number;
  /** Сумма продаж (стоимость) абонементов. */
  cost: number;
  /** Средний чек — оплаты / продажи (у Lady Stretch — по сумме оплат). */
  avgCheck: number | null;
  avgNew: number | null;
  avgRepeat: number | null;
};

export function salesSummary(data: SalesData, ids: Set<string>): SalesSummary {
  const pick = (origins: SaleOrigin[] | null) => {
    let n = 0;
    let paid = 0;
    let cost = 0;
    for (const r of data.sold) {
      if (!ids.has(r.studioId) || (origins && !origins.includes(r.origin))) continue;
      n += r.count;
      paid += r.paid;
      cost += r.cost;
    }
    return { n, paid, cost };
  };
  const all = pick(null);
  const fresh = pick(["new"]);
  const repeat = pick(REPEAT_ORIGINS);
  return {
    sold: all.n,
    newSold: fresh.n,
    repeatSold: repeat.n,
    renewals: pick(["renewal"]).n,
    returns: pick(["return"]).n,
    unknown: pick(["unknown"]).n,
    paid: all.paid,
    newPaid: fresh.paid,
    repeatPaid: repeat.paid,
    cost: all.cost,
    avgCheck: ratio(all.paid, all.n),
    avgNew: ratio(fresh.paid, fresh.n),
    avgRepeat: ratio(repeat.paid, repeat.n),
  };
}

export type MonthPoint = {
  month: string;
  label: string;
  newSold: number;
  repeatSold: number;
  sold: number;
  paid: number;
};

/** Продажи по месяцам (данные с корзиной month). */
export function salesByMonth(data: SalesData, ids: Set<string>, months: string[]): MonthPoint[] {
  return months.map((m) => {
    const rows = data.sold.filter((r) => ids.has(r.studioId) && r.date === m);
    const count = (o: SaleOrigin[]) =>
      rows.filter((r) => o.includes(r.origin)).reduce((s, r) => s + r.count, 0);
    return {
      month: m,
      label: monthLabel(m),
      newSold: count(["new"]),
      repeatSold: count(REPEAT_ORIGINS),
      sold: rows.reduce((s, r) => s + r.count, 0),
      paid: rows.reduce((s, r) => s + r.paid, 0),
    };
  });
}

export type NomenclatureFilter = "all" | "new" | "repeat";

export type NomenclatureLine = { key: string; name: string; count: number; amount: number };

/** «Что покупают»: номенклатуры абонементов по числу продаж (сумма — оплаты). */
export function nomenclature(
  data: SalesData,
  ids: Set<string>,
  filter: NomenclatureFilter,
): NomenclatureLine[] {
  const map = new Map<string, NomenclatureLine>();
  for (const r of data.sold) {
    if (!ids.has(r.studioId)) continue;
    if (filter === "new" && r.origin !== "new") continue;
    if (filter === "repeat" && !REPEAT_ORIGINS.includes(r.origin)) continue;
    const line = map.get(r.nomenclatureId) ?? {
      key: r.nomenclatureId,
      name: data.names[r.nomenclatureId] ?? "Без названия",
      count: 0,
      amount: 0,
    };
    line.count += r.count;
    line.amount += r.paid;
    map.set(r.nomenclatureId, line);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || byName(a.name, b.name));
}

// ---------------------------------------------------------------------------
// Занятия

export type ClassesSummary = {
  classes: number;
  booked: number;
  attended: number;
  /** Средние на занятии: записано / занятий, посетило / занятий. */
  avgBooked: number | null;
  avgAttended: number | null;
  /** Доходимость: посетило / записано, %. */
  attendance: number | null;
};

export function classesSummary(rows: ClassRow[], ids: Set<string>): ClassesSummary {
  let classes = 0;
  let booked = 0;
  let attended = 0;
  for (const r of rows) {
    if (!ids.has(r.studioId)) continue;
    classes += r.classes;
    booked += r.booked;
    attended += r.attended;
  }
  return {
    classes,
    booked,
    attended,
    avgBooked: ratio(booked, classes),
    avgAttended: ratio(attended, classes),
    attendance: rate(attended, booked),
  };
}

export type DirectionLine = { key: string; name: string } & ClassesSummary;

/** Направления занятий. */
export function directionLines(rows: ClassRow[], ids: Set<string>): DirectionLine[] {
  const names = [...new Set(rows.filter((r) => ids.has(r.studioId)).map((r) => r.direction))];
  return names
    .map((name) => ({
      key: name,
      name: name || "Без направления",
      ...classesSummary(
        rows.filter((r) => r.direction === name),
        ids,
      ),
    }))
    .sort((a, b) => b.attended - a.attended || byName(a.name, b.name));
}

// ---------------------------------------------------------------------------
// Пробные

export type TrialsSummary = {
  /** Записей на пробное. */
  trials: number;
  attended: number;
  day0: number;
  d14: number;
  open: number;
  /** Доходимость: пришли / записались, %. */
  attendance: number | null;
  /** Купили в день пробного / пришли, %. */
  day0Rate: number | null;
  /** Купили за 14 дней / пришли, %. */
  d14Rate: number | null;
};

export function trialsSummary(rows: TrialRow[], ids: Set<string>): TrialsSummary {
  const list = rows.filter((r) => ids.has(r.studioId));
  const sum = (k: "trials" | "attended" | "day0" | "d14" | "open") =>
    list.reduce((s, r) => s + r[k], 0);
  const attended = sum("attended");
  return {
    trials: sum("trials"),
    attended,
    day0: sum("day0"),
    d14: sum("d14"),
    open: sum("open"),
    attendance: rate(attended, sum("trials")),
    day0Rate: rate(sum("day0"), attended),
    d14Rate: rate(sum("d14"), attended),
  };
}

/** Пробные по виду (членству) пробного. */
export function trialLines(
  rows: TrialRow[],
  ids: Set<string>,
): ({ key: string; name: string } & TrialsSummary)[] {
  const keys = [...new Set(rows.filter((r) => ids.has(r.studioId)).map((r) => r.membership))];
  return keys
    .map((key) => ({
      key,
      name: key || "Пробное",
      ...trialsSummary(
        rows.filter((r) => r.membership === key),
        ids,
      ),
    }))
    .sort((a, b) => b.trials - a.trials || byName(a.name, b.name));
}

// ---------------------------------------------------------------------------
// Рейтинг

export type RankBy = "club" | "city";

export type RatingEntry = {
  key: string;
  label: string;
  value: number;
  part?: number;
  base?: number;
};

export type Rating = {
  day0: RatingEntry[];
  d14: RatingEntry[];
  renewals: RatingEntry[];
  returns: RatingEntry[];
};

/**
 * Рейтинг городов (или студий) за месяц — «Топ-10» Lady Stretch: покупка в
 * день пробного и за 14 дней (доля от пришедших), продления без
 * возвращённых и возвращённые (штук). Без пришедших на пробное в долях не
 * участвует.
 */
export function rating(input: {
  studios: AnStudio[];
  trials: TrialRow[];
  sales: SalesData;
  by: RankBy;
  limit?: number;
}): Rating {
  const { studios, trials, sales, by, limit = 10 } = input;
  const groups =
    by === "club"
      ? studios.map((s) => ({ key: s.id, label: s.name, ids: new Set([s.id]) }))
      : [...new Set(studios.map(cityOf))].map((c) => ({
          key: c,
          label: c,
          ids: new Set(studios.filter((s) => cityOf(s) === c).map((s) => s.id)),
        }));
  const top = (list: RatingEntry[]) =>
    list
      .filter((e) => e.value > 0 || (e.base ?? 0) > 0)
      .sort(
        (a, b) => b.value - a.value || (b.base ?? 0) - (a.base ?? 0) || byName(a.label, b.label),
      )
      .slice(0, limit);
  const conv = (k: "day0" | "d14") =>
    top(
      groups.flatMap((g) => {
        const t = trialsSummary(trials, g.ids);
        return t.attended > 0
          ? [
              {
                key: g.key,
                label: g.label,
                value: rate(t[k], t.attended) ?? 0,
                part: t[k],
                base: t.attended,
              },
            ]
          : [];
      }),
    );
  const counts = (origin: SaleOrigin) =>
    top(
      groups.map((g) => ({
        key: g.key,
        label: g.label,
        value: sales.sold
          .filter((r) => g.ids.has(r.studioId) && r.origin === origin)
          .reduce((s, r) => s + r.count, 0),
      })),
    );
  return {
    day0: conv("day0"),
    d14: conv("d14"),
    renewals: counts("renewal"),
    returns: counts("return"),
  };
}

// ---------------------------------------------------------------------------
// Нулевая номенклатура

export type ZeroCity = {
  city: string;
  count: number;
  studios: { studio: AnStudio; count: number; items: ZeroRow[] }[];
};

/** Продажи с нулём: город → студия → номенклатура (по числу строк). */
export function zeroTree(rows: ZeroRow[], studios: AnStudio[], today: string): ZeroCity[] {
  return groupByCity(studios, today)
    .map((g) => {
      const list = g.studios
        .map((studio) => {
          const items = rows
            .filter((r) => r.studioId === studio.id)
            .sort((a, b) => b.count - a.count || byName(a.name, b.name));
          return { studio, items, count: items.reduce((s, r) => s + r.count, 0) };
        })
        .filter((s) => s.count > 0);
      return { city: g.city, studios: list, count: list.reduce((s, x) => s + x.count, 0) };
    })
    .filter((c) => c.count > 0);
}

// ---------------------------------------------------------------------------
// Вывод

const decFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const rubFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Деньги сети — рубли без копеек (клубы сети в России). */
export function formatRub(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "—" : `${rubFormat.format(Math.round(v))} ₽`;
}

/** «48,5%»; null — «—». */
export function formatRate(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${digits === 0 ? Math.round(v) : decFormat.format(v)}%`;
}

/** Среднее с одним знаком; null — «—». */
export function formatAvg(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "—" : decFormat.format(v);
}

/** Изменение «+12%» / «−5%»; null — «—». */
export function formatChange(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const r = Math.round(v);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}
