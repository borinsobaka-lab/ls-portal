import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowLeft, Copy, KeyRound, Loader2, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsFbBasisPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/integrations/supabase/client";
import { runAnalyticsJob } from "@/lib/analytics/admin.functions";
import {
  forgetFitbaseWebSession,
  issueFitbaseWebCode,
  saveFitbaseWebSession,
} from "@/lib/analytics/fitbase.functions";
import { FB_KEY, fbBasisQuery, type FbBasisOverview } from "@/lib/analytics/fitbase/data";
import { fbTimestamp } from "@/lib/analytics/fitbase/reports";
import { FB_BASIS_ERRORS, FB_BASIS_STATES } from "@/lib/analytics/fitbase/web";
import { AN_TITLES } from "@/lib/analytics/labels";
import { unwrap } from "@/lib/query";

export const Route = createFileRoute("/_authenticated/analytics/crm/fitbase/basis")({
  head: () => ({ meta: [{ title: "Основания записей FitBase — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsFbBasisPageSkeleton,
  component: AnalyticsFbBasisPage,
});

const TEXT = {
  intro:
    "Для части записей FitBase не отдаёт в API основание — выбранную услугу или абонемент (например, «Пробное занятие» у отказавшегося клиента). На странице записей FitBase оно есть. Сборщик читает список записей всех студий и добавляет основание к типу записи: пробная — если название однозначно совпадает с выбранной пробной услугой студии. Записи, статусы, оплаты и выручка не меняются.",
  session:
    "Вход в FitBase защищён CAPTCHA, поэтому входит владелец сам — в отдельном окне браузера на своём компьютере. Помощник входа передаёт порталу только сессию (cookies FitBase), пароль остаётся в FitBase. Сессия хранится зашифрованной; если FitBase её отзовёт, понадобится войти заново.",
  helper:
    "На компьютере с Windows: скачайте папку deploy/fitbase-session из репозитория портала, запустите «Подключить FitBase.bat», войдите в FitBase в открывшемся окне и вставьте этот код, когда помощник попросит. Код действует 15 минут и один раз.",
  job: "Каждые 5 минут сборщик проходит до 120 страниц: сначала записи последних трёх дней, затем текущий месяц всех студий, затем прошлые месяцы. FitBase показывает по 10 записей на странице, поэтому первая сверка всей истории занимает время. Чтобы читать студию, сборщик выбирает её клуб в FitBase — это меняет выбранный клуб учётной записи и в других её сеансах (например, у сборщика старого портала). Поэтому задача включается вручную.",
  counts: {
    pages: "Страниц прочитано",
    trial: "Пробных оснований",
    regular: "Обычных оснований",
    unknown_label: "Название не сопоставлено",
    not_in_api_cache: "Записи ещё нет в загрузке API",
    empty: "Без основания",
    time_mismatch: "Не совпал день занятия",
    pending_jobs: "Заданий в очереди",
    failed_jobs: "Заданий с ошибками",
  } as Record<string, string>,
};

/**
 * «Интеграция FitBase» → «Основания записей» (администратору аналитики) —
 * их automatic-basis: сессия FitBase от помощника входа, сборщик оснований
 * со страниц записей (фоновая задача `fitbase_basis`), очередь заданий.
 */
function AnalyticsFbBasisPage() {
  const { data, error } = useQuery(fbBasisQuery);
  return (
    <AdminShell title={AN_TITLES.fbBasis}>
      <div className="max-w-5xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/crm/fitbase">
            <ArrowLeft />
            Интеграция FitBase
          </Link>
        </Button>
        <InfoNote>{TEXT.intro}</InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <>
            <SessionCard data={data} />
            <CollectorCard data={data} />
            <JobsCard data={data} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

function SessionCard({ data }: { data: FbBasisOverview }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [code, setCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const state = data.status?.state ?? "not_authorized";
  const issue = async () => {
    setIssuing(true);
    try {
      const r = await issueFitbaseWebCode();
      setCode(r.code);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setIssuing(false);
    }
  };
  const forget = async () => {
    if (
      !(await confirm({
        title: "Удалить сессию FitBase?",
        description: "Сборщик остановится до нового входа. Собранные основания останутся.",
        confirmLabel: "Удалить",
        destructive: true,
      }))
    )
      return;
    try {
      await forgetFitbaseWebSession();
      await qc.invalidateQueries({ queryKey: [...FB_KEY, "basis"] });
      toast.success("Сессия удалена.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Сессия FitBase</h2>
          <p className="text-sm text-muted-foreground">{TEXT.session}</p>
        </div>
        <StatusChip
          tone={
            state === "login_required" || state === "worker_error"
              ? "warning"
              : data.session
                ? "positive"
                : "neutral"
          }
        >
          {FB_BASIS_STATES[state] ?? state}
        </StatusChip>
      </div>
      <p className="text-sm">
        {data.session
          ? `Сессия сохранена ${fbTimestamp(Date.parse(data.session.updated_at) / 1000)} МСК.`
          : "Сессии нет."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void issue()} disabled={issuing}>
          {issuing ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Подключить через помощника
        </Button>
        <Button variant="outline" onClick={() => setPasting(true)}>
          Вставить сессию вручную
        </Button>
        {data.session && (
          <Button variant="outline" onClick={() => void forget()}>
            <Trash2 />
            Удалить сессию
          </Button>
        )}
      </div>
      {code && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-sm">{TEXT.helper}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full rounded bg-background px-2 py-1 text-xs break-all">
              {code}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                toast.success("Код скопирован.");
              }}
            >
              <Copy />
              Скопировать код
            </Button>
          </div>
        </div>
      )}
      <Dialog open={pasting} onOpenChange={setPasting}>
        <DialogContent className="sm:max-w-xl">
          {pasting && <PasteForm onClose={() => setPasting(false)} />}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </section>
  );
}

function PasteForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [json, setJson] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!json.trim()) {
      toast.error("Вставьте сессию помощника входа.");
      return;
    }
    setSaving(true);
    try {
      const r = await saveFitbaseWebSession({ data: { json } });
      await qc.invalidateQueries({ queryKey: [...FB_KEY, "basis"] });
      toast.success(`Сессия сохранена. Доступ ко всем клубам студий подтверждён: ${r.studios}.`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Сессия FitBase вручную</DialogTitle>
      </DialogHeader>
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody>
          <FormField
            label="Сессия (JSON помощника входа)"
            required
            tip="То, что помощник сохраняет в файл с ключом --save: адрес FitBase и cookies входа. Портал проверит сессию на FitBase."
          >
            <Textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={8}
              className="font-mono text-xs"
              placeholder='{"origin": "https://…fitbase.io", "cookies": […]}'
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Проверить и сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

function CollectorCard({ data }: { data: FbBasisOverview }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const enabled = Boolean(data.job?.enabled);
  const counts = data.status?.counts ?? {};
  const toggle = async (on: boolean) => {
    try {
      await unwrap(supabase.rpc("an_job_set_enabled", { p_job: "fitbase_basis", p_enabled: on }));
      await qc.invalidateQueries({ queryKey: [...FB_KEY, "basis"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      await runAnalyticsJob({ data: { key: "fitbase_basis" } });
      const fresh = await qc.fetchQuery({ ...fbBasisQuery, staleTime: 0 });
      const state = fresh.status?.state ?? "";
      if (state === "login_required" || state === "worker_error" || state === "not_authorized")
        toast.error(FB_BASIS_STATES[state]);
      else toast.success(`Проход сборщика завершён: ${FB_BASIS_STATES[state] ?? state}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Сборщик оснований</h2>
          <p className="text-sm text-muted-foreground">{TEXT.job}</p>
        </div>
        <Button onClick={() => void run()} disabled={!enabled || !data.session || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          Запустить проход
        </Button>
      </div>
      <SwitchRow
        title="Собирать основания каждые 5 минут"
        checked={enabled}
        onCheckedChange={(v) => void toggle(v)}
      />
      <p className="text-sm text-muted-foreground">
        Последний проход:{" "}
        {data.status?.checked_at ? `${fbTimestamp(data.status.checked_at)} МСК` : "ещё не было"} ·
        оснований в базе: {Object.values(data.basis).reduce((s, n) => s + n, 0)} · ждут загрузки
        API: {data.pending}
      </p>
      {Object.keys(counts).length > 0 && (
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.entries(TEXT.counts)
            .filter(([k]) => k in counts)
            .map(([k, label]) => (
              <div key={k} className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{counts[k]}</p>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function JobsCard({ data }: { data: FbBasisOverview }) {
  const names = useMemo(() => new Map(data.connections.map((c) => [c.id, c.name])), [data]);
  const rows = data.jobs;
  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">Задания по студиям</h2>
        <p className="text-sm text-muted-foreground">
          Месяц студии сверяется полностью; «Свежие записи» — созданные за три дня, каждые 15 минут.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Студия</TableHead>
            <TableHead>Задание</TableHead>
            <TableHead className="text-right">Записей</TableHead>
            <TableHead>Сверено</TableHead>
            <TableHead>Ошибка</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((j) => (
            <TableRow key={`${j.connection_id}|${j.month}`}>
              <TableCell>{names.get(j.connection_id) ?? j.connection_id}</TableCell>
              <TableCell>
                {j.month === "recent" ? "Свежие записи" : j.month}
                {j.passes > 1 && (
                  <span className="ml-1 text-xs text-muted-foreground">проход {j.passes}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {j.seen}
                {j.total !== null ? ` из ${j.total}` : ""}
              </TableCell>
              <TableCell>
                {j.finished_at ? `${fbTimestamp(j.finished_at)}` : `стр. ${j.page}`}
              </TableCell>
              <TableCell>
                {j.error ? <span title={j.error}>{FB_BASIS_ERRORS[j.error] ?? j.error}</span> : "—"}
              </TableCell>
            </TableRow>
          ))}
          {!rows.length && (
            <TableRow>
              <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                Заданий ещё нет — они появятся после первого прохода сборщика.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
}
