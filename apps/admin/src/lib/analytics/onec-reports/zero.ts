/**
 * Доска «Нулевая номенклатура» — расчёты их zero.html (боевой портал
 * аналитики, /1c?report=zero) без React: отбор по фильтрам, списки
 * «Город» / «Студия» и «Поиск города», плитки, дерево город → студия →
 * номенклатура и его порядок. Логика — как у них, построчно (не «чинить»).
 * Данные — ZeroPayload (payload.ts, их __ONEC_PAYLOAD__).
 */
import { formatNumber } from "@/lib/format";
import { sortRows, type TableSort } from "@/lib/table-sort";

import type { ZeroPayload } from "./payload";

export type ZeroRecord = ZeroPayload["records"][number];

/** Значение «Все …» у их списков. */
export const ZERO_ALL = "all";

/** Фильтры доски: их #period (скрыт, = currentPeriod), #city, #studio. */
export type ZeroFilters = { period: string; city: string; studio: string };

/** Их fmt: Intl.NumberFormat('ru-RU'). */
export const zeroFormat = (n: number) => formatNumber(n);

const byRu = (a: string, b: string) => a.localeCompare(b, "ru");

/** Их options(): уникальные значения по алфавиту (localeCompare 'ru'). */
export function zeroOptionValues(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byRu);
}

/** Их options(): прежнее значение остаётся, если оно есть в новом списке, иначе «Все». */
export function zeroKeepOption(value: string, values: readonly string[]): string {
  return value === ZERO_ALL || values.includes(value) ? value : ZERO_ALL;
}

const inPeriod = (r: ZeroRecord, period: string) => period === ZERO_ALL || r.period === period;

/**
 * Их updateFilters(): города — из строк периода, студии — из строк периода и
 * выбранного города; значение, которого нет в новом списке, сбрасывается на
 * «Все». Так же они применяли город и студию из адреса (server-controls.js:
 * только если такой пункт есть в списке).
 */
export function zeroFilterState(
  records: readonly ZeroRecord[],
  filters: ZeroFilters,
): { cities: string[]; studios: string[]; city: string; studio: string } {
  const periodRows = records.filter((r) => inPeriod(r, filters.period));
  const cities = zeroOptionValues(periodRows.map((r) => r.city));
  const city = zeroKeepOption(filters.city, cities);
  const cityRows = periodRows.filter((r) => city === ZERO_ALL || r.city === city);
  const studios = zeroOptionValues(cityRows.map((r) => r.studio));
  const studio = zeroKeepOption(filters.studio, studios);
  return { cities, studios, city, studio };
}

/**
 * Их filterCityOptions(): «Поиск города» прячет в списке «Город» пункты, где
 * нет набранного текста (без регистра); «Все города» видны всегда, выбранный
 * город остаётся выбранным, даже если спрятан.
 */
export function zeroVisibleCities(cities: readonly string[], query: string): string[] {
  const q = query.trim().toLocaleLowerCase("ru");
  if (!q) return [...cities];
  return cities.filter((c) => c.toLocaleLowerCase("ru").includes(q));
}

/** Их base(): строки по периоду, городу и студии. */
export function zeroRows(records: readonly ZeroRecord[], filters: ZeroFilters): ZeroRecord[] {
  return records.filter(
    (r) =>
      inPeriod(r, filters.period) &&
      (filters.city === ZERO_ALL || r.city === filters.city) &&
      (filters.studio === ZERO_ALL || r.studio === filters.studio),
  );
}

/**
 * Их плитки: сумма продаж, номенклатуры — разные «код + название» (склеены
 * через символ \0, как у них), студии и города — разные названия в
 * отобранных строках.
 */
export function zeroMetrics(rows: readonly ZeroRecord[]): { label: string; value: number }[] {
  const total = rows.reduce((n, r) => n + r.sales, 0);
  const products = new Set(rows.map((r) => r.code + "\0" + r.product));
  const studios = new Set(rows.map((r) => r.studio));
  const cities = new Set(rows.map((r) => r.city));
  return [
    { label: "Нулевых продаж", value: total },
    { label: "Номенклатур", value: products.size },
    { label: "Студий", value: studios.size },
    { label: "Городов", value: cities.size },
  ];
}

/** Их #meta без «Обновлено» (оно — в подписи рамки отчёта). */
export const zeroExcludedText = (payload: Pick<ZeroPayload, "excludedTrialRows">) =>
  `Исключено пробных занятий: ${zeroFormat(payload.excludedTrialRows || 0)}.`;

export type ZeroStudio = { key: string; name: string; sales: number; products: ZeroRecord[] };
export type ZeroCity = { name: string; sales: number; studios: ZeroStudio[] };

/** Ключ раскрытой студии — их `city.name + '\0' + studio.name`. */
export const zeroStudioKey = (city: string, studio: string) => city + "\0" + studio;

const bySales =
  <T>(name: (x: T) => string, sales: (x: T) => number) =>
  (a: T, b: T) =>
    sales(b) - sales(a) || byRu(name(a), name(b));

/**
 * Их render(): строки собираются в город → студию → номенклатуру (строку
 * данных); суммы — по продажам. Порядок на каждом уровне — по убыванию
 * количества, при равенстве — по названию.
 */
export function zeroTree(rows: readonly ZeroRecord[]): ZeroCity[] {
  const cityMap = new Map<
    string,
    { name: string; sales: number; studios: Map<string, ZeroStudio> }
  >();
  for (const r of rows) {
    let city = cityMap.get(r.city);
    if (!city) {
      city = { name: r.city, sales: 0, studios: new Map() };
      cityMap.set(r.city, city);
    }
    city.sales += r.sales;
    let studio = city.studios.get(r.studio);
    if (!studio) {
      studio = { key: zeroStudioKey(r.city, r.studio), name: r.studio, sales: 0, products: [] };
      city.studios.set(r.studio, studio);
    }
    studio.sales += r.sales;
    studio.products.push(r);
  }
  const named = bySales<{ name: string; sales: number }>(
    (x) => x.name,
    (x) => x.sales,
  );
  return [...cityMap.values()].sort(named).map((city) => ({
    name: city.name,
    sales: city.sales,
    studios: [...city.studios.values()].sort(named).map((s) => ({
      ...s,
      products: [...s.products].sort(
        bySales(
          (p) => p.product,
          (p) => p.sales,
        ),
      ),
    })),
  }));
}

/**
 * Сортировка по клику на заголовок (наша, system.md «Таблицы») — на каждом
 * уровне дерева: «name» — по названию, «sales» — по количеству. Без
 * сортировки — их порядок; при равных значениях он же.
 */
export function zeroSortTree(tree: readonly ZeroCity[], sort: TableSort): ZeroCity[] {
  if (!sort) return [...tree];
  const named = {
    name: (x: { name: string }) => x.name,
    sales: (x: { sales: number }) => x.sales,
  };
  return sortRows(tree, sort, named).map((city) => ({
    ...city,
    studios: sortRows(city.studios, sort, named).map((s) => ({
      ...s,
      products: sortRows(s.products, sort, {
        name: (p) => p.product,
        sales: (p) => p.sales,
      }),
    })),
  }));
}
