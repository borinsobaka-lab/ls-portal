import { describe, expect, test } from "bun:test";

import { aggregate, bucketKey, buildBuckets, seriesTotal } from "./dashboard-series";

describe("buildBuckets", () => {
  test("месяцы: 12 штук, последний — месяц якоря", () => {
    const b = buildBuckets("month", new Date(2026, 9, 11));
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(b[11]).toMatchObject({ from: "2026-10-01", to: "2026-10-31", label: "октябрь 2026" });
  });

  test("недели — с понедельника по воскресенье", () => {
    const b = buildBuckets("week", new Date(2026, 9, 11)); // воскресенье
    expect(b).toHaveLength(12);
    expect(b[11]).toMatchObject({ from: "2026-10-05", to: "2026-10-11" });
    expect(b[10]).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
  });

  test("дни: 30 подряд, заканчивая якорем", () => {
    const b = buildBuckets("day", new Date(2026, 2, 1));
    expect(b).toHaveLength(30);
    expect(b[29].from).toBe("2026-03-01");
    expect(b[28].from).toBe("2026-02-28");
  });
});

describe("bucketKey", () => {
  test("дата попадает в свою корзину", () => {
    expect(bucketKey("month", "2026-10-31")).toBe("2026-10-01");
    expect(bucketKey("week", "2026-10-04")).toBe("2026-09-28");
    expect(bucketKey("day", "2026-10-04")).toBe("2026-10-04");
  });
});

describe("aggregate", () => {
  const buckets = buildBuckets("month", new Date(2026, 9, 1));
  const points = [
    { date: "2026-10-02", amount: 1000, n: 1 },
    { date: "2026-10-20", amount: 3000, n: 1 },
    { date: "2026-10-21", amount: -500, n: 0 }, // возврат: в сумму, не в сделки
    { date: "2026-09-15", amount: 2000, n: 1 },
    { date: "2024-01-01", amount: 9999, n: 1 }, // вне окна
  ];

  test("сумма, штуки и среднее по корзинам", () => {
    const sum = aggregate("month", buckets, points, "sum");
    expect(sum[11].value).toBe(3500);
    expect(sum[10].value).toBe(2000);
    expect(sum[0].value).toBe(0);

    expect(aggregate("month", buckets, points, "count")[11].value).toBe(2);

    const avg = aggregate("month", buckets, points, "avg");
    expect(avg[11].value).toBe(1750);
    expect(avg[0].value).toBeNull();
  });

  test("итог среднего — общий средний, а не среднее средних", () => {
    const avg = aggregate("month", buckets, points, "avg");
    expect(seriesTotal("avg", avg)).toBe(5500 / 3);
    expect(seriesTotal("sum", aggregate("month", buckets, points, "sum"))).toBe(5500);
  });
});
