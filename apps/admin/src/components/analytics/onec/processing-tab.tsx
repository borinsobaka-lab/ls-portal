import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSpreadsheet, Loader2, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { kickOnecProcessing } from "@/lib/analytics/admin.functions";
import {
  deleteOnecFile,
  formatBytes,
  formatElapsed,
  formatMsk,
  ONEC_ACTIVE,
  ONEC_ISSUE_TITLES,
  ONEC_KINDS,
  ONEC_REPORT_TITLES,
  ONEC_RUN_STATUS,
  onecErrorText,
  onecKey,
  onecOverviewQuery,
  onecRunQuery,
  uploadOnecFile,
  type OnecFile,
  type OnecOverview,
  type OnecRunCard,
  type OnecSnapshotCard,
} from "@/lib/analytics/onec-page";
import { ONEC_REPORTS, type OnecKind } from "@/lib/analytics/onec/process";
import { formatNumber } from "@/lib/format";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";

import { OnecReviewDialog } from "./review-dialog";

const panel = "rounded-lg border bg-background p-4";

/**
 * «Обработка 1С» — их окно обработчика (desktop_app.py): выгрузки по папкам,
 * «1. Обработать» (вся история, окно новых номенклатур), «2. Загрузить» —
 * снимок становится данными отчётов; ход и журнал. Считает сервер портала
 * отдельным процессом, страницу можно закрыть.
 */
export function OnecProcessingTab() {
  const qc = useQueryClient();
  const kick = useServerFn(kickOnecProcessing);
  const { confirm, confirmDialog } = useConfirm();
  const { data, isPending } = useQuery(onecOverviewQuery);
  const latest = data?.runs[0] ?? null;
  const active = !!latest && ONEC_ACTIVE.includes(latest.status);
  const { data: run } = useQuery(onecRunQuery(latest));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const autoOpened = useRef<number | null>(null);

  // Окно новых номенклатур открывается само, как у них, — один раз на запуск.
  useEffect(() => {
    if (run?.status === "review" && run.review && autoOpened.current !== run.id) {
      autoOpened.current = run.id;
      setReviewOpen(true);
    }
  }, [run]);

  const refresh = () => qc.invalidateQueries({ queryKey: onecKey() });
  const act = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const start = () =>
    act("start", async () => {
      await unwrap(supabase.rpc("an_onec_run_start"));
      await kick().catch(() => {});
    });
  const cancel = (id: number) =>
    act("cancel", () => unwrap(supabase.rpc("an_onec_run_cancel", { p_id: id })));

  const ready = data?.snapshots.find((s) => s.state === "ready") ?? null;
  const activate = async () => {
    if (!ready) return;
    const ok = await confirm({
      title: "Загрузить данные в отчёты?",
      description:
        "Данные отчётов 1С заменятся новым снимком целиком. Текущие данные станут предыдущей копией — их можно вернуть.",
      confirmLabel: "Загрузить",
      destructive: false,
    });
    if (!ok) return;
    await act(
      "activate",
      () => unwrap(supabase.rpc("an_onec_snapshot_activate", { p_id: ready.id })),
      "Данные отчётов заменены. Загрузка завершена.",
    );
  };

  return (
    <div className="space-y-4">
      <section className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Обработка 1С</h2>
            <p className="text-sm text-muted-foreground">
              Своды и отчёты по всей доступной истории
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void start()} disabled={active || isPending || !!busy}>
              {busy === "start" && <Loader2 className="animate-spin" />}
              1. Обработать
            </Button>
            <Button
              onClick={() => void activate()}
              disabled={!ready || active || !!busy}
              variant={ready && !active ? "default" : "outline"}
            >
              {busy === "activate" && <Loader2 className="animate-spin" />}
              2. Загрузить в отчёты
            </Button>
            {latest && (active || latest.status === "review") && (
              <Button
                variant="outline"
                onClick={() => void cancel(latest.id)}
                disabled={!!busy || latest.cancel_requested}
              >
                <X />
                {latest.cancel_requested ? "Отменяется…" : "Отменить"}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {ready
            ? `Готов новый снимок данных: обработан ${formatMsk(ready.ready_at)}. Загрузите его в отчёты.`
            : "Нажмите «Обработать», чтобы подготовить новый полный пакет данных."}
        </p>
        <RunStatus
          run={latest}
          snapshots={data?.snapshots ?? []}
          reviewReady={!!run?.review}
          onReview={() => setReviewOpen(true)}
        />
        <div className="mt-4 text-sm font-medium">Ход обработки и загрузки</div>
        <RunLog lines={run?.log ?? []} loading={!!latest && !run} />
        <p className="mt-2 text-xs text-muted-foreground">
          Результаты сохраняются отдельно. При загрузке заменяется весь снимок данных. Хранятся
          текущие данные отчётов и одна предыдущая копия — старые снимки не накапливаются.
        </p>
      </section>

      <FilesSection overview={data} loading={isPending} locked={active} onChanged={refresh} />

      <SnapshotsSection
        snapshots={data?.snapshots ?? []}
        loading={isPending}
        locked={active || !!busy}
        onRollback={async () => {
          const ok = await confirm({
            title: "Вернуть предыдущие данные?",
            description:
              "Отчёты снова покажут предыдущий снимок. Нынешний станет предыдущей копией — его можно вернуть так же.",
            confirmLabel: "Вернуть",
            destructive: false,
          });
          if (ok) {
            await act(
              "rollback",
              () => unwrap(supabase.rpc("an_onec_snapshot_rollback")),
              "Предыдущие данные возвращены в отчёты.",
            );
          }
        }}
        onDiscard={async (s) => {
          const ok = await confirm({
            title: "Не загружать новый снимок?",
            description: "Обработанные данные будут удалены. Отчёты останутся как есть.",
            confirmLabel: "Удалить",
          });
          if (ok)
            await act("discard", () =>
              unwrap(supabase.rpc("an_onec_snapshot_discard", { p_id: s.id })),
            );
        }}
      />

      <RunsJournal runs={data?.runs ?? []} loading={isPending} />

      {run?.review && (
        <OnecReviewDialog
          run={run}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          onSubmitted={() => {
            void kick().catch(() => {});
            void refresh();
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function RunStatus({
  run,
  snapshots,
  reviewReady,
  onReview,
}: {
  run: OnecRunCard | null;
  snapshots: OnecSnapshotCard[];
  reviewReady: boolean;
  onReview: () => void;
}) {
  const active = !!run && ONEC_ACTIVE.includes(run.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!run) {
    return <div className="mt-3 text-sm">Готово к работе</div>;
  }
  const text =
    run.status === "queued"
      ? "В очереди — обработка начнётся через несколько секунд…"
      : run.status === "running"
        ? (run.progress ?? "Обрабатываем всю доступную историю…")
        : run.status === "review"
          ? "Выберите категории новых номенклатур…"
          : run.status === "answered"
            ? "Категории сохранены в справочник."
            : run.status === "done"
              ? doneText(run, snapshots)
              : run.status === "error"
                ? "Операция не завершена — смотрите журнал."
                : (run.error ?? "Обработка отменена.");
  const from = run.started_at ?? run.requested_at;
  const to = active ? now : new Date(run.finished_at ?? run.heartbeat_at ?? from).getTime();
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{text}</span>
        {run.status === "review" && reviewReady && (
          <Button size="sm" onClick={onReview}>
            Выбрать категории
          </Button>
        )}
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatElapsed(to - new Date(from).getTime())}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-brand transition-all",
            active ? "w-full animate-pulse opacity-70" : run.status === "done" ? "w-full" : "w-0",
          )}
        />
      </div>
      {run.status === "error" && run.error && (
        <InfoNote variant="warning" className="whitespace-pre-wrap">
          {run.error}
        </InfoNote>
      )}
    </div>
  );
}

/** Итог обработки: снимок ждёт загрузки, уже в отчётах или не загружен. */
function doneText(run: OnecRunCard, snapshots: OnecSnapshotCard[]) {
  const own = snapshots.find((s) => s.id === run.snapshot_id);
  if (own?.state === "ready") return "Обработка завершена. Можно загрузить данные в отчёты.";
  if (own?.state === "current") return "Данные отчётов заменены. Загрузка завершена.";
  return "Обработка завершена.";
}

function RunLog({ lines, loading }: { lines: string[]; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div
      ref={ref}
      className="mt-2 h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : lines.length === 0 ? (
        <span className="text-muted-foreground">Журнал появится при обработке.</span>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {l}
          </div>
        ))
      )}
    </div>
  );
}

// --- Выгрузки -------------------------------------------------------------------

function FilesSection({
  overview,
  loading,
  locked,
  onChanged,
}: {
  overview: OnecOverview | undefined;
  loading: boolean;
  locked: boolean;
  onChanged: () => Promise<unknown>;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold">Выгрузки 1С</h2>
        <p className="text-sm text-muted-foreground">
          Как привычные папки 1С: файл с тем же именем заменяет прежний. Можно класть и исходные
          выгрузки, и «_очищено» — обработка сама убирает пустые строки и столбцы, как ExcelCleaner.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {ONEC_KINDS.map((k) => (
          <FolderCard
            key={k.kind}
            kind={k.kind}
            title={k.title}
            hint={k.hint}
            files={(overview?.files ?? []).filter((f) => f.kind === k.kind)}
            loading={loading}
            locked={locked}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function FolderCard({
  kind,
  title,
  hint,
  files,
  loading,
  locked,
  onChanged,
}: {
  kind: OnecKind;
  title: string;
  hint: string;
  files: OnecFile[];
  loading: boolean;
  locked: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { confirm, confirmDialog } = useConfirm();
  const [uploading, setUploading] = useState<string | null>(null);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    let done = 0;
    try {
      for (const f of chosen) {
        setUploading(f.name);
        await uploadOnecFile(kind, f);
        done++;
      }
      toast.success(done === 1 ? "Выгрузка загружена" : `Загружено выгрузок: ${done}`);
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
      await onChanged();
    }
  };
  const remove = async (f: OnecFile) => {
    const ok = await confirm({
      title: `Удалить «${f.name}»?`,
      description: "Выгрузка уйдёт из папки — следующая обработка её не прочитает.",
    });
    if (!ok) return;
    try {
      await deleteOnecFile(f.id);
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      await onChanged();
    }
  };

  return (
    <div className={panel}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={locked || !!uploading}
          onClick={() => input.current?.click()}
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
          Добавить
        </Button>
        <input
          ref={input}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      {uploading && (
        <div className="mt-2 text-xs text-muted-foreground">Загружается «{uploading}»…</div>
      )}
      <ul className="mt-3 divide-y">
        {loading ? (
          <li className="py-2">
            <Skeleton className="h-4 w-2/3" />
          </li>
        ) : files.length === 0 ? (
          <li className="py-2 text-sm text-muted-foreground">Выгрузок нет.</li>
        ) : (
          [...files]
            .sort((a, b) => a.name.localeCompare(b.name, "ru"))
            .map((f) => (
              <li key={f.id} className="flex items-center gap-2 py-2">
                <FileSpreadsheet className="size-4 shrink-0 text-emerald-700" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {f.name}
                    {f.cleaned && (
                      <StatusChip tone="neutral" size="sm" className="ml-2">
                        очищено
                      </StatusChip>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(f.size)} · {formatMsk(f.uploaded_at)}
                    {f.uploaded_by ? ` · ${f.uploaded_by}` : ""}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Удалить ${f.name}`}
                  disabled={locked}
                  onClick={() => void remove(f)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))
        )}
      </ul>
      {confirmDialog}
    </div>
  );
}

// --- Данные отчётов ----------------------------------------------------------------

const SNAPSHOT_TITLE = {
  current: "Сейчас в отчётах",
  previous: "Предыдущая копия",
  ready: "Новый снимок (ещё не загружен)",
} as const;

function SnapshotsSection({
  snapshots,
  loading,
  locked,
  onRollback,
  onDiscard,
}: {
  snapshots: OnecSnapshotCard[];
  loading: boolean;
  locked: boolean;
  onRollback: () => void;
  onDiscard: (s: OnecSnapshotCard) => void;
}) {
  const order = ["ready", "current", "previous"] as const;
  const list = order
    .map((st) => snapshots.find((s) => s.state === st))
    .filter((s): s is OnecSnapshotCard => !!s);
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Данные отчётов</h2>
      {loading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : list.length === 0 ? (
        <InfoNote variant="empty">
          Данных ещё нет: загрузите выгрузки, нажмите «1. Обработать», затем «2. Загрузить в
          отчёты».
        </InfoNote>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.map((s) => (
            <SnapshotCard
              key={s.id}
              snapshot={s}
              action={
                s.state === "previous" ? (
                  <Button variant="outline" size="sm" disabled={locked} onClick={onRollback}>
                    <RotateCcw />
                    Вернуть в отчёты
                  </Button>
                ) : s.state === "ready" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => onDiscard(s)}
                  >
                    Не загружать
                  </Button>
                ) : null
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SnapshotCard({
  snapshot: s,
  action,
}: {
  snapshot: OnecSnapshotCard;
  action: React.ReactNode;
}) {
  const z = s.zeroControls ?? {};
  const issues = Object.entries(s.issues ?? {});
  return (
    <div className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{SNAPSHOT_TITLE[s.state]}</div>
          <div className="text-xs text-muted-foreground">
            Обработан {formatMsk(s.generated_at ?? s.ready_at)}
            {s.activated_at &&
              ` · в отчётах с ${formatMsk(s.activated_at)}${s.activated_by ? ` (${s.activated_by})` : ""}`}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-3 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Отчёт</TableHead>
              <TableHead>Записи с — по</TableHead>
              <TableHead className="text-right">Строк</TableHead>
              <TableHead className="text-right">Прочитано</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ONEC_REPORTS.map((r) => {
              const c = s.coverage?.[r];
              return (
                <TableRow key={r}>
                  <TableCell className="text-sm">{ONEC_REPORT_TITLES[r]}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {c?.min ? `${ruDate(c.min)} — ${ruDate(c.max)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {c ? formatNumber(c.rows) : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {c ? formatNumber(c.source_rows) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
        <div>
          Нулевые продажи: без стоимости — {formatNumber(z.blankCostRows ?? 0)}, со стоимостью 0 —{" "}
          {formatNumber(z.explicitZeroRows ?? 0)}, пробные исключены —{" "}
          {formatNumber(z.excludedTrialRows ?? 0)}.
        </div>
        <div>Точка 0 — городов: {formatNumber(s.breakEvenCities)}.</div>
        {issues.map(([k, v]) => (
          <div key={k}>
            {ONEC_ISSUE_TITLES[k] ?? k}: {formatNumber(v)}
          </div>
        ))}
        <div>Диапазон наблюдаемых записей; полнота исходных выгрузок не подтверждена.</div>
      </div>
    </div>
  );
}

const ruDate = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "—");

// --- Журнал запусков ----------------------------------------------------------------

function RunsJournal({ runs, loading }: { runs: OnecRunCard[]; loading: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Журнал запусков</h2>
      <div className="overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Запуск</TableHead>
              <TableHead>Кто</TableHead>
              <TableHead>Итог</TableHead>
              <TableHead>Длительность</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-4 w-1/2" />
                </TableCell>
              </TableRow>
            ) : runs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  Запусков ещё не было.
                </TableCell>
              </TableRow>
            ) : (
              runs.map((r) => {
                const st = ONEC_RUN_STATUS[r.status];
                const ms =
                  r.started_at && r.finished_at
                    ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
                    : null;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatMsk(r.requested_at)}
                    </TableCell>
                    <TableCell className="text-sm">{r.requested_by ?? "—"}</TableCell>
                    <TableCell className="text-sm">
                      <StatusChip tone={st.tone}>{st.label}</StatusChip>
                      {r.error && r.status !== "cancelled" && (
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {r.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {ms !== null ? formatElapsed(ms) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setOpenId(r.id)}>
                        Журнал
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <RunLogDialog runId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}

function RunLogDialog({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: onecKey("run-log", runId),
    queryFn: () => unwrap<{ log: string[] }>(supabase.rpc("an_onec_run_get", { p_id: runId })),
    enabled: runId !== null,
    meta: { errorMessage: "Не удалось загрузить журнал обработки" },
  });
  return (
    <Dialog open={runId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Журнал обработки</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <RunLog lines={data?.log ?? []} loading={!data} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
