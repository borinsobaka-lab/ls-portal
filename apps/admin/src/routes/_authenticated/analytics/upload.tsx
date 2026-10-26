import { useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsUploadPageSkeleton } from "@/components/page-skeletons";
import { RowContextMenu } from "@/components/row-context-menu";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  anImportsQuery,
  anNomenclatureQuery,
  anRpc,
  invalidateAnalytics,
} from "@/lib/analytics/data";
import {
  KIND_FIELDS,
  KIND_LABEL,
  autoMap,
  findHeaderRow,
  missingRequired,
  parseCsv,
  parseTable,
  type Cell,
  type FieldKey,
  type Mapping,
} from "@/lib/analytics/import";
import {
  ANALYTICS_TITLES,
  IMPORTS_COLUMNS,
  KIND_TITLE,
  SOURCE_LABEL,
} from "@/lib/analytics/labels";
import { uploadParsed, type UploadResult } from "@/lib/analytics/upload";
import type { AnKind, AnSource } from "@/lib/analytics/types";
import { formatDate, formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/upload")({
  head: () => ({ meta: [{ title: "Загрузка данных — Аналитика сети — Lady Stretch" }] }),
  pendingComponent: AnalyticsUploadPageSkeleton,
  component: UploadPage,
});

const nf = new Intl.NumberFormat("ru-RU");

const TIPS = {
  kind: "Какая это выгрузка. Выручка — отчёт о движении денег; продажи — строки продаж с номенклатурой и кодом клиента; занятия — занятия по направлениям; посещения — записи с членством (для воронки пробных).",
  source:
    "Учётная система студий из файла. Одна и та же студия в разных системах — разные строки справочника.",
  sheet: "Лист книги Excel с данными.",
  mapping:
    "Колонки находятся по заголовкам. Если какая-то не нашлась или нашлась не та — выберите её вручную.",
};

/** Подсказка, где взять выгрузку (по правилам портала Lady Stretch). */
const KIND_HINT: Record<AnKind, string> = {
  revenue:
    "1С: отчёт о движении денежных средств по структурным единицам и дням (можно без детализации по статьям). Иерархический отчёт подходит: дата и студия строкой выше операций протягиваются вниз, подытоги групп не считаются.",
  sales:
    "1С: «Продажи» с номенклатурой (код и название), кодом клиента, стоимостью и оплатой. Загружаются все строки — что считать абонементом, решает справочник «Номенклатура».",
  classes:
    "1С: «Занятия и направления» — занятий проведено, клиентов записано, клиентов посетило по студиям, дням и направлениям. Занятия без записанных или пришедших не считаются проведёнными.",
  visits:
    "1С: «Занятия с членством и клиентом» — дата, студия, членство (пакет услуг), код клиента, статус («Прибыл» / «Не прибыл»). Пробными считаются членства, размеченные в «Номенклатуре» как «Пробное занятие».",
};

type Sheet = { name: string; rows: Cell[][] };

function UploadPage() {
  const qc = useQueryClient();
  const imports = useQuery(anImportsQuery);
  const nomenclature = useQuery(anNomenclatureQuery);
  const { confirm, confirmDialog } = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<AnKind>("revenue");
  const [source, setSource] = useState<AnSource>("1c");
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => sheets[sheetIdx]?.rows ?? [], [sheets, sheetIdx]);
  const headers = rows[headerRow] ?? [];
  const setup = (k: AnKind, list: Sheet[], idx: number) => {
    const data = list[idx]?.rows ?? [];
    const h = findHeaderRow(data, k);
    setHeaderRow(h);
    setMapping(autoMap(data[h] ?? [], k));
  };

  const pick = async (f: File) => {
    setFile(f);
    setResult(null);
    setError(null);
    setReading(true);
    try {
      let list: Sheet[];
      if (/\.(csv|txt)$/i.test(f.name)) {
        list = [{ name: f.name, rows: parseCsv(await f.text()) }];
      } else {
        // Читалка Excel — только на этой странице.
        const { default: readXlsxFile } = await import("read-excel-file/browser");
        const book = await readXlsxFile(f);
        list = book.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }));
      }
      const idx = Math.max(
        0,
        list.findIndex((s) => s.rows.length > 1),
      );
      setSheets(list);
      setSheetIdx(idx);
      setup(kind, list, idx);
    } catch (e) {
      setSheets([]);
      setError(
        `Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}. Нужен .xlsx или .csv (старый .xls пересохраните в .xlsx).`,
      );
    } finally {
      setReading(false);
    }
  };

  const missing = missingRequired(kind, mapping);
  const summary = useMemo(
    () =>
      rows.length > 0 && missing.length === 0 ? parseTable(kind, rows, headerRow, mapping) : null,
    [kind, rows, headerRow, mapping, missing.length],
  );
  const running = progress !== null && !result && !error;

  const upload = async () => {
    if (!summary || !file) return;
    const ok = await confirm({
      title: "Загрузить данные?",
      description: `${KIND_TITLE[kind]}: ${nf.format(summary.result.rows.length)} строк за ${formatDate(summary.dateFrom)} – ${formatDate(summary.dateTo)} по ${summary.studios.length} студиям. Прежние данные этого вида у этих студий за этот период заменятся.`,
      confirmLabel: "Загрузить",
      destructive: false,
    });
    if (!ok) return;
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: summary.result.rows.length });
    try {
      const known = new Set((nomenclature.data ?? []).map((n) => n.name.trim().toLowerCase()));
      const res = await uploadParsed({
        summary,
        source,
        fileName: file.name,
        knownNames: known,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(res);
      await invalidateAnalytics(qc);
      toast.success("Данные загружены");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string, label: string) => {
    const ok = await confirm({
      title: "Удалить загрузку?",
      description: `${label}. Её данные уйдут из отчётов; данные других загрузок за тот же период не вернутся — загрузите выгрузку заново.`,
    });
    if (!ok) return;
    try {
      await anRpc("an_import_delete", { p_import_id: id });
      await invalidateAnalytics(qc);
      toast.success("Загрузка удалена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить");
    }
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <AdminShell title={ANALYTICS_TITLES.upload}>
      <div className="space-y-6">
        <section className="max-w-3xl space-y-4 rounded-lg border bg-background p-6">
          <div>
            <h2 className="text-lg font-semibold">Новая загрузка</h2>
            <p className="text-sm text-muted-foreground">
              Выгрузка учётной системы клубов сети (1С, FitBase, АДИС, Мобифитнес…) в Excel (.xlsx)
              или CSV. Портал сам приводит её к единому виду и считает отчёты. Коды клиентов
              хранятся только в зашифрованном виде (хэш), имён и телефонов нет.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Что загружаем" tip={TIPS.kind} required>
              <Select
                value={kind}
                disabled={running}
                onValueChange={(v) => {
                  const k = v as AnKind;
                  setKind(k);
                  setResult(null);
                  setup(k, sheets, sheetIdx);
                }}
              >
                <SelectTrigger aria-label="Что загружаем">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(KIND_LABEL) as AnKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Учётная система" tip={TIPS.source} required>
              <Select
                value={source}
                disabled={running}
                onValueChange={(v) => setSource(v as AnSource)}
              >
                <SelectTrigger aria-label="Учётная система">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SOURCE_LABEL) as AnSource[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <InfoNote>{KIND_HINT[kind]}</InfoNote>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void pick(f);
              }}
            />
            <Button
              variant="outline"
              disabled={running || reading}
              onClick={() => inputRef.current?.click()}
            >
              {reading ? <Loader2 className="animate-spin" /> : <FileUp />}
              {file ? "Другой файл" : "Выбрать файл"}
            </Button>
            {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
          </div>
          {error && <InfoNote variant="warning">{error}</InfoNote>}

          {rows.length > 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {sheets.length > 1 && (
                  <FormField label="Лист" tip={TIPS.sheet}>
                    <Select
                      value={String(sheetIdx)}
                      disabled={running}
                      onValueChange={(v) => {
                        setSheetIdx(Number(v));
                        setup(kind, sheets, Number(v));
                      }}
                    >
                      <SelectTrigger aria-label="Лист">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sheets.map((s, i) => (
                          <SelectItem key={s.name} value={String(i)}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                )}
                <FormField
                  label="Строка заголовков"
                  tip="Строка с названиями колонок (над ней — шапка отчёта)."
                >
                  <Select
                    value={String(headerRow)}
                    disabled={running}
                    onValueChange={(v) => {
                      const h = Number(v);
                      setHeaderRow(h);
                      setMapping(autoMap(rows[h] ?? [], kind));
                    }}
                  >
                    <SelectTrigger aria-label="Строка заголовков">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rows.slice(0, 30).map((r, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {i + 1}:{" "}
                          {r
                            .filter((c) => c !== null && c !== "")
                            .slice(0, 4)
                            .map(String)
                            .join(" · ")
                            .slice(0, 60) || "пустая"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Колонки</h3>
                <p className="text-xs text-muted-foreground">{TIPS.mapping}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {KIND_FIELDS[kind].map((f) => (
                    <FormField key={f.key} label={f.label} required={f.required}>
                      <Select
                        value={mapping[f.key] === undefined ? "none" : String(mapping[f.key])}
                        disabled={running}
                        onValueChange={(v) =>
                          setMapping((m) => {
                            const next = { ...m };
                            if (v === "none") delete next[f.key as FieldKey];
                            else next[f.key as FieldKey] = Number(v);
                            return next;
                          })
                        }
                      >
                        <SelectTrigger aria-label={f.label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">— нет —</SelectItem>
                          {headers.map((h, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {String(h ?? "").trim() || `Колонка ${i + 1}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  ))}
                </div>
              </div>

              {missing.length > 0 ? (
                <InfoNote variant="warning">
                  Выберите колонки: {missing.map((f) => f.label).join(", ")}.
                </InfoNote>
              ) : summary && summary.result.rows.length === 0 ? (
                <InfoNote variant="warning">
                  В файле не нашлось строк с датой и студией. Проверьте колонки и строку заголовков.
                </InfoNote>
              ) : (
                summary && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">Период</dt>
                    <dd>
                      {formatDate(summary.dateFrom)} – {formatDate(summary.dateTo)}
                    </dd>
                    <dt className="text-muted-foreground">Строк</dt>
                    <dd>
                      {nf.format(summary.total)} в файле → {nf.format(summary.result.rows.length)} к
                      загрузке
                      {summary.skipped > 0 &&
                        ` · пропущено ${nf.format(summary.skipped)} (итоги, группировки, без даты или студии${kind === "classes" ? ", не проведённые занятия" : ""})`}
                    </dd>
                    <dt className="text-muted-foreground">Студий</dt>
                    <dd>
                      {summary.studios.length}: {summary.studios.slice(0, 8).join(", ")}
                      {summary.studios.length > 8 && ` и ещё ${summary.studios.length - 8}`}
                    </dd>
                  </dl>
                )
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!summary || summary.result.rows.length === 0 || running}
                  onClick={() => void upload()}
                >
                  {running && <Loader2 className="animate-spin" />} Загрузить
                </Button>
              </div>
            </>
          )}

          {progress && (
            <div className="space-y-1.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label="Загрузка данных"
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {result ? "Готово" : error ? "Остановлено" : "Загружаем"}:{" "}
                {nf.format(progress.done)} из {nf.format(progress.total)} строк
              </p>
            </div>
          )}
          {result && (
            <InfoNote>
              Загружено {nf.format(result.rows)} строк, заменено прежних —{" "}
              {nf.format(result.replaced)}.
              {result.newStudios > 0 && (
                <>
                  {" "}
                  Новых студий — {result.newStudios}: укажите им город и партнёра в{" "}
                  <Link to="/analytics/studios" className="font-medium underline">
                    «Студиях сети»
                  </Link>
                  .
                </>
              )}
              {result.newNomenclature > 0 && (
                <>
                  {" "}
                  Новых позиций номенклатуры — {result.newNomenclature}: разметьте их в{" "}
                  <Link to="/analytics/nomenclature" className="font-medium underline">
                    «Номенклатуре»
                  </Link>
                  , до этого они не входят в абонементы и пробные.
                </>
              )}
            </InfoNote>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Журнал загрузок</h2>
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  {IMPORTS_COLUMNS.map((c, i) => (
                    <TableHead
                      key={c}
                      className={i === 3 || i === 4 ? "text-right [&>span]:justify-end" : undefined}
                    >
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.isLoading ? (
                  <TableSkeletonRows columns={IMPORTS_COLUMNS.length} rows={4} />
                ) : (imports.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={IMPORTS_COLUMNS.length}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Загрузок ещё не было
                    </TableCell>
                  </TableRow>
                ) : (
                  (imports.data ?? []).map((imp) => {
                    const label = `${KIND_TITLE[imp.kind]} за ${formatDate(imp.date_from)} – ${formatDate(imp.date_to)}`;
                    return (
                      <RowContextMenu
                        key={imp.id}
                        actions={[
                          {
                            label: "Удалить загрузку",
                            icon: Trash2,
                            destructive: true,
                            onSelect: () => void remove(imp.id, label),
                          },
                        ]}
                      >
                        <TableRow>
                          <TableCell>
                            {formatDateTime(imp.created_at)}
                            {imp.created_by_name && (
                              <span className="block text-xs text-muted-foreground">
                                {imp.created_by_name}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {KIND_TITLE[imp.kind]} · {SOURCE_LABEL[imp.source]}
                            {imp.status === "loading" && (
                              <span className="block text-xs text-amber-700">не завершена</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {formatDate(imp.date_from)} – {formatDate(imp.date_to)}
                          </TableCell>
                          <TableCell className="text-right">
                            {nf.format(imp.studio_ids.length)}
                          </TableCell>
                          <TableCell className="text-right">{nf.format(imp.rows_count)}</TableCell>
                          <TableCell className="max-w-64 truncate text-muted-foreground">
                            {imp.file_name ?? "—"}
                          </TableCell>
                        </TableRow>
                      </RowContextMenu>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
      {confirmDialog}
    </AdminShell>
  );
}
