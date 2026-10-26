import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ru } from "date-fns/locale";

import type { DetailRow } from "@/lib/dashboard-details";

/**
 * Разбивка показателя дашборда по времени — для графика в окне карточки.
 * Без React и Supabase: строки из базы приходят уже точками (дата + сумма),
 * здесь — только корзины периода и суммирование (тест — dashboard-series.test.ts).
 */

export type Granularity = "month" | "week" | "day";

/** Сколько корзин показывает график каждой разбивки. */
export const BUCKET_COUNT: Record<Granularity, number> = { month: 12, week: 12, day: 30 };

export type Bucket = {
  key: string;
  /** Первый и последний день корзины, локальные даты yyyy-MM-dd. */
  from: string;
  to: string;
  /** Подпись на оси и полная подпись в подсказке. */
  tick: string;
  label: string;
};

/** Как из корзины получается число на графике. */
export type SeriesKind = "sum" | "count" | "avg";

/**
 * Строка из базы: локальная дата, сумма (у счётчиков — 0) и вклад в число
 * сделок/штук. `row` — та же строка в подробном отчёте окна плитки (кто это,
 * что купил), lib/dashboard-details.ts.
 */
export type SeriesPoint = { date: string; amount: number; n: number; row?: DetailRow };

export type SeriesValue = { bucket: Bucket; amount: number; n: number; value: number | null };

const WEEK = { weekStartsOn: 1 } as const;

function iso(d: Date) {
  return format(d, "yyyy-MM-dd");
}

function bucketStart(granularity: Granularity, d: Date) {
  if (granularity === "month") return startOfMonth(d);
  if (granularity === "week") return startOfWeek(d, WEEK);
  return startOfDay(d);
}

/** Ключ корзины, в которую попадает локальная дата yyyy-MM-dd. */
export function bucketKey(granularity: Granularity, date: string) {
  return iso(bucketStart(granularity, parseISO(date)));
}

function weekLabel(from: Date, to: Date) {
  const end = format(to, "d MMM yyyy", { locale: ru });
  return isSameMonth(from, to)
    ? `${format(from, "d", { locale: ru })}–${end}`
    : `${format(from, "d MMM", { locale: ru })} – ${end}`;
}

/**
 * Последние `BUCKET_COUNT` корзин, заканчивая той, в которую попадает `anchor`
 * (месяц, неделя с понедельника или день), по возрастанию.
 */
export function buildBuckets(granularity: Granularity, anchor: Date): Bucket[] {
  const count = BUCKET_COUNT[granularity];
  const last = bucketStart(granularity, anchor);
  const buckets: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    if (granularity === "month") {
      const from = addMonths(last, -i);
      buckets.push({
        key: iso(from),
        from: iso(from),
        to: iso(endOfMonth(from)),
        tick: format(from, "LLL yy", { locale: ru }),
        label: format(from, "LLLL yyyy", { locale: ru }),
      });
    } else if (granularity === "week") {
      const from = addWeeks(last, -i);
      const to = endOfWeek(from, WEEK);
      buckets.push({
        key: iso(from),
        from: iso(from),
        to: iso(to),
        tick: format(from, "d MMM", { locale: ru }),
        label: weekLabel(from, to),
      });
    } else {
      const day = addDays(last, -i);
      buckets.push({
        key: iso(day),
        from: iso(day),
        to: iso(day),
        tick: format(day, "d MMM", { locale: ru }),
        label: format(day, "EEEEEE, d MMMM yyyy", { locale: ru }),
      });
    }
  }
  return buckets;
}

/** Значение корзины: сумма, число штук или среднее (сумма / штуки; нет штук — null). */
export function seriesValue(kind: SeriesKind, amount: number, n: number) {
  if (kind === "sum") return amount;
  if (kind === "count") return n;
  return n ? amount / n : null;
}

/** Раскладывает точки по корзинам; точки вне корзин отбрасываются. */
export function aggregate(
  granularity: Granularity,
  buckets: Bucket[],
  points: SeriesPoint[],
  kind: SeriesKind,
): SeriesValue[] {
  const totals = new Map(buckets.map((b) => [b.key, { amount: 0, n: 0 }]));
  for (const p of points) {
    const t = totals.get(bucketKey(granularity, p.date));
    if (!t) continue;
    t.amount += p.amount;
    t.n += p.n;
  }
  return buckets.map((bucket) => {
    const { amount, n } = totals.get(bucket.key)!;
    return { bucket, amount, n, value: seriesValue(kind, amount, n) };
  });
}

/** Итог за все корзины: у среднего — общий средний, а не среднее средних. */
export function seriesTotal(kind: SeriesKind, values: SeriesValue[]) {
  const amount = values.reduce((s, v) => s + v.amount, 0);
  const n = values.reduce((s, v) => s + v.n, 0);
  return seriesValue(kind, amount, n);
}
