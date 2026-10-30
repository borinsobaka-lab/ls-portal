/**
 * «Аналитика» → «Инструменты» в браузере: «Очистка Excel» (фоновый поток),
 * данные «Топ-10 городов» и сохранение .xlsx на компьютер.
 */
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";

import { ANALYTICS_KEY } from "./data";
import type { CleanerMessage, CleanerRequest } from "./excel-cleaner.worker";
import type { Top10Data } from "./top10";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Скачать файл .xlsx под именем `name`. */
export function saveXlsx(data: Blob | Uint8Array, name: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: XLSX_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Их select_output: имя сохранения всегда с «.xlsx». */
export function xlsxName(name: string): string {
  const trimmed = name.trim();
  return /\.xlsx$/i.test(trimmed) ? trimmed : `${trimmed.replace(/\.[^./\\]*$/, "")}.xlsx`;
}

/** Очистить книгу в фоновом потоке: отчёт их format_report и готовый файл. */
export function runExcelCleaner(
  file: File,
  onProgress: (percent: number, message: string) => void,
): Promise<{ report: string; output: Blob }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./excel-cleaner.worker.ts", import.meta.url), {
      type: "module",
    });
    const stop = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<CleanerMessage>) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.percent, m.message);
      else if (m.type === "done") {
        stop();
        resolve({ report: m.report, output: new Blob([m.output], { type: XLSX_TYPE }) });
      } else {
        stop();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      stop();
      reject(new Error(e.message || "Не удалось запустить обработку в браузере"));
    };
    void file.arrayBuffer().then(
      (bytes) => {
        const req: CleanerRequest = { name: file.name, bytes };
        worker.postMessage(req, [bytes]);
      },
      (e: unknown) => {
        stop();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// --- «Топ-10 городов» ---------------------------------------------------------------

/** Дата сводов и охват данных отчётов; null — данных отчётов ещё нет. */
export type Top10Info = Omit<Top10Data, "rows">;

export const anTop10InfoQuery = {
  queryKey: [ANALYTICS_KEY, "top10", "info"],
  queryFn: () => unwrap<Top10Info | null>(supabase.rpc("an_onec_top10_range")),
  meta: { errorMessage: "Не удалось загрузить данные отчётов" },
};

/** Строки месяц × город за выбранные месяцы (RPC an_onec_top10). */
export const anTop10Query = (months: string[]) => ({
  queryKey: [ANALYTICS_KEY, "top10", "rows", ...months],
  queryFn: () => unwrap<Top10Data>(supabase.rpc("an_onec_top10", { p_months: months })),
  enabled: months.length > 0,
  placeholderData: (prev: Top10Data | undefined) => prev,
  meta: { errorMessage: "Не удалось загрузить рейтинги" },
});
