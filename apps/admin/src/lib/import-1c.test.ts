import { describe, expect, test } from "bun:test";

import {
  addChunkResult,
  emptyChunkResult,
  importChunks,
  parseImportFile,
  summarizeImport,
  type ImportFile,
} from "./import-1c";

const file: ImportFile = {
  version: 2,
  source: "1С, выгрузка 2026-10-17",
  studios: { vake: "Lady Stretch Vake", saburtalo: "Lady Stretch Saburtalo" },
  clients: [
    {
      ref: "1c-1",
      studio: "vake",
      email: "a@example.com",
      memberships: [
        { ref: "1-1/16/1", kind: "sale", catalog: "Пакет 16", debt: 195 },
        { ref: "1-2/24/1", kind: "history", catalog: "Premium 24" },
      ],
    },
    {
      ref: "1c-2",
      studio: "saburtalo",
      email: null,
      memberships: [{ ref: "1-3/50/2", kind: "sale", catalog: "Premium 50", debt: 0 }],
    },
    { ref: "1c-3", studio: "vake", email: null, memberships: [] },
  ],
};

describe("файл заливки из 1С", () => {
  test("разбор: верный файл", () => {
    expect(parseImportFile(JSON.stringify(file)).clients).toHaveLength(3);
  });

  test("разбор: понятные ошибки", () => {
    expect(() => parseImportFile("{")).toThrow("не удалось прочитать JSON");
    expect(() => parseImportFile(JSON.stringify({ ...file, version: 1 }))).toThrow(
      "старый файл заливки",
    );
    expect(() => parseImportFile(JSON.stringify({ ...file, version: 3 }))).toThrow(
      "не файл заливки из 1С",
    );
    expect(() => parseImportFile(JSON.stringify({ ...file, studios: {} }))).toThrow(
      "не указаны клубы",
    );
    expect(() => parseImportFile(JSON.stringify({ ...file, clients: [] }))).toThrow("нет клиентов");
    const strange = { ...file, clients: [{ ...file.clients[0], studio: "moscow" }] };
    expect(() => parseImportFile(JSON.stringify(strange))).toThrow("неизвестный клуб «moscow»");
    const twice = { ...file, clients: [file.clients[0], file.clients[0]] };
    expect(() => parseImportFile(JSON.stringify(twice))).toThrow("встречается дважды");
  });

  test("сводка: клиенты, почта, продажи, долги, история", () => {
    const s = summarizeImport(file);
    expect(s).toMatchObject({
      source: "1С, выгрузка 2026-10-17",
      studios: ["Lady Stretch Vake", "Lady Stretch Saburtalo"],
      clients: 3,
      withEmail: 1,
      sales: 2,
      withDebt: 1,
      history: 1,
    });
    expect(s.byCatalog.map((c) => c.catalog).sort()).toEqual(["Premium 50", "Пакет 16"]);
    expect(s.byCatalog.every((c) => c.count === 1)).toBe(true);
  });

  test("пачки: клубы в каждой, клиенты по порядку", () => {
    const chunks = importChunks(file, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].studios).toEqual(file.studios);
    expect(chunks[1].catalog).toEqual(["Premium 24", "Premium 50", "Пакет 16"]);
    expect(chunks.flatMap((c) => c.clients.map((x) => x.ref))).toEqual(["1c-1", "1c-2", "1c-3"]);
  });

  test("итог пачек складывается, мусор в ответе не ломает счёт", () => {
    let t = emptyChunkResult();
    t = addChunkResult(t, { clients_created: 2, sales_created: 1, history_created: 1 });
    t = addChunkResult(t, { clients_existing: 1, sales_skipped: "x" });
    t = addChunkResult(t, null);
    expect(t.clients_created).toBe(2);
    expect(t.clients_existing).toBe(1);
    expect(t.sales_created).toBe(1);
    expect(t.sales_skipped).toBe(0);
  });
});
