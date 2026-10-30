import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { FbConnectionForm, FbStudioCard } from "@/components/analytics/fitbase/parts";
import { AnalyticsFitbasePageSkeleton } from "@/components/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import { startFitbaseBatch } from "@/lib/analytics/fitbase.functions";
import {
  fbConnectionsQuery,
  invalidateFitbase,
  type FbOverview,
} from "@/lib/analytics/fitbase/data";
import { fbAttendanceStateLabel } from "@/lib/analytics/fitbase/rules";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/crm/fitbase/")({
  head: () => ({ meta: [{ title: "Интеграция FitBase — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsFitbasePageSkeleton,
  component: AnalyticsFitbasePage,
});

/**
 * «Аналитика» → «CRM» → «Интеграция FitBase» (администратору аналитики) —
 * их fitbase_page: загрузка всех студий по очереди, подключённые студии
 * (итог, «Обновить всё», подробности), подключение новой студии. Настройки
 * студии — /analytics/crm/fitbase/<id>.
 */
function AnalyticsFitbasePage() {
  const { data, isPending, error } = useQuery(fbConnectionsQuery);
  const [adding, setAdding] = useState(false);
  const connections = data?.connections ?? [];

  return (
    <AdminShell
      title={AN_TITLES.fitbase}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Подключить студию
        </Button>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          Подключения студий и правила вашей маркетинговой воронки. Портал только читает FitBase:
          лиды, абонементы и оплаты, занятия и записи, выручку. Ключ API хранится зашифрованным.
          Каждую ночь в 01:00 МСК портал сам загружает изменения всех студий.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            <BatchPanel data={data} loading={isPending} />
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">Подключённые студии</h2>
                <StatusChip tone="neutral">{connections.length}</StatusChip>
              </div>
              {isPending ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-44 rounded-lg" />
                  ))}
                </div>
              ) : connections.length === 0 ? (
                <div className="rounded-lg border bg-background p-6 text-center">
                  <h3 className="font-semibold">Подключений пока нет</h3>
                  <p className="text-sm text-muted-foreground">
                    Добавьте первую студию, проверьте доступ и настройте этапы.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {connections.map((c) => (
                    <FbStudioCard key={c.id} c={c} nightly={data!.nightly} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-2xl">
          {adding && <FbConnectionForm current={null} onClose={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Их «Загрузка всех студий»: очередь по одной студии, итоги по студиям. */
function BatchPanel({ data, loading }: { data?: FbOverview; loading: boolean }) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const batch = data?.batch ?? { active: false };
  const connections = data?.connections ?? [];
  const total = batch.total || connections.length;
  const done = batch.completed ?? 0;
  const errors = batch.errors ?? 0;
  const success = !batch.active && total > 0 && done === total && !errors;
  const mode = batch.active
    ? "loading"
    : success
      ? "success"
      : errors || batch.message || batch.interrupted
        ? "warning"
        : "idle";
  const title = {
    loading: "Загружаем данные",
    success: "Все данные загружены",
    warning: "Загрузка требует внимания",
    idle: "Готово к загрузке",
  }[mode];
  const message = batch.interrupted
    ? "Общая загрузка прервана перезапуском. Запустите повторно."
    : success
      ? `Успешно обновлено студий: ${done}`
      : batch.message || "Студии загружаются по очереди в фоне. Можно закрыть страницу.";
  const start = async () => {
    setStarting(true);
    try {
      await startFitbaseBatch();
      toast.success("Общая загрузка поставлена в очередь.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await invalidateFitbase(qc);
      setStarting(false);
    }
  };
  const results = batch.results ?? [];
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Загрузка всех студий</h2>
          <p className="text-sm text-muted-foreground">
            Лиды, продажи абонементов, занятия и выручка по всем подключённым городам.
          </p>
        </div>
        <Button
          disabled={loading || batch.active || !connections.length || starting}
          onClick={() => void start()}
        >
          {batch.active || starting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {batch.active ? "Загрузка…" : "Загрузить всё"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusChip
          tone={
            mode === "loading"
              ? "info"
              : mode === "success"
                ? "positive"
                : mode === "warning"
                  ? "warning"
                  : "neutral"
          }
        >
          {title}
        </StatusChip>
        <span role="status">{message}</span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {done} из {total}
        </span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground select-none">
          Результаты по студиям <span className="tabular-nums">{results.length}</span>
        </summary>
        {results.length ? (
          <ul className="mt-2 space-y-1">
            {results.map((r, i) => (
              <li key={`${r.id}-${i}`} className="grid gap-0.5 sm:grid-cols-[minmax(0,14rem)_1fr]">
                <strong className="font-medium">{r.name}</strong>
                <span className="break-words text-muted-foreground">
                  {fbAttendanceStateLabel(r.message)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-muted-foreground">Пока нет результатов.</p>
        )}
      </details>
      <p className="text-xs text-muted-foreground">
        Статусы и подробности загрузки — в результатах по студиям.
      </p>
    </section>
  );
}
