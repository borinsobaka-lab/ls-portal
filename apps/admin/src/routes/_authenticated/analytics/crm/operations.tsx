import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import {
  AnalyticsAmoOpsBodySkeleton,
  AnalyticsAmoOpsPageSkeleton,
  AnalyticsAmoOpsReportSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { startAmoOpsRun } from "@/lib/analytics/amo-ops.functions";
import {
  AMO_OPS_KEY,
  amoOpsOverviewQuery,
  amoOpsWindowQuery,
  type OpsOverview,
  type OpsWindowData,
} from "@/lib/analytics/amo-ops/data";
import {
  buildOpsReport,
  opsNum,
  opsReactionStats,
  opsRows,
  opsSources,
  opsStamp,
  opsTasks,
  opsWindow,
  OPS_EVENT_LABELS,
  OPS_KIND_LABELS,
  OPS_TASK_LABELS,
  type OpsReport,
} from "@/lib/analytics/amo-ops/rules";
import { mskToday } from "@/lib/analytics/core";
import { addDaysIso } from "@/lib/analytics/onec-reports/payload";
import { AN_TITLES } from "@/lib/analytics/labels";

const TABS = [
  { value: "reaction", label: "Реакция" },
  { value: "tasks", label: "Задачи" },
  { value: "sources", label: "Источники и неквал" },
  { value: "coverage", label: "Полнота данных" },
] as const;
type Tab = (typeof TABS)[number]["value"];

type OpsSearch = { connection?: number; start?: number; tab?: Tab; team?: string; source?: string };
const posInt = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
const text = (v: unknown) => (typeof v === "string" && v && v.length <= 300 ? v : undefined);

export const Route = createFileRoute("/_authenticated/analytics/crm/operations")({
  head: () => ({ meta: [{ title: "Операционная аналитика amoCRM — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): OpsSearch => ({
    connection: posInt(s.connection),
    start: posInt(s.start),
    tab: TABS.some((t) => t.value === s.tab) ? (s.tab as Tab) : undefined,
    team: text(s.team),
    source: text(s.source),
  }),
  pendingComponent: AnalyticsAmoOpsPageSkeleton,
  component: AmoOpsPage,
});

/** Их тексты: мастер сбора, страница отчёта. */
const TEXT = {
  lead: "Пилот операционной аналитики: по одному подключению amoCRM за прошедший день (МСК) — ограниченный сбор сделок, событий и задач только на чтение (не больше 120 запросов за 5 минут). Сохраняются только ID, время, этапы и ID ответственных — без текстов, имён и контактов клиентов. Настройки источника и оснований закрытия — из «Интеграции amoCRM».",
  running: "Сбор реальных данных. Рабочий портал продолжает работать.",
  notice:
    "Реальные события CRM за выбранный день. Авторство человека и автоматизации пока не подтверждено; скорость ниже относится к зарегистрированным действиям.",
  footer: "Нормативы реакции не применяются",
};

const RUN_STATUS = {
  running: { label: "Идёт сбор", tone: "info" },
  success: { label: "Собрано", tone: "positive" },
  error: { label: "Ошибка", tone: "negative" },
} as const;

function AmoOpsPage() {
  const search = Route.useSearch();
  const overview = useQuery(amoOpsOverviewQuery);
  return (
    <AdminShell title={AN_TITLES.amoOps}>
      <div className="max-w-6xl space-y-5">
        <InfoNote variant="info">{TEXT.lead}</InfoNote>
        {overview.isPending ? (
          <AnalyticsAmoOpsBodySkeleton />
        ) : overview.error ? (
          <InfoNote variant="warning">{(overview.error as Error).message}</InfoNote>
        ) : (
          <>
            <RunForm overview={overview.data} />
            <RunsTable overview={overview.data} />
            <ReportBlock overview={overview.data} search={search} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

function RunForm({ overview }: { overview: OpsOverview }) {
  const qc = useQueryClient();
  const yesterday = addDaysIso(mskToday(), -1);
  const ready = overview.connections.filter((c) => c.has_settings);
  const [connection, setConnection] = useState(ready[0] ? String(ready[0].id) : "");
  const [day, setDay] = useState(yesterday);
  const [saving, setSaving] = useState(false);
  const running = overview.runs.some((r) => r.status === "running");

  if (!overview.connections.length) {
    return (
      <InfoNote variant="empty">
        Нет активных подключений amoCRM — добавьте подключение в «Интеграции amoCRM».
      </InfoNote>
    );
  }

  const start = async () => {
    if (!connection) return toast.error("Выберите подключение");
    if (!day) return toast.error("Укажите день");
    setSaving(true);
    try {
      await startAmoOpsRun({ data: { connectionId: Number(connection), day } });
      toast.success(TEXT.running);
      await qc.invalidateQueries({ queryKey: [...AMO_OPS_KEY, "overview"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-background p-4">
      <h2 className="text-base font-semibold">Сбор за день</h2>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end">
        <FormField
          label="Подключение amoCRM"
          required
          tip="Активные подключения «Интеграции amoCRM». Без сохранённых правил источника и квалификации сбор не запускается."
        >
          <Select value={connection} onValueChange={setConnection}>
            <SelectTrigger>
              <SelectValue placeholder="Выберите подключение" />
            </SelectTrigger>
            <SelectContent>
              {overview.connections.map((c) => (
                <SelectItem key={c.id} value={String(c.id)} disabled={!c.has_settings}>
                  {c.id}: {c.name}
                  {c.has_settings ? "" : " — нет правил"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label="День (МСК)"
          required
          htmlFor="ops-day"
          tip="Прошедший день по Москве: окно 00:00:00 — 23:59:59. Повторный сбор того же дня заменяет окно."
        >
          <Input
            id="ops-day"
            type="date"
            value={day}
            max={yesterday}
            onChange={(e) => setDay(e.target.value)}
          />
        </FormField>
        <Button onClick={start} disabled={saving || running}>
          {saving || running ? <Loader2 className="animate-spin" /> : <Play />}
          {running ? "Идёт сбор" : "Собрать"}
        </Button>
      </div>
      {!ready.length && (
        <InfoNote variant="warning">
          Ни у одного подключения нет сохранённых правил источника и квалификации — сохраните их в
          «Интеграции amoCRM».
        </InfoNote>
      )}
    </section>
  );
}

function RunsTable({ overview }: { overview: OpsOverview }) {
  const navigate = useNavigate({ from: Route.fullPath });
  if (!overview.runs.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Запуски</h2>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Подключение</TableHead>
              <TableHead>День</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Запросов</TableHead>
              <TableHead className="text-right">Сделок</TableHead>
              <TableHead className="text-right">Задач</TableHead>
              <TableHead className="text-right">Событий</TableHead>
              <TableHead>Запущен</TableHead>
              <TableHead>Итог</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.runs.map((r) => {
              const start = opsWindow(r.day, "9999-12-31")?.start;
              const window = overview.windows.find(
                (w) => w.connection_id === r.connection_id && w.start === start,
              );
              return (
                <TableRow key={r.id}>
                  <TableCell>{r.connection}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.day}</TableCell>
                  <TableCell>
                    <StatusChip tone={RUN_STATUS[r.status].tone}>
                      {RUN_STATUS[r.status].label}
                    </StatusChip>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.tasks}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.events}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {opsStamp(Date.parse(r.started_at) / 1000)} МСК
                  </TableCell>
                  <TableCell className="max-w-72 break-words">
                    {r.status === "success" && window ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() =>
                          navigate({
                            search: (s) => ({
                              ...s,
                              connection: r.connection_id,
                              start: window.start,
                            }),
                          })
                        }
                      >
                        Открыть отчёт
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">{r.message || "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ReportBlock({ overview, search }: { overview: OpsOverview; search: OpsSearch }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const windows = useMemo(
    () =>
      [...overview.windows].sort((a, b) => b.start - a.start || a.connection_id - b.connection_id),
    [overview.windows],
  );
  const latest = useMemo(
    () => [...overview.windows].sort((a, b) => b.captured_at.localeCompare(a.captured_at))[0],
    [overview.windows],
  );
  const picked =
    windows.find((w) => w.connection_id === search.connection && w.start === search.start) ??
    latest;
  const data = useQuery({
    ...amoOpsWindowQuery(picked?.connection_id ?? 0, picked?.start ?? 0),
    enabled: !!picked,
  });

  if (!picked) {
    return (
      <InfoNote variant="empty">
        Собранных окон пока нет — выберите подключение и день и нажмите «Собрать».
      </InfoNote>
    );
  }
  const key = `${picked.connection_id}:${picked.start}`;
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">Обработка заявок amoCRM</h2>
      <TableToolbar>
        <FormField label="Окно сбора" className="w-full sm:w-96">
          <Select
            value={key}
            onValueChange={(v) => {
              const [c, s] = v.split(":").map(Number);
              navigate({
                search: (p) => ({
                  ...p,
                  connection: c,
                  start: s,
                  team: undefined,
                  source: undefined,
                }),
              });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {windows.map((w) => (
                <SelectItem
                  key={`${w.connection_id}:${w.start}`}
                  value={`${w.connection_id}:${w.start}`}
                >
                  {w.connection} · {opsStamp(w.start).split(",")[0]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </TableToolbar>
      {data.isPending ? (
        <AnalyticsAmoOpsReportSkeleton />
      ) : data.error ? (
        <InfoNote variant="warning">{(data.error as Error).message}</InfoNote>
      ) : (
        <Report key={key} data={data.data} name={picked.connection} search={search} />
      )}
    </section>
  );
}

function Report({ data, name, search }: { data: OpsWindowData; name: string; search: OpsSearch }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const built = useMemo((): { report: OpsReport } | { error: string } => {
    try {
      return { report: buildOpsReport(data) };
    } catch (e) {
      return { error: (e as Error).message || "Report failed" };
    }
  }, [data]);
  const tab = search.tab ?? "reaction";
  const [detail, setDetail] = useState<{ id: string; at: string } | null>(null);
  if ("error" in built) return <InfoNote variant="warning">REPORT_FAILED: {built.error}</InfoNote>;
  const d = built.report;
  const teams = [...new Set(d.reaction.rows.map((l) => l.team))].sort();
  const sources = [...new Set(d.reaction.rows.map((l) => l.source))].sort();
  const team = search.team && teams.includes(search.team) ? search.team : "all";
  const source = search.source && sources.includes(search.source) ? search.source : "all";
  const ls = opsRows(d, team, source);
  // Их render(): смена вкладки или фильтра скрывает карточку сделки.
  const at = `${tab}|${team}|${source}`;
  const shown = detail && detail.at === at ? ls.find((x) => x.id === detail.id) : undefined;
  const show = (id: string) => setDetail({ id, at });
  const lead = (id: string) => (
    <Button key={id} variant="link" size="sm" className="h-auto p-0" onClick={() => show(id)}>
      {id}
    </Button>
  );
  const setFilter = (patch: Partial<OpsSearch>) =>
    navigate({ search: (s) => ({ ...s, ...patch }) });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {d.demo ? "ДЕМОНСТРАЦИЯ · " : ""}Подключение {d.account} · {name} · созданы{" "}
        {opsStamp(d.start)} — {opsStamp(d.end)} МСК · загружено {opsStamp(d.captured_at)} МСК
      </p>
      <InfoNote variant="info">{TEXT.notice}</InfoNote>
      <TableToolbar>
        <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <FormField label="Ответственный">
            <Select
              value={team}
              onValueChange={(v) => setFilter({ team: v === "all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все</SelectItem>
                {teams.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Источник">
            <Select
              value={source}
              onValueChange={(v) => setFilter({ source: v === "all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все</SelectItem>
                {sources.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </TableToolbar>
      <Tabs
        value={tab}
        onValueChange={(v) => setFilter({ tab: v === "reaction" ? undefined : (v as Tab) })}
      >
        <TabsList aria-label="Показатели" className="max-w-full overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === "reaction" && <ReactionTab rows={ls} lead={lead} />}
      {tab === "tasks" && (
        <TasksTab report={d} rows={ls} filtered={team !== "all" || source !== "all"} />
      )}
      {tab === "sources" && <SourcesTab report={d} rows={ls} lead={lead} />}
      {tab === "coverage" && <CoverageTab report={d} />}
      {shown && (
        <section className="space-y-3 rounded-lg border bg-background p-4" aria-live="polite">
          <h3 className="text-base font-semibold">Сделка {shown.id}</h3>
          <div className="flex flex-wrap gap-3">
            <div className="max-w-60 rounded-md bg-muted/60 p-3 text-sm">
              <p className="font-semibold">{opsStamp(shown.created_at)}</p>
              Создана в CRM
            </div>
            {d.events
              .filter((e) => e.lead_id === shown.id)
              .sort((a, b) => a.occurred_at - b.occurred_at)
              .map((e, i) => (
                <div key={`${e.id}-${i}`} className="max-w-60 rounded-md bg-muted/60 p-3 text-sm">
                  <p className="font-semibold">{opsStamp(e.occurred_at)}</p>
                  {OPS_KIND_LABELS[e.kind] || e.kind}
                  <p className="text-muted-foreground">
                    Автор {e.created_by} · {e.actor_kind}
                  </p>
                </div>
              ))}
          </div>
        </section>
      )}
      <p className="text-sm text-muted-foreground">{TEXT.footer}</p>
    </div>
  );
}

const Empty = ({ cols }: { cols: number }) => (
  <TableRow>
    <TableCell colSpan={cols} className="text-muted-foreground">
      Нет данных
    </TableCell>
  </TableRow>
);

function ReactionTab({
  rows,
  lead,
}: {
  rows: ReturnType<typeof opsRows>;
  lead: (id: string) => ReactNode;
}) {
  const s = opsReactionStats(rows);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Создано сделок" value={s.created} note="Включая дубли" />
        <StatTile
          label="Среднее до действия CRM"
          value={opsNum(s.avg) + " мин"}
          note={`Измерено ${s.measured} из ${s.created}`}
        />
        <StatTile
          label="Медиана до действия CRM"
          value={opsNum(s.median) + " мин"}
          note="Человек / автоматизация не разделены"
        />
        <StatTile
          label="Без основного действия"
          value={s.created - s.measured}
          note="В загруженной истории"
        />
      </div>
      <section className="space-y-2">
        <h3 className="text-base font-semibold">Когда начали обрабатывать заявки</h3>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Сделка</TableHead>
                <TableHead>Ответственный / источник</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Время</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((l, i) => (
                  <TableRow key={`${l.id}-${i}`}>
                    <TableCell>{lead(l.id)}</TableCell>
                    <TableCell>
                      {l.team}
                      <br />
                      {l.source}
                    </TableCell>
                    <TableCell>
                      {(l.reaction.kind && OPS_KIND_LABELS[l.reaction.kind]) || "Не наблюдалось"}
                      {l.reaction.status === "stage_only" && (
                        <span className="block text-sm text-muted-foreground">
                          Запасной признак
                        </span>
                      )}
                      {l.verified_reaction.unknown_actor_events > 0 && (
                        <span className="block text-sm text-muted-foreground">
                          Есть неизвестный автор
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {l.reaction.minutes === null ? "—" : opsNum(l.reaction.minutes) + " мин"}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <Empty cols={4} />
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function TasksTab({
  report,
  rows,
  filtered,
}: {
  report: OpsReport;
  rows: ReturnType<typeof opsRows>;
  filtered: boolean;
}) {
  const ts = opsTasks(report, rows, filtered);
  const unknown = ts.filter((t) => t.status.startsWith("unknown")).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Задач в выборке"
          value={ts.length}
          note="Изменённые / связанные с событиями"
        />
        <StatTile
          label="В срок"
          value={ts.filter((t) => t.status === "on_time").length}
          note="Есть время завершения и срок"
        />
        <StatTile
          label="Поздно / просрочены"
          value={ts.filter((t) => t.status === "late" || t.status === "overdue").length}
          note="В доступной истории"
        />
        <StatTile
          label="История неполная"
          value={unknown}
          note="Не оценены как выполненные в срок"
        />
      </div>
      <InfoNote variant="info">
        Задачи, изменённые в окне или связанные с событиями окна. Это ещё не полный список задач со
        сроком на день. Из {ts.length} задач {unknown} требуют уточнения истории.
      </InfoNote>
      <section className="space-y-2">
        <h3 className="text-base font-semibold">Задачи пилотной выборки</h3>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Ответственный</TableHead>
                <TableHead>Срок из снимка</TableHead>
                <TableHead>Завершение</TableHead>
                <TableHead>Состояние</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ts.length ? (
                ts.map((t, i) => (
                  <TableRow key={`${t.id}-${i}`}>
                    <TableCell>{t.id}</TableCell>
                    <TableCell>{t.responsible_user_id}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {opsStamp(t.current_deadline)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {t.completed_at ? opsStamp(t.completed_at) : "—"}
                    </TableCell>
                    <TableCell>
                      {OPS_TASK_LABELS[t.status]}
                      {t.moved_after_due && <span className="block">Перенос после срока</span>}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <Empty cols={5} />
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function SourcesTab({
  report,
  rows,
  lead,
}: {
  report: OpsReport;
  rows: ReturnType<typeof opsRows>;
  lead: (id: string) => ReactNode;
}) {
  const bs = opsSources(report, rows);
  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold">Закрытый неквал по выбранным основаниям</h3>
      <p className="text-sm text-muted-foreground">
        Состояние закрытия на момент загрузки, группа по созданию сделки. Не историческая конверсия
        на конец окна.
      </p>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Источник</TableHead>
              <TableHead className="text-right">Создано</TableHead>
              <TableHead>Неквал / доля</TableHead>
              <TableHead>Причины</TableHead>
              <TableHead>Сделки</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bs.length ? (
              bs.map((b) => (
                <TableRow key={b.source}>
                  <TableCell>{b.source}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.n}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {b.u} / {opsNum((b.u / b.n) * 100)}%
                  </TableCell>
                  <TableCell>
                    {b.r.length
                      ? b.r.map(([k, n]) => (
                          <span key={k} className="block">
                            {k}: {n}
                          </span>
                        ))
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {b.ids.length ? (
                      <span className="flex flex-wrap gap-x-2">{b.ids.map(lead)}</span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <Empty cols={5} />
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function CoverageTab({ report }: { report: OpsReport }) {
  const counts = Object.entries(report.event_counts);
  return (
    <section className="space-y-4 rounded-lg border bg-background p-4 text-sm">
      <h3 className="text-base font-semibold">Покрытие и ограничения</h3>
      <p>
        Запросов API: {report.request_count} · событий с неизвестным автором:{" "}
        {report.unknown_authors}
      </p>
      <p>Проверка в интерфейсе amoCRM ещё не выполнена.</p>
      <h3 className="text-base font-semibold">Что записывается в CRM</h3>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Что зафиксировано</TableHead>
              <TableHead className="text-right">Количество</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {counts.length ? (
              counts.map(([k, n]) => (
                <TableRow key={k}>
                  <TableCell>{OPS_EVENT_LABELS[k] || k}</TableCell>
                  <TableCell className="text-right tabular-nums">{n}</TableCell>
                </TableRow>
              ))
            ) : (
              <Empty cols={2} />
            )}
          </TableBody>
        </Table>
      </div>
      <p>События без однозначной связи со сделкой:</p>
      <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs whitespace-pre-wrap break-all">
        {JSON.stringify(report.unresolved, null, 2)}
      </pre>
      <p>Полученные типы событий:</p>
      <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs whitespace-pre-wrap break-all">
        {report.all_event_types.join("\n")}
      </pre>
      <ul className="list-disc space-y-1 pl-5">
        <li>История ответа внутри конкретного чата пока не собирается.</li>
        <li>Статус успешного разговора и пропущенные эпизоды пока не собираются.</li>
        <li>Автор по умолчанию неизвестен. Список human-users задаётся после сверки.</li>
        <li>Данные задач и закрытия могут быть изменены после конца выбранного окна.</li>
        <li>Нулевые результаты требуют проверки на известном непустом примере.</li>
      </ul>
    </section>
  );
}
