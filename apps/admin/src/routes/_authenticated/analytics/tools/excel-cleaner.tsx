import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, type DragEvent } from "react";
import { Download, FileSpreadsheet, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsExcelCleanerPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { CLEANER_VERSION, defaultOutputName } from "@/lib/analytics/excel-cleaner";
import { AN_EXCEL_CLEANER_TEXT as T, AN_TITLES } from "@/lib/analytics/labels";
import { runExcelCleaner, saveXlsx, xlsxName } from "@/lib/analytics/tools";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/analytics/tools/excel-cleaner")({
  head: () => ({ meta: [{ title: "Очистка Excel — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsExcelCleanerPageSkeleton,
  component: AnalyticsExcelCleanerPage,
});

const isXlsx = (name: string) => /\.xlsx$/i.test(name);

/**
 * «Аналитика» → «Инструменты» → «Очистка Excel» (администратору аналитики) —
 * их ExcelCleaner 1.1-fast: выгрузка 1С → плоский .xlsx без объединений,
 * группировок и пустых строк и столбцов, отчёт по листам. Файл
 * обрабатывается в браузере (lib/analytics/excel-cleaner.ts).
 */
function AnalyticsExcelCleanerPage() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [outputName, setOutputName] = useState("");
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState(T.statusIdle);
  const [report, setReport] = useState("");
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Их set_input_path. */
  const pick = (f: File) => {
    if (!isXlsx(f.name)) {
      toast.warning(T.badFormatTitle, { description: T.badFormatText });
      return;
    }
    setFile(f);
    setOutputName(defaultOutputName(f.name));
    setPercent(0);
    setResult(null);
    setReport("");
    setStatus(T.statusPicked);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    const f = e.dataTransfer.files[0];
    if (f) pick(f);
  };

  /** Их start_cleaning → CleanWorker → show_success / show_error. */
  const start = async () => {
    if (!file) {
      toast.warning(T.noFileTitle, { description: T.noFileText });
      return;
    }
    const name = outputName.trim() ? xlsxName(outputName) : defaultOutputName(file.name);
    setOutputName(name);
    setResult(null);
    setRunning(true);
    setPercent(0);
    setReport("");
    setStatus(T.statusStarting);
    try {
      const { report: text, output } = await runExcelCleaner(file, (p, message) => {
        setPercent(p);
        if (message) setStatus(message);
      });
      setPercent(100);
      setStatus(T.statusSaved(name));
      setReport(text);
      setResult({ blob: output, name });
      saveXlsx(output, name);
    } catch (e) {
      const message = (e as Error).message;
      setStatus(T.statusFailed);
      setReport(message);
      toast.error("Ошибка", { description: message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <AdminShell title={AN_TITLES.excelCleaner}>
      <div className="max-w-3xl space-y-4">
        <InfoNote>{T.lead}</InfoNote>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!running) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed bg-background px-4 py-6 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border",
          )}
        >
          <FileSpreadsheet className="size-6 text-emerald-700" />
          <div className="font-medium">{T.dropTitle}</div>
          <div className="text-sm text-muted-foreground">{T.dropHint}</div>
        </div>

        <div className="space-y-4 rounded-lg border bg-background p-4">
          <FormField label="Исходный файл" htmlFor={null}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 truncate text-sm" title={file?.name}>
                {file ? T.picked(file.name) : T.notPicked}
              </div>
              <Button
                variant="outline"
                disabled={running}
                onClick={() => input.current?.click()}
                className="sm:w-auto"
              >
                <FileUp />
                Выбрать
              </Button>
              <input
                ref={input}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) pick(f);
                }}
              />
            </div>
          </FormField>
          <FormField label="Сохранить как" htmlFor="cleaner-output" tip={T.outputTip}>
            <Input
              id="cleaner-output"
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
              placeholder="очищено.xlsx"
              disabled={running || !file}
            />
          </FormField>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => void start()} disabled={running}>
              {running && <Loader2 className="animate-spin" />}
              Очистить файл
            </Button>
            <Button
              variant="outline"
              disabled={!result || running}
              onClick={() => result && saveXlsx(result.blob, result.name)}
            >
              <Download />
              Скачать ещё раз
            </Button>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="Очистка файла"
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
                {percent}%
              </span>
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {status}
            </p>
          </div>
          <div
            className={cn(
              "min-h-32 rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap",
              !report && "text-muted-foreground",
            )}
          >
            {report || T.reportPlaceholder}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Версия программы: {CLEANER_VERSION}</p>
      </div>
    </AdminShell>
  );
}
