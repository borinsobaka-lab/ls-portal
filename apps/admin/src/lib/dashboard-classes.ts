import type { DetailRow } from "@/lib/dashboard-details";
import type { SeriesPoint } from "@/lib/dashboard-series";
import { formatNumber } from "@/lib/format";

/**
 * Расчёты подраздела дашборда «Занятия» без React и Supabase (тест —
 * dashboard-classes.test.ts): занятия расписания с записями приходят уже
 * разобранными (lib/dashboard-data.ts, loadClassEntries), здесь — только
 * арифметика.
 *
 * Считаются групповые занятия, которые уже начались и не отменены клубом:
 * у будущих ещё нет посещений, у отменённых записи сняты клубом, а не
 * клиентом. Персональные — отдельной плиткой, прочая активность не
 * считается вовсе.
 */

export type ClassKind = "group" | "personal" | "other";

export type ClassBooking = {
  /** booked | waitlist | attended | no_show | cancelled | rejected. */
  status: string;
  /** Кто записан: карточка клиента, иначе учётная запись приложения. */
  client: string | null;
  /** Карточка и учётная запись по отдельности — для подробного отчёта (не light-загрузка). */
  clientId?: string | null;
  userId?: string | null;
};

export type ClassEntry = {
  id: string;
  studioId: string;
  kind: ClassKind;
  /** Начало занятия, мс. */
  startsAt: number;
  /** Локальные дата yyyy-MM-dd, день недели (0 — пн) и время HH:mm начала. */
  date: string;
  weekday: number;
  time: string;
  /** Отменено клубом (cancel_schedule_entry). */
  cancelled: boolean;
  workoutId: string | null;
  workoutName: string;
  workoutColor: string | null;
  /** Мест на занятии; null — без лимита. */
  capacity: number | null;
  /**
   * Кто вёл: тренеры занятия (заменяющий — вместо заменённого) и их оценка
   * в приложении за всё время (null — оценок нет).
   */
  trainers: { id: string; name: string; rating?: number | null; ratingCount?: number }[];
  bookings: ClassBooking[];
};

/** Групповое занятие, которое уже началось и не отменено, — его и считаем. */
export function isHeld(e: ClassEntry, now: number) {
  return e.kind === "group" && !e.cancelled && e.startsAt <= now;
}

/** Счётчики по группе занятий: всего, по тренеру, по тренировке, по слоту. */
export type ClassTally = {
  classes: number;
  /** Отмеченные посещения. */
  visits: number;
  noShows: number;
  /** Записи без отметки «Посетил / Не пришёл» на начавшееся занятие. */
  unmarked: number;
  /** Записи, отменённые до занятия (клиентом или администратором). */
  cancelled: number;
  /** Места, занятые к началу: записан, посетил, не пришёл. */
  held: number;
  /** Мест на занятиях с лимитом и посещений на них — для заполняемости. */
  capacity: number;
  visitsCapped: number;
  /** Занятий, где записались на все места. */
  full: number;
  /** Посещений у каждого клиента. */
  clients: Map<string, number>;
};

export function emptyTally(): ClassTally {
  return {
    classes: 0,
    visits: 0,
    noShows: 0,
    unmarked: 0,
    cancelled: 0,
    held: 0,
    capacity: 0,
    visitsCapped: 0,
    full: 0,
    clients: new Map(),
  };
}

/** Одно занятие: сколько пришло, не пришло, отменило. */
export function entryCounts(e: ClassEntry) {
  let visits = 0;
  let noShows = 0;
  let unmarked = 0;
  let cancelled = 0;
  for (const b of e.bookings) {
    if (b.status === "attended") visits++;
    else if (b.status === "no_show") noShows++;
    else if (b.status === "booked") unmarked++;
    else if (b.status === "cancelled") cancelled++;
  }
  return { visits, noShows, unmarked, cancelled, held: visits + noShows + unmarked };
}

export function addEntry(t: ClassTally, e: ClassEntry) {
  const c = entryCounts(e);
  t.classes++;
  t.visits += c.visits;
  t.noShows += c.noShows;
  t.unmarked += c.unmarked;
  t.cancelled += c.cancelled;
  t.held += c.held;
  if (e.capacity) {
    t.capacity += e.capacity;
    t.visitsCapped += c.visits;
    if (c.held >= e.capacity) t.full++;
  }
  for (const b of e.bookings) {
    if (b.status !== "attended" || !b.client) continue;
    t.clients.set(b.client, (t.clients.get(b.client) ?? 0) + 1);
  }
}

/**
 * Проведённые занятия по группам: ключи занятия — тренеры, тренировка,
 * слот расписания (занятие с двумя тренерами считается у обоих).
 */
export function tallyBy(
  entries: ClassEntry[],
  now: number,
  keys: (e: ClassEntry) => string[],
): Map<string, ClassTally> {
  const map = new Map<string, ClassTally>();
  for (const e of entries) {
    if (!isHeld(e, now)) continue;
    for (const key of keys(e)) {
      const t = map.get(key) ?? emptyTally();
      addEntry(t, e);
      map.set(key, t);
    }
  }
  return map;
}

export function tallyAll(entries: ClassEntry[], now: number) {
  return tallyBy(entries, now, () => ["all"]).get("all") ?? emptyTally();
}

const share = (part: number, base: number) => (base ? (part / base) * 100 : null);

/** Заполняемость, %: посещения / места (занятия без лимита мест не в счёт). */
export const fillRate = (t: ClassTally) => share(t.visitsCapped, t.capacity);

/** Доходимость, %: посетил / (посетил + не пришёл); без отметки — не в счёт. */
export const showRate = (t: ClassTally) => share(t.visits, t.visits + t.noShows);

/** Отмены записей, %: отменённые / все записи, кроме листа ожидания. */
export const cancelRate = (t: ClassTally) => share(t.cancelled, t.cancelled + t.held);

/** Среднее посещений на занятии. */
export const avgPerClass = (t: ClassTally) => (t.classes ? t.visits / t.classes : null);

/** Повторные визиты, %: клиенты, пришедшие в группу два раза и больше. */
export function repeatRate(t: ClassTally) {
  let again = 0;
  for (const n of t.clients.values()) if (n >= 2) again++;
  return share(again, t.clients.size);
}

export type ClassesKey =
  | "fillRate"
  | "showRate"
  | "avgPerClass"
  | "visits"
  | "uniqueClients"
  | "classes"
  | "personal"
  | "cancelRate"
  | "noShows"
  | "cancelledClasses";

const orUndefined = (n: number | null) => n ?? undefined;

/** Плитки «Занятий» за период; не посчитать (нет занятий, нет мест) — undefined. */
export function classesMetrics(entries: ClassEntry[], now: number) {
  const t = tallyAll(entries, now);
  let personal = 0;
  let cancelledClasses = 0;
  for (const e of entries) {
    if (e.kind === "personal" && !e.cancelled && e.startsAt <= now)
      personal += entryCounts(e).visits;
    if (e.kind === "group" && e.cancelled) cancelledClasses++;
  }
  const metrics: Partial<Record<ClassesKey, number>> = {
    fillRate: orUndefined(fillRate(t)),
    showRate: orUndefined(showRate(t)),
    avgPerClass: orUndefined(avgPerClass(t)),
    visits: t.visits,
    uniqueClients: t.clients.size,
    classes: t.classes,
    personal,
    cancelRate: orUndefined(cancelRate(t)),
    noShows: t.noShows,
    cancelledClasses,
  };
  return { metrics, unmarked: t.unmarked };
}

/**
 * Точки графика плитки (окно «По месяцам / неделям / дням»): у долей и
 * среднего — сумма и знаменатель по занятию (lib/dashboard-series.ts, avg),
 * у счётчиков — число штук. `withRows` — со строками подробного отчёта:
 * занятие (тренировка, время, тренер, число) или, у «Не пришли» и
 * персональных, клиент — для них записи нужны с карточкой (не light).
 */
export function classesSeries(
  entries: ClassEntry[],
  now: number,
  key: Exclude<ClassesKey, "uniqueClients">,
  withRows = false,
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const e of entries) {
    const point = (amount: number, n: number, value?: number) =>
      out.push({
        date: e.date,
        amount,
        n,
        ...(withRows && { row: entryRow(e, value) }),
      });
    if (key === "personal") {
      if (e.kind !== "personal" || e.cancelled || e.startsAt > now) continue;
      if (!withRows) {
        point(0, entryCounts(e).visits);
        continue;
      }
      for (const b of e.bookings)
        if (b.status === "attended")
          out.push({ date: e.date, amount: 0, n: 1, row: bookingRow(e, b) });
      continue;
    }
    if (key === "cancelledClasses") {
      if (e.kind === "group" && e.cancelled) point(0, 1);
      continue;
    }
    if (!isHeld(e, now)) continue;
    const c = entryCounts(e);
    if (key === "visits") point(0, c.visits, c.visits);
    else if (key === "noShows") {
      if (!withRows) point(0, c.noShows);
      else
        for (const b of e.bookings)
          if (b.status === "no_show")
            out.push({ date: e.date, amount: 0, n: 1, row: bookingRow(e, b) });
    } else if (key === "classes") point(0, 1, c.visits);
    else if (key === "avgPerClass") point(c.visits, 1, c.visits);
    else if (key === "fillRate") {
      if (e.capacity) point(c.visits * 100, e.capacity, (c.visits / e.capacity) * 100);
    } else if (key === "showRate") {
      const marked = c.visits + c.noShows;
      point(c.visits * 100, marked, marked ? (c.visits / marked) * 100 : undefined);
    } else {
      const base = c.cancelled + c.held;
      // В отчёте — только занятия с отменами.
      out.push({
        date: e.date,
        amount: c.cancelled * 100,
        n: base,
        ...(withRows && c.cancelled > 0 && { row: entryRow(e, c.cancelled) }),
      });
    }
  }
  return out;
}

/** «Пн 19:00 · Иванова» — когда и кто вёл. */
function entryWhen(e: ClassEntry) {
  const trainers = e.trainers.map((t) => t.name).join(", ");
  return [`${WEEKDAYS[e.weekday]} ${e.time}`, trainers].filter(Boolean).join(" · ");
}

/** Занятие строкой отчёта: тренировка, день, время и тренер, число справа. */
function entryRow(e: ClassEntry, value?: number): DetailRow {
  return { key: `entry:${e.id}`, date: e.date, name: e.workoutName, title: entryWhen(e), value };
}

/** Запись на занятие строкой отчёта: клиент, тренировка и когда. */
function bookingRow(e: ClassEntry, b: ClassBooking): DetailRow {
  return {
    key: `booking:${e.id}:${b.clientId ?? b.userId ?? b.client}`,
    date: e.date,
    clientId: b.clientId ?? null,
    userId: b.clientId ? null : (b.userId ?? null),
    title: e.workoutName,
    note: entryWhen(e),
    value: 1,
  };
}

// ---------------------------------------------------------------------------
// Загрузка расписания: дни недели × часы

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

export type HeatCell = {
  weekday: number;
  hour: number;
  classes: number;
  avg: number;
  fill: number | null;
};

/**
 * Средняя посещаемость занятий по дню недели и часу начала. Часы — от
 * первого до последнего, где были занятия, без пропусков: пустой час тоже
 * строка сетки.
 */
export function heatmap(entries: ClassEntry[], now: number) {
  const tallies = tallyBy(entries, now, (e) => [`${e.weekday}|${Number(e.time.slice(0, 2))}`]);
  const cells: HeatCell[] = [];
  for (const [key, t] of tallies) {
    const [weekday, hour] = key.split("|").map(Number);
    cells.push({ weekday, hour, classes: t.classes, avg: avgPerClass(t) ?? 0, fill: fillRate(t) });
  }
  const hours: number[] = [];
  if (cells.length) {
    const lo = Math.min(...cells.map((c) => c.hour));
    const hi = Math.max(...cells.map((c) => c.hour));
    for (let h = lo; h <= hi; h++) hours.push(h);
  }
  return { cells, hours, max: Math.max(0, ...cells.map((c) => c.avg)) };
}

// ---------------------------------------------------------------------------
/** «3 занятия», «5 занятий». */
export function classesText(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "занятие"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "занятия"
        : "занятий";
  return `${formatNumber(n)} ${word}`;
}
