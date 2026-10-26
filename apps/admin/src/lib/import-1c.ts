// Перенос клиентов и абонементов из 1С (страница «Импорт из 1С», 2026-10-18).
// Файл заливки готовят из выгрузки 1С (скрипт в эту копию не входит);
// страница проверяет его, показывает, что будет перенесено, и отдаёт базе
// пачками (RPC import_1c_chunk, db/migrations/2026-10-18_import_1c.sql) —
// одна большая транзакция упёрлась бы в лимит времени запроса. Повтор той же
// пачки ничего не задваивает: база узнаёт перенесённое по ключам 1С.
// Без React — покрыто тестом import-1c.test.ts.

export type ImportMembership = {
  ref: string;
  kind: "sale" | "history";
  catalog: string;
  debt?: number;
};

export type ImportClient = {
  ref: string;
  studio: string;
  email: string | null;
  memberships: ImportMembership[];
};

export type ImportFile = {
  /** 2 — без служебной заметки «Перенесено из 1С…» (2026-10-18). */
  version: 2;
  source?: string;
  /** Ключ клуба в файле → название пакетного клуба в «Клубах». */
  studios: Record<string, string>;
  clients: ImportClient[];
};

export type ImportSummary = {
  source: string | null;
  studios: string[];
  clients: number;
  withEmail: number;
  sales: number;
  withDebt: number;
  history: number;
  /** Абонементы по номенклатуре (продажи), по убыванию. */
  byCatalog: { catalog: string; count: number }[];
};

export const CHUNK_RESULT_KEYS = [
  "clients_created",
  "clients_existing",
  "clients_reused",
  "sales_created",
  "sales_skipped",
  "history_created",
  "history_skipped",
] as const;

export type ChunkResult = Record<(typeof CHUNK_RESULT_KEYS)[number], number>;

/** Клиентов в пачке: ~150 мс в базе, далеко от лимита запроса. */
export const IMPORT_CHUNK_SIZE = 100;

/** Разбор файла заливки; ошибка — понятным текстом для администратора. */
export function parseImportFile(text: string): ImportFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Это не файл заливки: не удалось прочитать JSON");
  }
  const f = data as (Omit<Partial<ImportFile>, "version"> & { version?: unknown }) | null;
  if (f?.version === 1) {
    throw new Error("Это старый файл заливки — возьмите новый (без заметки «Перенесено из 1С»)");
  }
  if (!f || typeof f !== "object" || f.version !== 2) {
    throw new Error("Это не файл заливки из 1С");
  }
  if (!f.studios || typeof f.studios !== "object" || Object.keys(f.studios).length === 0) {
    throw new Error("В файле не указаны клубы");
  }
  if (!Array.isArray(f.clients) || f.clients.length === 0) {
    throw new Error("В файле нет клиентов");
  }
  const refs = new Set<string>();
  for (const c of f.clients) {
    if (!c || typeof c.ref !== "string" || !Array.isArray(c.memberships)) {
      throw new Error("Файл повреждён: у клиента нет ключа 1С или списка абонементов");
    }
    if (!(c.studio in f.studios)) {
      throw new Error(`Файл повреждён: у клиента ${c.ref} неизвестный клуб «${c.studio}»`);
    }
    if (refs.has(c.ref)) throw new Error(`Файл повреждён: клиент ${c.ref} встречается дважды`);
    refs.add(c.ref);
  }
  return f as ImportFile;
}

export function summarizeImport(file: ImportFile): ImportSummary {
  const byCatalog = new Map<string, number>();
  let sales = 0;
  let withDebt = 0;
  let history = 0;
  for (const c of file.clients) {
    for (const m of c.memberships) {
      if (m.kind === "history") {
        history++;
        continue;
      }
      sales++;
      if (m.debt && m.debt > 0) withDebt++;
      byCatalog.set(m.catalog, (byCatalog.get(m.catalog) ?? 0) + 1);
    }
  }
  return {
    source: file.source ?? null,
    studios: Object.values(file.studios),
    clients: file.clients.length,
    withEmail: file.clients.filter((c) => c.email).length,
    sales,
    withDebt,
    history,
    byCatalog: [...byCatalog]
      .map(([catalog, count]) => ({ catalog, count }))
      .sort((a, b) => b.count - a.count || a.catalog.localeCompare(b.catalog, "ru")),
  };
}

/**
 * Пачки для import_1c_chunk: клубы и вся номенклатура файла (база проверяет
 * её с первой же пачки) + часть клиентов.
 */
export function importChunks(file: ImportFile, size = IMPORT_CHUNK_SIZE) {
  const catalog = [
    ...new Set(file.clients.flatMap((c) => c.memberships.map((m) => m.catalog))),
  ].sort();
  const chunks: { studios: Record<string, string>; catalog: string[]; clients: ImportClient[] }[] =
    [];
  for (let i = 0; i < file.clients.length; i += size) {
    chunks.push({ studios: file.studios, catalog, clients: file.clients.slice(i, i + size) });
  }
  return chunks;
}

export function emptyChunkResult(): ChunkResult {
  return Object.fromEntries(CHUNK_RESULT_KEYS.map((k) => [k, 0])) as ChunkResult;
}

/** Итог по пачкам: ответ базы складывается с уже накопленным. */
export function addChunkResult(total: ChunkResult, part: unknown): ChunkResult {
  const p = (part ?? {}) as Partial<Record<string, unknown>>;
  const next = { ...total };
  for (const k of CHUNK_RESULT_KEYS) next[k] += Number(p[k]) || 0;
  return next;
}
