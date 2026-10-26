import { describe, expect, test } from "bun:test";

import {
  classesMetrics,
  classesSeries,
  heatmap,
  repeatRate,
  tallyBy,
  type ClassBooking,
  type ClassEntry,
} from "./dashboard-classes";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const PAST = Date.parse("2026-10-10T09:00:00Z");
const FUTURE = Date.parse("2026-10-20T09:00:00Z");

let seq = 0;
function entry(p: Partial<ClassEntry> & { bookings?: ClassBooking[] }): ClassEntry {
  seq++;
  return {
    id: `e${seq}`,
    studioId: "s1",
    kind: "group",
    startsAt: PAST,
    date: "2026-10-10",
    weekday: 4,
    time: "09:00",
    cancelled: false,
    workoutId: "w1",
    workoutName: "Стретчинг",
    workoutColor: null,
    capacity: 10,
    trainers: [{ id: "t1", name: "Анна" }],
    bookings: [],
    ...p,
  };
}

const b = (status: string, client: string | null = null) => ({ status, client });

describe("classesMetrics", () => {
  test("считает только начавшиеся групповые занятия без отмены", () => {
    const entries = [
      entry({ bookings: [b("attended", "a"), b("attended", "b"), b("no_show", "c")] }),
      entry({ startsAt: FUTURE, bookings: [b("booked", "a")] }),
      entry({ cancelled: true, bookings: [b("cancelled", "a")] }),
      entry({ kind: "personal", capacity: 1, bookings: [b("attended", "a")] }),
      entry({ kind: "other", bookings: [] }),
    ];
    const { metrics, unmarked } = classesMetrics(entries, NOW);
    expect(metrics.classes).toBe(1);
    expect(metrics.visits).toBe(2);
    expect(metrics.noShows).toBe(1);
    expect(metrics.personal).toBe(1);
    expect(metrics.cancelledClasses).toBe(1);
    expect(metrics.uniqueClients).toBe(2);
    expect(metrics.avgPerClass).toBe(2);
    expect(metrics.fillRate).toBe(20);
    expect(metrics.showRate).toBeCloseTo((2 / 3) * 100);
    expect(unmarked).toBe(0);
  });

  test("заполняемость — только по занятиям с лимитом мест", () => {
    const entries = [
      entry({ capacity: 4, bookings: [b("attended", "a"), b("attended", "b")] }),
      entry({ capacity: null, bookings: [b("attended", "c"), b("attended", "d")] }),
    ];
    expect(classesMetrics(entries, NOW).metrics.fillRate).toBe(50);
  });

  test("без отметки — не в доходимости, но место занято", () => {
    const entries = [
      entry({ bookings: [b("attended", "a"), b("booked", "b"), b("cancelled", "c")] }),
    ];
    const { metrics, unmarked } = classesMetrics(entries, NOW);
    expect(metrics.showRate).toBe(100);
    expect(unmarked).toBe(1);
    // Отменённая — одна из трёх записей (лист ожидания не в счёт).
    expect(metrics.cancelRate).toBeCloseTo((1 / 3) * 100);
  });

  test("нет занятий — доли не посчитать", () => {
    const { metrics } = classesMetrics([], NOW);
    expect(metrics.fillRate).toBeUndefined();
    expect(metrics.showRate).toBeUndefined();
    expect(metrics.avgPerClass).toBeUndefined();
    expect(metrics.visits).toBe(0);
  });
});

describe("tallyBy", () => {
  test("занятие с двумя тренерами — у обоих; повторные визиты по тренеру", () => {
    const two = [
      { id: "t1", name: "Анна" },
      { id: "t2", name: "Мария" },
    ];
    const entries = [
      entry({ trainers: two, bookings: [b("attended", "a"), b("attended", "b")] }),
      entry({ bookings: [b("attended", "a")] }),
    ];
    const byTrainer = tallyBy(entries, NOW, (e) => e.trainers.map((t) => t.id));
    expect(byTrainer.get("t1")?.classes).toBe(2);
    expect(byTrainer.get("t2")?.classes).toBe(1);
    expect(repeatRate(byTrainer.get("t1")!)).toBe(50);
    expect(repeatRate(byTrainer.get("t2")!)).toBe(0);
  });
});

describe("heatmap", () => {
  test("средняя посещаемость по дню и часу, часы без пропусков", () => {
    const entries = [
      entry({ weekday: 0, time: "09:30", bookings: [b("attended", "a"), b("attended", "b")] }),
      entry({ weekday: 0, time: "09:00", bookings: [] }),
      entry({ weekday: 2, time: "12:00", bookings: [b("attended", "a")] }),
    ];
    const h = heatmap(entries, NOW);
    expect(h.hours).toEqual([9, 10, 11, 12]);
    expect(h.cells.find((c) => c.weekday === 0 && c.hour === 9)).toMatchObject({
      classes: 2,
      avg: 1,
      fill: 10,
    });
    expect(h.max).toBe(1);
  });
});

describe("classesSeries", () => {
  test("доли — сумма и знаменатель по занятию", () => {
    const entries = [entry({ capacity: 4, bookings: [b("attended", "a"), b("no_show", "b")] })];
    expect(classesSeries(entries, NOW, "fillRate")).toEqual([
      { date: "2026-10-10", amount: 100, n: 4 },
    ]);
    expect(classesSeries(entries, NOW, "showRate")).toEqual([
      { date: "2026-10-10", amount: 100, n: 2 },
    ]);
    expect(classesSeries(entries, NOW, "visits")).toEqual([
      { date: "2026-10-10", amount: 0, n: 1 },
    ]);
  });
});
