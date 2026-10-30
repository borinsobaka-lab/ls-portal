/**
 * «Аналитика» → «Инструменты» в браузере: «Очистка Excel» (фоновый поток) и
 * сохранение .xlsx на компьютер.
 */
import type { CleanerMessage, CleanerRequest } from "./excel-cleaner.worker";

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
