/**
 * Сортировка таблиц по клику на заголовок колонки (решение владельца
 * 2026-10-18): первый клик — по возрастанию, второй — по убыванию, третий —
 * выключает (порядок страницы по умолчанию). Клик по другой колонке
 * начинает с возрастания. Сортировка — внутри фильтров: серверные таблицы
 * передают её в запрос (`orderBy`, состояние — в queryKey, смена — на 1-ю
 * страницу), клиентские сортируют уже отфильтрованные строки (`sortRows`).
 * Пустые значения — всегда в конце, в обе стороны.
 */

export type SortDir = "asc" | "desc";
export type TableSort = { key: string; dir: SortDir } | null;

export function nextSort(current: TableSort, key: string): TableSort {
  if (current?.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

/** Строка для queryKey: «registration_date:asc», без сортировки — "". */
export function sortKeyString(sort: TableSort): string {
  return sort ? `${sort.key}:${sort.dir}` : "";
}

export type SortValue = string | number | boolean | Date | null | undefined;
export type SortGetters<T> = Record<string, (row: T) => SortValue>;

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

function isEmpty(v: SortValue): v is null | undefined | "" {
  return v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Строки в порядке сортировки (новый массив; без сортировки или с
 * неизвестной колонкой — как пришли). Сортировка устойчивая: при равных
 * значениях остаётся порядок страницы по умолчанию.
 */
export function sortRows<T>(rows: readonly T[], sort: TableSort, getters: SortGetters<T>): T[] {
  const get = sort ? getters[sort.key] : undefined;
  if (!sort || !get) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: get(row) }))
    .sort((a, b) => {
      const ea = isEmpty(a.value);
      const eb = isEmpty(b.value);
      if (ea || eb) return ea === eb ? a.index - b.index : ea ? 1 : -1;
      return sign * compareValues(a.value, b.value) || a.index - b.index;
    })
    .map((x) => x.row);
}

type Orderable<Q> = {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): Q;
};

/**
 * Порядок серверного запроса. `columns` — колонка (или несколько) для
 * ключа сортировки; ключа нет в списке или сортировка выключена —
 * `fallback` (порядок страницы по умолчанию). После выбранной колонки —
 * `tieBreaker` (обычно id): иначе строки с равным значением на границе
 * страниц PostgREST отдавал бы в разном порядке — дубли и пропуски.
 */
export function orderBy<Q extends Orderable<Q>>(
  query: Q,
  sort: TableSort,
  columns: Record<string, string | readonly string[]>,
  fallback: (q: Q) => Q,
  tieBreaker = "id",
): Q {
  const cols = sort ? columns[sort.key] : undefined;
  if (!sort || !cols) return fallback(query);
  const ascending = sort.dir === "asc";
  let q = query;
  for (const col of typeof cols === "string" ? [cols] : cols)
    q = q.order(col, { ascending, nullsFirst: false });
  return tieBreaker ? q.order(tieBreaker, { ascending }) : q;
}
