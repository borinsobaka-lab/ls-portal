import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

import type { Cell, Inflate } from "../onec/xlsx-read";
import { writeXlsx } from "../onec/xlsx-write";
import {
  dateText,
  MAX_REVIEWS_FILE_BYTES,
  pyFloatStr,
  ratingValue,
  reviewPeriod,
  reviewRecords,
  sha256Hex,
  trainerText,
} from "./parse";
import { readXls } from "./xls-read";

const inflate: Inflate = async function* (data) {
  const s = Readable.from([Buffer.from(data)]).pipe(createInflateRaw());
  for await (const c of s) yield c as Uint8Array;
};

const HEADERS = [
  "Клиент",
  "Группа клиентов",
  "Возраст",
  "Пол",
  "Занятие.Структурная единица",
  "Услуга",
  "Дата",
  "Время",
  "Тренер",
  "Дата оценки",
  "Оценка",
  "Комментарий",
];

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const xlsx = (rows: Cell[][]) => writeXlsx([{ name: "Оценки", rows }]);

/**
 * Строки синтетической выгрузки — те же, что в fixtures/ratings.xls (её
 * сохранил LibreOffice из книги с этими строками): длинные комментарии с
 * эмодзи растягивают таблицу строк .xls на несколько записей CONTINUE.
 */
function syntheticRows(): Cell[][] {
  const studios = ["Абакан", "Барнаул, пр. Ленина, 1", "Самара Ёлочная"];
  const rows: Cell[][] = [HEADERS];
  for (let i = 1; i <= 40; i++) {
    const comment = i % 3 === 0 ? "" : `Отзыв ${i}: очень понравилось 😊 занятие, `.repeat(12);
    const rating = i % 7 === 0 ? 3 : i % 11 === 0 ? 4.5 : 5;
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push([
      `Клиентка ${i}`,
      "Клиенты",
      String(20 + (i % 30)),
      "Женский",
      studios[i % 3],
      "Stretching",
      `${day}.09.2026`,
      "19:00",
      `Тренер ${i % 5} (Группа)`,
      `${day}.09.2026`,
      rating,
      comment,
    ]);
  }
  return rows;
}

describe("правила их reviews.py", () => {
  test("str(float) Python", () => {
    expect([5, 4.5, 0, -0, 1e-7, 1e-5, 0.0001, 0.00009999, 1e16].map(pyFloatStr)).toEqual([
      "5.0",
      "4.5",
      "0.0",
      "-0.0",
      "1e-07",
      "1e-05",
      "0.0001",
      "9.999e-05",
      "1e+16",
    ]);
    expect(pyFloatStr(9999999999999998)).toBe("9999999999999998.0");
    expect(pyFloatStr(1.2345678901234568e17)).toBe("1.2345678901234568e+17");
    expect(pyFloatStr(79161234567)).toBe("79161234567.0");
  });

  test("тренер — без пометок в скобках и лишних пробелов", () => {
    expect(trainerText("  Иванова   Анна (Группа) (зал 2) ")).toBe("Иванова Анна");
    expect(trainerText("Петрова (Мария) Ивановна")).toBe("Петрова Ивановна");
    expect(trainerText("Сидорова (основной (старый))")).toBe("Сидорова (основной)");
  });

  test("даты — ГГГГ-ММ-ДД в их трёх видах, остальное как есть", () => {
    expect(dateText("05.09.2026")).toBe("2026-09-05");
    expect(dateText("5.9.2026")).toBe("2026-09-05");
    expect(dateText("2026-9-5")).toBe("2026-09-05");
    expect(dateText("05/09/2026")).toBe("2026-09-05");
    expect(dateText(" 31.02.2026 ")).toBe("31.02.2026");
    expect(dateText("сентябрь 2026")).toBe("сентябрь 2026");
  });

  test("оценка — число от 0 до 5, с точкой или запятой", () => {
    expect(ratingValue("4,5")).toBe(4.5);
    expect(ratingValue(" 5 ")).toBe(5);
    expect(ratingValue("0")).toBe(0);
    expect(ratingValue("1_0e-1")).toBe(1);
    const nonNumber = "В колонке «Оценка» найдено нечисловое значение.";
    expect(() => ratingValue("")).toThrow(nonNumber);
    expect(() => ratingValue("пять")).toThrow(nonNumber);
    expect(() => ratingValue("4,5,1")).toThrow(nonNumber);
    const range = "Оценка должна быть числом от 0 до 5.";
    expect(() => ratingValue("5.01")).toThrow(range);
    expect(() => ratingValue("-1")).toThrow(range);
    expect(() => ratingValue("inf")).toThrow(range);
  });

  test("SHA-256 — как hashlib (длины на границах блоков, юникод)", () => {
    for (let n = 0; n <= 140; n++) {
      const s = "ж".repeat(n >> 1) + "x".repeat(n & 1);
      expect(sha256Hex(s)).toBe(sha(s));
    }
    const s = `Клиентка\x1fАбакан\x1f😊\x1f5.0`;
    expect(sha256Hex(s)).toBe(sha(s));
  });
});

describe("разбор выгрузки", () => {
  test(".xlsx: поля, отпечаток, пустые строки, период", async () => {
    const bytes = await xlsx([
      ["Комментарий", ...HEADERS.slice(0, 11), "Лишняя"],
      [
        "  Спасибо!  ",
        "Иванова Анна",
        null,
        30,
        "Ж",
        "Абакан",
        "Стретчинг",
        "01.10.2026",
        "10:00",
        "Петрова (Группа)",
        "2026-10-02",
        "4,5",
        "x",
      ],
      [null, null, null, null, null, null, null, null, null, null, null, null, null],
      [
        "",
        "Сидорова Мария",
        "Клиенты",
        null,
        null,
        "Барнаул",
        "Йога",
        "03/10/2026",
        "11:00",
        "Кузнецова",
        "03.10.2026",
        5,
        null,
      ],
    ]);
    const records = await reviewRecords("оценки.XLSX", bytes, inflate);
    expect(records).toHaveLength(2);
    const [a, b] = records;
    expect(a).toMatchObject({
      client_name: "Иванова Анна",
      studio: "Абакан",
      service: "Стретчинг",
      class_date: "2026-10-01",
      class_time: "10:00",
      trainer: "Петрова",
      rating_date: "2026-10-02",
      rating: 4.5,
      comment: "Спасибо!",
      client_group: "",
      age: "30",
      gender: "Ж",
    });
    expect(a.source_hash).toBe(
      sha(
        [
          "Иванова Анна",
          "Абакан",
          "Стретчинг",
          "2026-10-01",
          "10:00",
          "Петрова",
          "2026-10-02",
          "4.5",
          "Спасибо!",
        ].join("\x1f"),
      ),
    );
    expect(b).toMatchObject({
      class_date: "2026-10-03",
      rating: 5,
      comment: "",
      client_group: "Клиенты",
    });
    expect(b.source_hash).toBe(
      sha(
        [
          "Сидорова Мария",
          "Барнаул",
          "Йога",
          "2026-10-03",
          "11:00",
          "Кузнецова",
          "2026-10-03",
          "5.0",
          "",
        ].join("\x1f"),
      ),
    );
    expect(reviewPeriod(records)).toEqual({ from: "2026-10-02", to: "2026-10-03" });
  });

  test(".xls (BIFF8, CONTINUE, эмодзи) — те же строки, что .xlsx", async () => {
    const xls = new Uint8Array(readFileSync(new URL("./fixtures/ratings.xls", import.meta.url)));
    const rows = readXls(xls);
    expect(rows).toHaveLength(41);
    expect(rows[0]).toEqual(HEADERS);
    expect(rows[1].slice(0, 5)).toEqual([
      "Клиентка 1",
      "Клиенты",
      "21",
      "Женский",
      "Барнаул, пр. Ленина, 1",
    ]);
    expect(rows[11][10]).toBe(4.5);

    const fromXls = await reviewRecords("ratings.xls", xls, inflate);
    const fromXlsx = await reviewRecords("ratings.xlsx", await xlsx(syntheticRows()), inflate);
    expect(fromXls).toHaveLength(40);
    expect(fromXls).toEqual(fromXlsx);
    expect(fromXls[0].comment).toContain("😊");
    expect(fromXls[0].trainer).toBe("Тренер 1");
    expect(new Set(fromXls.map((r) => r.source_hash)).size).toBe(40);
    expect(reviewPeriod(fromXls)).toEqual({ from: "2026-09-01", to: "2026-09-28" });
  });

  test("ошибки — их тексты", async () => {
    const ok = await xlsx(syntheticRows());
    await expect(reviewRecords("оценки.csv", ok, inflate)).rejects.toThrow(
      "Загрузите выгрузку в формате .xls или .xlsx.",
    );
    await expect(reviewRecords("оценки.xlsx", new Uint8Array(), inflate)).rejects.toThrow(
      "Загрузите Excel-файл размером не больше 12 МБ.",
    );
    await expect(
      reviewRecords("оценки.xlsx", new Uint8Array(MAX_REVIEWS_FILE_BYTES + 1), inflate),
    ).rejects.toThrow("Загрузите Excel-файл размером не больше 12 МБ.");
    await expect(reviewRecords("оценки.xlsx", new Uint8Array([1, 2, 3]), inflate)).rejects.toThrow(
      "Не удалось прочитать .xlsx-файл.",
    );
    await expect(reviewRecords("оценки.xls", new Uint8Array(600), inflate)).rejects.toThrow(
      "Не удалось прочитать .xls-файл.",
    );
    await expect(
      reviewRecords("оценки.xlsx", await xlsx([["Клиент", "Оценка", "Тренер"]]), inflate),
    ).rejects.toThrow(
      "Не найдены обязательные колонки: Занятие.Структурная единица, Услуга, Дата, Время, Дата оценки, Комментарий.",
    );
    await expect(reviewRecords("оценки.xlsx", await xlsx([HEADERS]), inflate)).rejects.toThrow(
      "В выгрузке нет строк с оценками.",
    );
    const rows = syntheticRows().slice(0, 3);
    rows[2] = [...rows[2]];
    rows[2][0] = " ";
    await expect(reviewRecords("оценки.xlsx", await xlsx(rows), inflate)).rejects.toThrow(
      "Строка 3: заполните клиента, студию, дату занятия и дату оценки.",
    );
    rows[2][0] = "Клиентка";
    rows[2][10] = "отлично";
    await expect(reviewRecords("оценки.xlsx", await xlsx(rows), inflate)).rejects.toThrow(
      "В колонке «Оценка» найдено нечисловое значение.",
    );
  });
});
