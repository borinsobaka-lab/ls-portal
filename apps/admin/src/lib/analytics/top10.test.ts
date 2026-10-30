import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import { iterRows, openWorkbook, type Cell, type Inflate } from "./onec/xlsx-read";
import {
  buildTop10Workbook,
  top10DefaultMonths,
  top10FileName,
  top10MonthOptions,
  top10MonthsLabel,
  top10Rank,
  top10Rows,
  top10SheetName,
  top10SourceNote,
  TOP10_RANKINGS,
  type Top10Data,
} from "./top10";

const inflate: Inflate = async function* (data) {
  for await (const c of Readable.from([Buffer.from(data)]).pipe(createInflateRaw())) {
    yield c as Uint8Array;
  }
};

const city = (
  month: string,
  name: string,
  v: Partial<Record<"day_base" | "bought_day" | "sales" | "repeat_old" | "returned", number>>,
) => ({
  month,
  city: name,
  booked: 0,
  attended: v.day_base ?? 0,
  day_base: v.day_base ?? 0,
  bought_day: v.bought_day ?? 0,
  window_base: v.day_base ?? 0,
  bought_14: v.bought_day ?? 0,
  sales: v.sales ?? 0,
  new: (v.sales ?? 0) - (v.repeat_old ?? 0),
  repeat_old: v.repeat_old ?? 0,
  returned: v.returned ?? 0,
});

const DATA: Top10Data = {
  generated_at: "2026-10-19T06:00:00.000000+00:00",
  sales_min: "2018-10-31",
  sales_max: "2026-10-16",
  funnel_min: "2026-01-04",
  funnel_max: "2026-10-31",
  returned_ready: true,
  rows: [
    city("2026-09", "Ярославль", { day_base: 10, bought_day: 5, sales: 20, repeat_old: 8 }),
    city("2026-08", "Омск", { day_base: 4, bought_day: 2, sales: 9, repeat_old: 5, returned: 2 }),
    city("2026-08", "Абакан", {
      day_base: 10,
      bought_day: 5,
      sales: 9,
      repeat_old: 5,
      returned: 2,
    }),
    city("2026-08", "Бийск", { day_base: 0, bought_day: 0, sales: 3, repeat_old: 3, returned: 3 }),
    city("2026-08", "Тверь", { day_base: 9, bought_day: 1 }),
  ],
};

describe("Топ-10 городов (их partner-rankings)", () => {
  test("рейтинги: равенство конверсии — больше покупок, затем город; база 0 и нулевой результат — вне рейтинга", () => {
    const rows = top10Rows(DATA).filter((r) => r.month === "2026-08");
    const [day, , renewals, returned] = TOP10_RANKINGS;
    // Абакан и Омск — по 50 %: выше Абакан (5 покупок против 2); у Бийска база 0.
    expect(top10Rank(rows, day).map((r) => r.city)).toEqual(["Абакан", "Омск", "Тверь"]);
    // Продления = прежние продления − возвращённые: Абакан 3, Омск 3, Бийск 0 — вне рейтинга.
    expect(top10Rank(rows, renewals).map((r) => [r.city, r.renewals])).toEqual([
      ["Абакан", 3],
      ["Омск", 3],
    ]);
    expect(top10Rank(rows, returned).map((r) => [r.city, r.returned])).toEqual([
      ["Бийск", 3],
      ["Абакан", 2],
      ["Омск", 2],
    ]);
  });

  test("подписи, имя файла, месяцы по умолчанию — два месяца до последних продаж", () => {
    expect(top10SheetName("2026-08")).toBe("Август 2026");
    expect(top10MonthsLabel(["2026-08", "2026-09"])).toBe("август и сентябрь 2026");
    expect(top10MonthsLabel(["2025-12", "2026-01"])).toBe("декабрь 2025 и январь 2026");
    expect(top10MonthsLabel(["2026-07", "2026-08", "2026-09"])).toBe(
      "июль, август и сентябрь 2026",
    );
    expect(top10FileName(["2026-08", "2026-09"])).toBe("Топ-10_август_сентябрь_2026.xlsx");
    expect(top10FileName(["2025-12", "2026-01"])).toBe("Топ-10_декабрь_2025_январь_2026.xlsx");
    expect(top10MonthOptions(DATA)[0]).toBe("2018-10");
    expect(top10MonthOptions(DATA).at(-1)).toBe("2026-10");
    expect(top10DefaultMonths(DATA)).toEqual(["2026-08", "2026-09"]);
    expect(top10SourceNote(DATA)).toBe(
      "Источник: своды 1С от 19.10.2026; история покупок 31.10.2018–16.10.2026.",
    );
  });

  test("книга: листы месяцев с формулами на «Все города» и сохранёнными значениями", async () => {
    const bytes = await buildTop10Workbook(DATA, ["2026-08", "2026-09"]);
    const wb = await openWorkbook(bytes, inflate);
    expect(wb.sheets.map((s) => s.name)).toEqual(["Август 2026", "Сентябрь 2026", "Все города"]);
    const read = async (i: number, formulas: boolean) => {
      const rows: Cell[][] = [];
      for await (const r of iterRows(await wb.open(i, { formulas }))) rows.push(r);
      return rows;
    };
    const detail = await read(2, false);
    expect(detail[1][0]).toBe("Города · август и сентябрь 2026");
    expect(detail[3].slice(0, 3)).toEqual(["Месяц", "Городская группа", "Записались"]);
    // Строки — по месяцу, затем по городу; обычные продления = 5 − 2.
    expect(detail.slice(4, 9).map((r) => [r[0], r[1], r[12], r[13]])).toEqual([
      ["2026-08", "Абакан", 3, 0.5],
      ["2026-08", "Бийск", 0, "—"],
      ["2026-08", "Омск", 3, 0.5],
      ["2026-08", "Тверь", 0, 1 / 9],
      ["2026-09", "Ярославль", 8, 0.5],
    ]);
    expect((await read(2, true))[4][13]).toBe('=IF(E5=0,"—",F5/E5)');

    const august = await read(0, false);
    expect(august[1][0]).toBe("Август 2026 · топ-10 городов");
    expect(august[4][0]).toBe("Покупка в день пробного");
    expect(august[5].slice(0, 5)).toEqual(["Место", "Город", "Пришли", "Купили", "Конверсия"]);
    expect(august[6].slice(0, 5)).toEqual([1, "Абакан", 10, 5, 0.5]);
    expect(august[20][7]).toBe("Топ по возвращённым");
    expect(august[22].slice(7, 12)).toEqual([1, "Бийск", 3, 0, 3]);
    expect(august[36][0]).toBe(
      "Источник: своды 1С от 19.10.2026; история покупок 31.10.2018–16.10.2026.",
    );
    const formulas = await read(0, true);
    expect(formulas[6].slice(1, 5)).toEqual([
      "='Все города'!B5",
      "='Все города'!E5",
      "='Все города'!F5",
      "='Все города'!N5",
    ]);
  });
});
