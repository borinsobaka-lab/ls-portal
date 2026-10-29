import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsSyncPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { getReplicaConfig, runAnalyticsJob } from "@/lib/analytics/admin.functions";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { AN_JOB_LABEL, jobLabel } from "@/lib/analytics/jobs";
import {
  AN_MODES,
  AN_MODULE_ORDER,
  AN_MODULES,
  AN_TITLES,
  type AnMode,
  type AnModule,
} from "@/lib/analytics/labels";
import { formatDateTime, formatNumber } from "@/lib/format";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/analytics/admin/sync")({
  head: () => ({ meta: [{ title: "Синхронизация — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsSyncPageSkeleton,
  component: AnalyticsSyncPage,
});

type ModuleRow = { module: AnModule; mode: AnMode; updated_at: string; updated_by: string | null };
type TargetRow = {
  target: string;
  module: AnModule;
  rows: number;
  last_at: string | null;
  last_error: string | null;
  day_upserts: number;
  day_deletes: number;
};
type JobRow = {
  job: string;
  enabled: boolean;
  running_until: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: "success" | "partial" | "error" | null;
  last_message: string | null;
  last_duration_ms: number | null;
};

const JOB_TONE = { success: "positive", partial: "warning", error: "negative" } as const;
const JOB_STATUS = { success: "Готово", partial: "Частично", error: "Ошибка" } as const;

/**
 * «Аналитика» → «Синхронизация» (администратору аналитики, ANALYTICS_PLAN.md
 * §3): оба портала работают одновременно. Здесь — режимы модулей (Зеркало /
 * Проверка / Основной), приём данных от агента на старом сервере и фоновые
 * задачи.
 */
function AnalyticsSyncPage() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const configFn = useServerFn(getReplicaConfig);
  const runFn = useServerFn(runAnalyticsJob);
  const [running, setRunning] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: [ANALYTICS_KEY, "replica-config"],
    queryFn: () => configFn(),
    staleTime: 5 * 60_000,
  });
  const { data: modules, isPending: modulesLoading } = useQuery({
    queryKey: [ANALYTICS_KEY, "modules"],
    queryFn: () => unwrap<ModuleRow[]>(supabase.rpc("an_modules_list")),
    meta: { errorMessage: "Не удалось загрузить режимы модулей" },
  });
  const { data: targets, isPending: targetsLoading } = useQuery({
    queryKey: [ANALYTICS_KEY, "replica-status"],
    queryFn: () => unwrap<TargetRow[] | null>(supabase.rpc("an_replica_status")),
    refetchInterval: 60_000,
    meta: { errorMessage: "Не удалось загрузить приём данных" },
  });
  const { data: jobs, isPending: jobsLoading } = useQuery({
    queryKey: [ANALYTICS_KEY, "jobs"],
    queryFn: () => unwrap<JobRow[] | null>(supabase.rpc("an_jobs_list")),
    refetchInterval: 30_000,
    meta: { errorMessage: "Не удалось загрузить фоновые задачи" },
  });

  const setMode = async (module: AnModule, mode: AnMode) => {
    if (
      mode === "primary" &&
      !(await confirm({
        title: `Сделать «${AN_MODULES[module].label}» основным?`,
        description:
          "Данные модуля перестанут приходить со старого портала: их будут собирать сборщики этого портала, правки — вносить здесь. Задачи с внешними действиями (запись лид-форм в Google-таблицы, Telegram, основания FitBase) включайте только после того, как их остановят на старом сервере, иначе будут дубли.",
        confirmLabel: "Сделать основным",
        destructive: false,
      }))
    )
      return;
    try {
      await unwrap(supabase.rpc("an_module_set", { p_module: module, p_mode: mode }));
      await qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "modules"] });
      toast.success(`${AN_MODULES[module].label}: ${AN_MODES[mode].label.toLowerCase()}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const runJob = async (key: string) => {
    setRunning(key);
    try {
      await runFn({ data: { key } });
      toast.success("Задача выполнена");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(null);
      await qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "jobs"] });
    }
  };

  // Задачи раздела — и те, что ещё не запускались (их строки в базе нет).
  const jobRows: JobRow[] = [
    ...new Set([...Object.keys(AN_JOB_LABEL), ...(jobs ?? []).map((j) => j.job)]),
  ].map(
    (job) =>
      (jobs ?? []).find((j) => j.job === job) ?? {
        job,
        enabled: true,
        running_until: null,
        last_started_at: null,
        last_finished_at: null,
        last_status: null,
        last_message: null,
        last_duration_ms: null,
      },
  );

  const lastReceived = (targets ?? [])
    .map((t) => t.last_at)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);

  return (
    <AdminShell title={AN_TITLES.sync}>
      <div className="space-y-6">
        <InfoNote>
          Старый портал аналитики работает как прежде. Этот портал работает рядом на тех же данных:
          агент на старом сервере присылает изменения каждые несколько минут. Модуль в режиме
          «Зеркало» показывает данные старого портала; «Проверка» дополнительно сверяет наши
          сборщики с ним; «Основной» включается, когда модуль проверен.
        </InfoNote>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Режимы модулей</h2>
          <div className="overflow-hidden rounded-lg border bg-background">
            <Table data-mobile-cards>
              <TableHeader>
                <TableRow>
                  <TableHead>Модуль</TableHead>
                  <TableHead>Режим</TableHead>
                  <TableHead>Изменён</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modulesLoading ? (
                  <TableSkeletonRows columns={3} rows={AN_MODULE_ORDER.length} />
                ) : (
                  AN_MODULE_ORDER.map((m) => {
                    const row = modules?.find((r) => r.module === m);
                    return (
                      <TableRow key={m}>
                        <TableCell>
                          <div className="font-medium">{AN_MODULES[m].label}</div>
                          <div className="text-xs text-muted-foreground">{AN_MODULES[m].hint}</div>
                        </TableCell>
                        <TableCell>
                          <SegmentedControl
                            aria-label={`Режим: ${AN_MODULES[m].label}`}
                            value={row?.mode ?? "mirror"}
                            onChange={(mode) => void setMode(m, mode)}
                            options={(Object.keys(AN_MODES) as AnMode[]).map((mode) => ({
                              value: mode,
                              label: AN_MODES[mode].label,
                              title: AN_MODES[mode].hint,
                            }))}
                          />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {row?.updated_by
                            ? `${formatDateTime(row.updated_at)} · ${row.updated_by}`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Приём данных со старого портала</h2>
          {config && (!config.secretSet || !config.secretsKeySet || !config.publicKeyPem) && (
            <InfoNote variant="warning">
              На сервере портала не заданы переменные:{" "}
              {[
                !config.secretSet && "ANALYTICS_REPLICA_SECRET",
                !config.secretsKeySet && "ANALYTICS_SECRETS_KEY",
                !config.publicKeyPem && "ANALYTICS_REPLICA_PRIVATE_KEY",
              ]
                .filter(Boolean)
                .join(", ")}
              . Без них агент не сможет присылать данные и ключи интеграций (DEPLOY.md,
              «Аналитика»).
            </InfoNote>
          )}
          <div className="rounded-lg border bg-background p-4 text-sm">
            <div>
              Адрес приёма: <span className="font-mono text-xs">{config?.endpoint ?? "…"}</span>
            </div>
            <div className="text-muted-foreground">
              Последняя пачка: {lastReceived ? formatDateTime(lastReceived) : "ещё не приходила"}
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border bg-background">
            <Table data-mobile-cards>
              <TableHeader>
                <TableRow>
                  <TableHead>Таблица</TableHead>
                  <TableHead>Модуль</TableHead>
                  <TableHead className="text-right">Строк</TableHead>
                  <TableHead className="text-right">За сутки</TableHead>
                  <TableHead>Последняя пачка</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targetsLoading ? (
                  <TableSkeletonRows columns={5} rows={3} />
                ) : (targets ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      Таблицы модулей появятся вместе с их переносом.
                    </TableCell>
                  </TableRow>
                ) : (
                  (targets ?? []).map((t) => (
                    <TableRow key={t.target}>
                      <TableCell className="font-mono text-xs">{t.target}</TableCell>
                      <TableCell>{AN_MODULES[t.module]?.label ?? t.module}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(t.rows)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        +{formatNumber(t.day_upserts)} / −{formatNumber(t.day_deletes)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {t.last_at ? formatDateTime(t.last_at) : "—"}
                        {t.last_error && (
                          <div className="text-xs text-destructive">{t.last_error}</div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Фоновые задачи</h2>
          <div className="overflow-hidden rounded-lg border bg-background">
            <Table data-mobile-cards>
              <TableHeader>
                <TableRow>
                  <TableHead>Задача</TableHead>
                  <TableHead>Последний запуск</TableHead>
                  <TableHead>Итог</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobsLoading ? (
                  <TableSkeletonRows columns={4} rows={2} />
                ) : (
                  jobRows.map((j) => {
                    const busy =
                      running === j.job ||
                      (!!j.running_until && new Date(j.running_until) > new Date());
                    return (
                      <TableRow key={j.job}>
                        <TableCell className="font-medium">{jobLabel(j.job)}</TableCell>
                        <TableCell className="text-sm">
                          {j.last_started_at ? formatDateTime(j.last_started_at) : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {busy ? (
                            <StatusChip tone="info">Выполняется</StatusChip>
                          ) : j.last_status ? (
                            <StatusChip tone={JOB_TONE[j.last_status]}>
                              {JOB_STATUS[j.last_status]}
                            </StatusChip>
                          ) : (
                            "—"
                          )}
                          {j.last_message && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {j.last_message}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void runJob(j.job)}
                          >
                            Запустить
                          </Button>
                        </TableCell>
                      </TableRow>
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
