import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Import1cPageSkeleton } from "@/components/page-skeletons";
import { supabase } from "@/integrations/supabase/client";
import {
  addChunkResult,
  emptyChunkResult,
  importChunks,
  parseImportFile,
  summarizeImport,
  type ChunkResult,
  type ImportFile,
} from "@/lib/import-1c";

export const Route = createFileRoute("/_authenticated/import-1c")({
  head: () => ({ meta: [{ title: "Импорт из 1С — Base40 Admin" }] }),
  pendingComponent: Import1cPageSkeleton,
  component: Import1cPage,
});

const QUERY_KEY = ["import_1c_status"];
const nf = new Intl.NumberFormat("ru-RU");

type ImportStatus = { clients: number; sales: number; signedIn: number };

/** Число строк ответа с count: "exact" (ошибка — исключение). */
function countOf({ count, error }: { count: number | null; error: { message: string } | null }) {
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function fetchStatus(): Promise<ImportStatus> {
  const head = { count: "exact", head: true } as const;
  const [clients, signedIn, sales] = await Promise.all([
    supabase.from("clients").select("id", head).not("onec_ref", "is", null).then(countOf),
    supabase
      .from("clients")
      .select("id", head)
      .not("onec_ref", "is", null)
      .not("user_id", "is", null)
      .then(countOf),
    supabase.from("sales").select("id", head).not("onec_ref", "is", null).then(countOf),
  ]);
  return { clients, sales, signedIn };
}

type Run = {
  done: number;
  total: number;
  result: ChunkResult;
  error: string | null;
  /** С какой пачки продолжать после ошибки. */
  next: number;
  running: boolean;
};

function Import1cPage() {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: ImportFile } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [removing, setRemoving] = useState(false);

  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchStatus,
    meta: { errorMessage: "Не удалось загрузить состояние переноса" },
  });

  const pick = async (f: File) => {
    try {
      setFile({ name: f.name, data: parseImportFile(await f.text()) });
      setRun(null);
    } catch (e) {
      setFile(null);
      toast.error((e as Error).message);
    }
  };

  const start = async (from = 0) => {
    if (!file) return;
    const chunks = importChunks(file.data);
    const total = file.data.clients.length;
    if (from === 0) {
      const ok = await confirm({
        title: `Перенести ${nf.format(total)} клиентов из 1С?`,
        description:
          "Карточки, продажи и абонементы появятся в «Клиентах» и «Абонементах» пакетных клубов. Уже перенесённое пропускается — повторный запуск ничего не задвоит.",
        confirmLabel: "Перенести",
        destructive: false,
      });
      if (!ok) return;
    }
    let result = from === 0 || !run ? emptyChunkResult() : run.result;
    let done = chunks.slice(0, from).reduce((n, c) => n + c.clients.length, 0);
    setRun({ done, total, result, error: null, next: from, running: true });
    for (let i = from; i < chunks.length; i++) {
      const { data, error } = await supabase.rpc("import_1c_chunk", { p_chunk: chunks[i] });
      if (error) {
        setRun({ done, total, result, error: error.message, next: i, running: false });
        queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        return;
      }
      result = addChunkResult(result, data);
      done += chunks[i].clients.length;
      setRun({ done, total, result, error: null, next: i + 1, running: true });
    }
    setRun({ done, total, result, error: null, next: chunks.length, running: false });
    toast.success("Перенос из 1С завершён");
    // Новые карточки и продажи — во всех списках админки.
    queryClient.invalidateQueries();
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Удалить всё перенесённое из 1С?",
      description:
        "Удалятся перенесённые карточки клиентов, их продажи, платежи и абонементы. Карточки, заведённые в админке, не тронутся. После этого файл можно залить заново.",
      confirmLabel: "Удалить перенесённое",
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const { data, error } = await supabase.rpc("import_1c_rollback", { p_confirm: "УДАЛИТЬ" });
      if (error) throw error;
      const r = (data ?? {}) as { clients?: number; sales?: number };
      toast.success(
        `Удалено: карточек — ${nf.format(r.clients ?? 0)}, продаж — ${nf.format(r.sales ?? 0)}`,
      );
      setRun(null);
      queryClient.invalidateQueries();
    } catch (e) {
      toast.error("Не удалось удалить: " + (e as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  const summary = file ? summarizeImport(file.data) : null;
  const running = run?.running ?? false;

  return (
    <AdminShell title="Импорт из 1С">
      <div className="max-w-2xl space-y-8">
        <section className="space-y-4 rounded-lg border bg-background p-6">
          <div>
            <h2 className="text-lg font-semibold">Файл заливки</h2>
            <p className="text-sm text-muted-foreground">
              Клиенты и абонементы пакетных клубов из выгрузки 1С (отчёты «Клиенты» и «Пакеты
              услуг»). Файл готовится из выгрузки отдельно — в нём уже объединены дубли, разобраны
              телефоны и сопоставлены абонементы с номенклатурой.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) pick(f);
              }}
            />
            <Button variant="outline" disabled={running} onClick={() => inputRef.current?.click()}>
              <FileUp /> {file ? "Другой файл" : "Выбрать файл"}
            </Button>
            {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
          </div>

          {summary && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                {summary.source && (
                  <>
                    <dt className="text-muted-foreground">Источник</dt>
                    <dd>{summary.source}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Клубы</dt>
                <dd>{summary.studios.join(", ")}</dd>
                <dt className="text-muted-foreground">Клиентов</dt>
                <dd>
                  {nf.format(summary.clients)} · с почтой — {nf.format(summary.withEmail)}
                </dd>
                <dt className="text-muted-foreground">Абонементов</dt>
                <dd>
                  {nf.format(summary.sales)} · с долгом — {nf.format(summary.withDebt)}
                  <ul className="mt-1 text-muted-foreground">
                    {summary.byCatalog.map((c) => (
                      <li key={c.catalog}>
                        {c.catalog} — {nf.format(c.count)}
                      </li>
                    ))}
                  </ul>
                </dd>
                <dt className="text-muted-foreground">История</dt>
                <dd>{nf.format(summary.history)} закончившихся абонементов, без продаж</dd>
              </dl>
              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={running} onClick={() => start(0)}>
                  {running && <Loader2 className="animate-spin" />} Перенести в базу
                </Button>
                {run?.error && !running && (
                  <Button variant="outline" onClick={() => start(run.next)}>
                    Продолжить
                  </Button>
                )}
              </div>
            </>
          )}

          {run && <RunProgress run={run} />}
        </section>

        <section className="space-y-4 rounded-lg border bg-background p-6">
          <div>
            <h2 className="text-lg font-semibold">Уже перенесено</h2>
            <p className="text-sm text-muted-foreground">
              Что лежит в базе из 1С сейчас. Пока никто из перенесённых клиентов не вошёл в
              приложение и не записан на занятие, перенос можно удалить целиком и залить заново.
            </p>
          </div>
          {status.isLoading || !status.data ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ) : status.data.clients === 0 ? (
            <InfoNote variant="empty">Из 1С ещё ничего не перенесено.</InfoNote>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Карточек клиентов</dt>
                <dd>{nf.format(status.data.clients)}</dd>
                <dt className="text-muted-foreground">Продаж абонементов</dt>
                <dd>{nf.format(status.data.sales)}</dd>
                <dt className="text-muted-foreground">Вошли в приложение</dt>
                <dd>{nf.format(status.data.signedIn)}</dd>
              </dl>
              {status.data.signedIn > 0 ? (
                <InfoNote>
                  Клиенты уже входят в приложение — удалить перенос целиком нельзя, правьте карточки
                  и абонементы по одной.
                </InfoNote>
              ) : (
                <Button variant="destructive" disabled={removing || running} onClick={remove}>
                  {removing && <Loader2 className="animate-spin" />} Удалить перенесённое
                </Button>
              )}
            </>
          )}
        </section>
      </div>
      {confirmDialog}
    </AdminShell>
  );
}

function RunProgress({ run }: { run: Run }) {
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  const r = run.result;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Перенос клиентов"
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">
          {run.running ? "Переносим" : run.error ? "Остановлено" : "Готово"}: {nf.format(run.done)}{" "}
          из {nf.format(run.total)} клиентов
        </p>
      </div>
      {run.error && (
        <InfoNote variant="warning">
          База не приняла пачку: {run.error}. Уже перенесённое сохранено — исправьте причину и
          нажмите «Продолжить».
        </InfoNote>
      )}
      {run.done > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Новых карточек</dt>
          <dd>{nf.format(r.clients_created)}</dd>
          {r.clients_reused > 0 && (
            <>
              <dt className="text-muted-foreground">Добавлено к карточкам с той же почтой</dt>
              <dd>{nf.format(r.clients_reused)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Продаж и абонементов</dt>
          <dd>{nf.format(r.sales_created)}</dd>
          <dt className="text-muted-foreground">История</dt>
          <dd>{nf.format(r.history_created)}</dd>
          {r.clients_existing + r.sales_skipped + r.history_skipped > 0 && (
            <>
              <dt className="text-muted-foreground">Уже были перенесены</dt>
              <dd>
                карточек — {nf.format(r.clients_existing)}, продаж — {nf.format(r.sales_skipped)},
                истории — {nf.format(r.history_skipped)}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
