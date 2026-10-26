/**
 * «Аналитика сети» → «Загрузка данных»: отправка разобранной выгрузки в базу
 * (RPC an_import_start → an_import_rows пачками → an_import_finish,
 * db/migrations/2026-10-26_zzz_analytics_network.sql). Пока загрузка не
 * завершена, отчёты её не видят; сбой посреди — незавершённую загрузку
 * удаляем, прежние данные остаются как были.
 */
import { anRpc } from "./data";
import { chunks, clientKey, newTrialNames, salesNomenclature, type ParseSummary } from "./import";
import type { AnSource } from "./types";

/** Строк в одной пачке: укладывается в лимит времени запроса. */
const CHUNK = 2000;

export type UploadResult = {
  importId: string;
  rows: number;
  newStudios: number;
  newNomenclature: number;
  replaced: number;
};

export async function uploadParsed(input: {
  summary: ParseSummary;
  source: AnSource;
  fileName: string;
  /** Названия номенклатуры из справочника (без регистра) — для новых пробных членств. */
  knownNames: Set<string>;
  onProgress: (done: number, total: number) => void;
}): Promise<UploadResult> {
  const { summary, source, fileName, knownNames, onProgress } = input;
  const result = summary.result;
  if (!summary.dateFrom || !summary.dateTo || result.rows.length === 0)
    throw new Error("В файле нет строк для загрузки");

  const nomenclature =
    result.kind === "sales"
      ? salesNomenclature(result.rows)
      : result.kind === "visits"
        ? newTrialNames(result.rows, knownNames)
        : [];
  const start = await anRpc<{
    import_id: string;
    studios: Record<string, string>;
    nomenclature: Record<string, string>;
    new_studios: number;
    new_nomenclature: number;
  }>("an_import_start", {
    p_kind: result.kind,
    p_source: source,
    p_file_name: fileName.slice(0, 300),
    p_date_from: summary.dateFrom,
    p_date_to: summary.dateTo,
    p_studios: summary.studios,
    p_nomenclature: nomenclature,
  });

  try {
    const sid = (name: string) => start.studios[name];
    let rows: unknown[][];
    if (result.kind === "revenue") {
      rows = result.rows.map((r) => [sid(r.studio), r.day, r.article, r.income, r.expense]);
    } else if (result.kind === "classes") {
      rows = result.rows.map((r) => [
        sid(r.studio),
        r.day,
        r.direction,
        r.classes,
        r.booked,
        r.attended,
      ]);
    } else if (result.kind === "sales") {
      rows = await Promise.all(
        result.rows.map(async (r) => [
          sid(r.studio),
          r.day,
          r.time ? `${r.day} ${r.time}` : null,
          r.client ? await clientKey(source, r.client) : null,
          start.nomenclature[r.code],
          r.cost,
          r.paid,
        ]),
      );
    } else {
      rows = await Promise.all(
        result.rows.map(async (r) => [
          sid(r.studio),
          r.day,
          r.client ? await clientKey(source, r.client) : null,
          r.membership,
          r.attended,
        ]),
      );
    }

    let done = 0;
    onProgress(0, rows.length);
    for (const part of chunks(rows, CHUNK)) {
      await anRpc("an_import_rows", { p_import_id: start.import_id, p_rows: part });
      done += part.length;
      onProgress(done, rows.length);
    }
    const finish = await anRpc<{ replaced: number }>("an_import_finish", {
      p_import_id: start.import_id,
    });
    return {
      importId: start.import_id,
      rows: rows.length,
      newStudios: start.new_studios,
      newNomenclature: start.new_nomenclature,
      replaced: finish.replaced,
    };
  } catch (e) {
    await anRpc("an_import_delete", { p_import_id: start.import_id }).catch(() => undefined);
    throw e;
  }
}
