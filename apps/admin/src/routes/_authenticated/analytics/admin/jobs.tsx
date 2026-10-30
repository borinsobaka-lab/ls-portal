import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsJobsPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { getAnalyticsConfig, runAnalyticsJob } from "@/lib/analytics/admin.functions";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { AN_JOBS, jobEnabled, jobLabel } from "@/lib/analytics/jobs";
import { AN_TITLES } from "@/lib/analytics/labels";
import { formatDateTime } from "@/lib/format";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/analytics/admin/jobs")({
  head: () => ({ meta: [{ title: "Фоновые задачи — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsJobsPageSkeleton,
  component: AnalyticsJobsPage,
});

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
const TIPS = {
  enabled:
    "Выключенную задачу сервер не запускает. Задачи с внешним действием (Telegram, Google-таблицы, публикации VK) выключены, пока их не включат: старый портал делает то же самое.",
};

/**
 * «Аналитика» → «Фоновые задачи» (администратору аналитики,
 * ANALYTICS_PLAN.md §7): сборщики и рассылки модулей с тем же расписанием,
 * что на старом портале, — последний запуск, итог, включение, «Запустить».
 */
function AnalyticsJobsPage() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const configFn = useServerFn(getAnalyticsConfig);
  const runFn = useServerFn(runAnalyticsJob);
  const [running, setRunning] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: [ANALYTICS_KEY, "config"],
    queryFn: () => configFn(),
    staleTime: 5 * 60_000,
  });
  const { data: jobs, isPending } = useQuery({
    queryKey: [ANALYTICS_KEY, "jobs"],
    queryFn: () => unwrap<JobRow[] | null>(supabase.rpc("an_jobs_list")),
    refetchInterval: 30_000,
    meta: { errorMessage: "Не удалось загрузить фоновые задачи" },
  });

  const rows = [...new Set([...Object.keys(AN_JOBS), ...(jobs ?? []).map((j) => j.job)])].map(
    (job) => ({ job, state: (jobs ?? []).find((j) => j.job === job) }),
  );

  const setEnabled = async (job: string, enabled: boolean) => {
    if (
      enabled &&
      AN_JOBS[job]?.external &&
      !(await confirm({
        title: `Включить «${jobLabel(job)}»?`,
        description:
          "Задача делает что-то снаружи — пишет в таблицы, шлёт сообщения, публикует. Если та же задача работает на старом портале, будут дубли: включайте, когда её там выключили или когда дубли не мешают сверке.",
        confirmLabel: "Включить",
        destructive: false,
      }))
    )
      return;
    try {
      await unwrap(supabase.rpc("an_job_set_enabled", { p_job: job, p_enabled: enabled }));
      await qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "jobs"] });
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

  return (
    <AdminShell title={AN_TITLES.jobs}>
      <div className="space-y-4">
        <InfoNote>
          Сборщики и рассылки «Аналитики» работают на этом сервере по тому же расписанию, что на
          старом портале аналитики. Порталы друг с другом не связаны: каждый берёт данные из 1С,
          FitBase, amoCRM, VK и Авито сам, поэтому цифры можно сверять.
        </InfoNote>
        {config && !config.secretsKeySet && (
          <InfoNote variant="warning">
            На сервере портала не задан ANALYTICS_SECRETS_KEY — ключи подключений (VK Ads, amoCRM,
            Авито, FitBase, Telegram) не сохранить (DEPLOY.md, «Аналитика»).
          </InfoNote>
        )}
        {config && !config.jobsOn && (
          <InfoNote variant="warning">
            На этом сервере фоновые задачи выключены (ANALYTICS_JOBS=off или PUSH_WORKER=off) — их
            выполняет другой контейнер.
          </InfoNote>
        )}
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Задача</TableHead>
                <TableHead tip={TIPS.enabled}>Включена</TableHead>
                <TableHead>Последний запуск</TableHead>
                <TableHead>Итог</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableSkeletonRows columns={5} rows={2} />
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Задачи появятся вместе с модулями «Аналитики».
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(({ job, state: j }) => {
                  const enabled = jobEnabled(job, j);
                  const busy =
                    running === job ||
                    (!!j?.running_until && new Date(j.running_until) > new Date());
                  return (
                    <TableRow key={job}>
                      <TableCell>
                        <div className="font-medium">{jobLabel(job)}</div>
                        {AN_JOBS[job]?.external && (
                          <div className="text-xs text-muted-foreground">Внешнее действие</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(on) => void setEnabled(job, on)}
                          aria-label={
                            enabled ? `Выключить «${jobLabel(job)}»` : `Включить «${jobLabel(job)}»`
                          }
                        />
                      </TableCell>
                      <TableCell className="text-sm">
                        {j?.last_started_at ? formatDateTime(j.last_started_at) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {busy ? (
                          <StatusChip tone="info">Выполняется</StatusChip>
                        ) : j?.last_status ? (
                          <StatusChip tone={JOB_TONE[j.last_status]}>
                            {JOB_STATUS[j.last_status]}
                          </StatusChip>
                        ) : (
                          "—"
                        )}
                        {j?.last_message && (
                          <div className="mt-1 text-xs text-muted-foreground">{j.last_message}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || !enabled}
                          onClick={() => void runJob(job)}
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
      </div>
      {confirmDialog}
    </AdminShell>
  );
}
