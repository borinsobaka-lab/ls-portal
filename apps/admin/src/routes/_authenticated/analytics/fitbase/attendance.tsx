import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbAttendanceBodySkeleton,
  AnalyticsFbAttendancePageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { mskToday } from "@/lib/analytics/core";
import { startFitbaseAttendanceRefresh } from "@/lib/analytics/fitbase.functions";
import {
  FB_ATT_LABELS,
  FB_ATT_METRICS,
  FB_ATT_TEXT,
  fbAttCells,
  fbAttDelta,
  fbAttendanceReport,
  fbAttGroup,
  fbAttNotReady,
  fbAttNumber,
  fbAttPartialNumber,
  fbAttRows,
  fbAttStudioValues,
  fbAttSummarize,
  type FbAttCell,
  type FbAttendanceReport,
  type FbAttRow,
  type FbAttView,
} from "@/lib/analytics/fitbase/attendance";
import {
  FB_KEY,
  fbAttendanceDataQuery,
  fbConnectionsQuery,
  type FbOverview,
} from "@/lib/analytics/fitbase/data";
import { fbDefaultPeriod, fbTimestamp } from "@/lib/analytics/fitbase/reports";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type AttendanceSearch = {
  from?: string;
  to?: string;
  city?: string;
  studio?: string;
  training?: string;
  status?: "active" | "archived";
  view?: "month" | "year";
};

export const Route = createFileRoute("/_authenticated/analytics/fitbase/attendance")({
  head: () => ({
    meta: [{ title: "Занятия и посещаемость FitBase — Аналитика — Lady Stretch" }],
  }),
  validateSearch: (s: Record<string, unknown>): AttendanceSearch => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 200) : undefined);
    return {
      from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
      to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
      city: str(s.city),
      studio: typeof s.studio === "string" && /^\d+$/.test(s.studio) ? s.studio : undefined,
      training: str(s.training),
      status: s.status === "active" || s.status === "archived" ? s.status : undefined,
      view: s.view === "month" || s.view === "year" ? s.view : undefined,
    };
  },
  pendingComponent: AnalyticsFbAttendancePageSkeleton,
  component: AnalyticsFbAttendancePage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = "all";
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const TONE = { up: "text-emerald-700", down: "text-destructive" };
const VIEWS: { value: FbAttView; label: string }[] = [
  { value: "current", label: "Текущее" },
  { value: "month", label: "К прошлому месяцу" },
  { value: "year", label: "К прошлому году" },
];

/**
 * «Аналитика» → «FitBase» → «Занятия и посещаемость» — их
 * fitbase_attendance_page с fitbase-attendance.js: проведённые занятия,
 * записи, посещения, средние и доходимость по городам, студиям и
 * направлениям, сравнение с теми же днями месяц и год назад, промежуточные
 * итоги по студиям с данными. Право «Занятия и посещаемость · FitBase» —
 * вся сеть; «Обновить данные», студии без данных и ссылки на интеграцию —
 * администратору.
 */
function AnalyticsFbAttendancePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const def = fbDefaultPeriod(mskToday());
  const from = search.from ?? def.from;
  const to = search.to ?? def.to;
  const city = search.city ?? "";
  const studio = search.studio ?? "";
  const training = search.training ?? "";
  const status = search.status ?? "";
  const view: FbAttView = search.view ?? "current";
  const filters = { from, to, city, studio, training, status };
  const { data, error, isPending, isFetching } = useQuery(fbAttendanceDataQuery(filters));
  const report = useMemo(() => (data ? fbAttendanceReport(data) : null), [data]);
  const admin = !!data?.admin;
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const set = (patch: Partial<AttendanceSearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });

  // «Обновить данные»: загрузка в фоне, их notice — пока студии отчёта заняты.
  const [notice, setNotice] = useState<{ kind: "queued" | "busy"; at: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const ids = useMemo(() => new Set(report?.connections.map((c) => c.id) ?? []), [report]);
  // Их опрос состояния (только администратору): при уведомлении — чаще, иначе
  // раз в 20 секунд, пока идёт загрузка; изменилось — отчёт перечитывается.
  const status_ = useQuery({
    ...fbConnectionsQuery,
    enabled: admin,
    refetchInterval: (q: { state: { data?: FbOverview } }) => {
      if (notice) return 4000;
      const d = q.state.data;
      return d && (d.batch?.active || d.connections.some((c) => c.busy)) ? 20000 : false;
    },
  });
  const signature = status_.data
    ? JSON.stringify([
        status_.data.batch?.active,
        status_.data.batch?.completed,
        status_.data.connections
          .filter((c) => ids.has(c.id))
          .map((c) => [c.id, c.busy, c.attendance_state]),
      ])
    : null;
  const idsKey = [...ids].join(",");
  const previous = useRef<{ ids: string; signature: string } | null>(null);
  useEffect(() => {
    if (signature === null) return;
    const prior = previous.current;
    if (prior && prior.ids === idsKey && prior.signature !== signature) {
      void qc.invalidateQueries({ queryKey: [...FB_KEY, "attendance"] });
    }
    previous.current = { ids: idsKey, signature };
  }, [signature, idsKey, qc]);
  // Уведомление снимается, когда свежий опрос (после запуска) не видит занятых студий отчёта.
  useEffect(() => {
    if (!notice || !status_.data || status_.dataUpdatedAt <= notice.at) return;
    if (!status_.data.connections.some((c) => ids.has(c.id) && c.busy)) {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: [...FB_KEY, "attendance"] });
    }
  }, [notice, status_.data, status_.dataUpdatedAt, ids, qc]);
  const refresh = async () => {
    setStarting(true);
    try {
      const r = await startFitbaseAttendanceRefresh({ data: { from, to, city, studio, status } });
      setNotice({ kind: r.busy ? "busy" : "queued", at: Date.now() });
      await qc.invalidateQueries({ queryKey: fbConnectionsQuery.queryKey });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const connections = data?.connections ?? [];
  const cities = [...new Set(connections.map((c) => c.city))].sort(codeSort);
  const directions = [
    ...new Set([...(report?.trainings ?? []), ...(training ? [training] : [])]),
  ].sort(codeSort);
  const filtered = !!(
    search.from ||
    search.to ||
    city ||
    studio ||
    training ||
    status ||
    search.view
  );

  return (
    <AdminShell
      title={AN_TITLES.fbAttendance}
      actions={
        admin ? (
          <Button onClick={() => void refresh()} disabled={starting || !!notice}>
            {starting || notice ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {starting ? "Загружаем…" : "Обновить данные"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Данные обновлены{" "}
          {report?.updated ? `${fbTimestamp(report.updated)} МСК` : "Ещё не загружены"}
        </p>
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период отчёта"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                set({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          <Select
            value={city || ALL}
            onValueChange={(v) => set({ city: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-44" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все города</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={studio || ALL}
            onValueChange={(v) => set({ studio: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Студия">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все студии</SelectItem>
              {connections.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={training || ALL}
            onValueChange={(v) => set({ training: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Направление">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все направления</SelectItem>
              {directions.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status || ALL}
            onValueChange={(v) =>
              set({ status: v === ALL ? undefined : (v as "active" | "archived") })
            }
          >
            <SelectTrigger className="w-44" aria-label="Статус студии">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все студии</SelectItem>
              <SelectItem value="active">Действующие</SelectItem>
              <SelectItem value="archived">Архивные</SelectItem>
            </SelectContent>
          </Select>
          <ToolbarReset
            active={filtered}
            onReset={() => {
              setDraft(undefined);
              void navigate({ search: {} });
            }}
          />
        </TableToolbar>
        {notice && <InfoNote variant="warning">{FB_ATT_TEXT[notice.kind]}</InfoNote>}
        {error ? (
          <InfoNote variant="warning">
            {(error as Error).message}{" "}
            <Link
              to="/analytics/fitbase/attendance"
              search={{}}
              className="underline underline-offset-2"
            >
              Вернуться к отчёту
            </Link>
          </InfoNote>
        ) : !report ? (
          <AnalyticsFbAttendanceBodySkeleton />
        ) : (
          <AttendanceBody
            r={report}
            admin={admin}
            view={view}
            onView={(v) => set({ view: v === "current" ? undefined : v })}
            dim={isFetching && !isPending}
          />
        )}
      </div>
    </AdminShell>
  );
}

/** Ссылка на интеграцию — администратору; сотруднику — только текст (их readonly). */
function AdminLink({ admin, id, children }: { admin: boolean; id?: number; children: ReactNode }) {
  if (!admin) return <>{children}</>;
  const cls = "underline underline-offset-2";
  return id === undefined ? (
    <Link to="/analytics/crm/fitbase" className={cls}>
      {children}
    </Link>
  ) : (
    <Link
      to="/analytics/crm/fitbase/$connectionId"
      params={{ connectionId: String(id) }}
      target="_blank"
      rel="noopener"
      className={cls}
    >
      {children}
    </Link>
  );
}

type PartialCell = { text: string; known: number } | null;

function AttendanceBody({
  r,
  admin,
  view,
  onView,
  dim,
}: {
  r: FbAttendanceReport;
  admin: boolean;
  view: FbAttView;
  onView: (v: FbAttView) => void;
  dim: boolean;
}) {
  const rows = useMemo(() => fbAttRows(r, admin), [r, admin]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const nodeOf = (row: FbAttRow) =>
    row.kind === "city" || row.kind === "pending-city"
      ? `c:${row.label}`
      : row.kind === "studio" || row.kind === "pending-studio"
        ? `s:${row.city}|${row.id}`
        : `t:${row.city}|${row.id}|${row.label}`;
  const parentOf = (row: FbAttRow) =>
    row.kind === "studio" || row.kind === "pending-studio"
      ? `c:${row.city}`
      : row.kind === "training"
        ? `s:${row.city}|${row.id}`
        : null;
  const visible = (row: FbAttRow) => {
    const parent = parentOf(row);
    if (!parent) return true;
    if (!open.has(parent)) return false;
    return row.kind !== "training" || open.has(`c:${row.city}`);
  };
  const toggle = (node: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(node)) {
        n.delete(node);
        // Свернули город — сворачиваются и его студии (их collapse).
        if (node.startsWith("c:")) {
          const city = node.slice(2);
          for (const k of [...n]) if (k.startsWith(`s:${city}|`)) n.delete(k);
        }
      } else n.add(node);
      return n;
    });

  // Их промежуточные итоги: суммы строк студий текущего периода с известными числами.
  const studioRows = rows.filter((row) => row.kind === "studio");
  const values = studioRows.map((row) => fbAttStudioValues(r, row.key));
  const totals = fbAttSummarize(values);
  const expected = r.connections.length;
  let partial = false;
  const cards = FB_ATT_METRICS.map((key, i) => {
    const available = r.metricCoverage.current[key];
    const shown = available ? fbAttNumber(r.total.current[key], key) : "—";
    const item = totals[i];
    if (shown === "—" && item.known) {
      partial = true;
      return {
        key,
        value: fbAttPartialNumber(item.value, i),
        note: `Учтено студий: ${item.known} из ${expected}`,
        delta: undefined,
      };
    }
    return {
      key,
      value: shown,
      note: available ? "к прошлому периоду" : undefined,
      delta: available ? (fbAttDelta(r, key) ?? null) : undefined,
    };
  });
  const fill = (cells: FbAttCell[], sums: ReturnType<typeof fbAttSummarize>): PartialCell[] =>
    cells.map((cell, i) => {
      const item = sums[i];
      if (view !== "current" || cell.text !== "—" || !item.known) return null;
      partial = true;
      return {
        text: fbAttPartialNumber(item.value, i) + (item.value !== null ? " *" : ""),
        known: item.known,
      };
    });
  const cityPartial = new Map<string, PartialCell[]>();
  for (const row of rows) {
    if (row.kind !== "city") continue;
    const g = fbAttGroup(r, row.key)!;
    const own = studioRows
      .map((s, i) => [s, values[i]] as const)
      .filter(([s]) => s.kind === "studio" && s.city === row.label)
      .map(([, v]) => v);
    cityPartial.set(row.label, fill(fbAttCells(g.metrics, g.coverage, view), fbAttSummarize(own)));
  }
  const totalCells = r.groups.size ? fbAttCells(r.total, r.metricCoverage, view) : null;
  const totalPartial = totalCells ? fill(totalCells, totals) : null;

  const notReady = fbAttNotReady(r);
  const failed =
    !notReady && r.connections.some((c) => !c.attendance_state.startsWith("Занятия загружены"));

  return (
    <div className={cn("space-y-4", dim && "opacity-60 transition-opacity")}>
      {notReady && (
        <InfoNote variant="warning">
          {notReady.reason}{" "}
          {notReady.affected.length ? (
            notReady.affected.map((c, i) => (
              <Fragment key={c.id}>
                {i > 0 && " · "}
                <AdminLink admin={admin} id={c.id}>
                  {c.name}
                </AdminLink>
              </Fragment>
            ))
          ) : (
            <AdminLink admin={admin}>К интеграции</AdminLink>
          )}
        </InfoNote>
      )}
      {failed && (
        <InfoNote variant="warning">
          {FB_ATT_TEXT.failed} <AdminLink admin={admin}>Проверить состояние</AdminLink>
        </InfoNote>
      )}
      {partial && <InfoNote>{FB_ATT_TEXT.partial}</InfoNote>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <article
            key={c.key}
            className="flex min-w-0 flex-col gap-1 rounded-lg border bg-background p-4"
          >
            <p className="truncate text-xs font-medium text-muted-foreground">
              {FB_ATT_LABELS[c.key]}
            </p>
            <p className="truncate text-2xl font-semibold tabular-nums">{c.value}</p>
            {c.delta !== undefined && (
              <p
                className={cn(
                  "text-sm font-medium tabular-nums",
                  c.delta ? TONE[c.delta.up ? "up" : "down"] : "text-muted-foreground",
                )}
              >
                {c.delta ? c.delta.text : "—"}
              </p>
            )}
            {c.note && <p className="text-xs text-muted-foreground">{c.note}</p>}
          </article>
        ))}
      </div>
      <section className="rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Занятия по городам, студиям и направлениям</h2>
            <p className="text-xs text-muted-foreground">
              Детализация показателей по городам, студиям и направлениям
            </p>
          </div>
          <SegmentedControl aria-label="Сравнение" value={view} onChange={onView} options={VIEWS} />
        </div>
        <Table mobileCards={false}>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64">Город / студия / направление</TableHead>
              {[
                "Проведено",
                "Записано",
                "Посетило",
                "Среднее записано на занятие",
                "Среднее посетило на занятие",
                "Доходимость",
              ].map((h) => (
                <TableHead key={h} className="text-right">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.filter(visible).map((row) => {
              const node = nodeOf(row);
              const expandable = row.kind !== "training" && row.kind !== "pending-studio";
              const isOpen = open.has(node);
              const g = "key" in row ? fbAttGroup(r, row.key) : undefined;
              const cells = g ? fbAttCells(g.metrics, g.coverage, view) : null;
              return (
                <TableRow
                  key={`${row.kind}:${node}`}
                  className={cn(
                    (row.kind === "city" || row.kind === "pending-city") && "font-medium",
                    row.kind !== "city" && row.kind !== "pending-city" && "text-muted-foreground",
                  )}
                >
                  <TableCell
                    className={cn(
                      (row.kind === "studio" || row.kind === "pending-studio") && "pl-12",
                      row.kind === "training" && "pl-20",
                    )}
                  >
                    {expandable && (
                      <button
                        type="button"
                        className="mr-2 inline-flex size-6 items-center justify-center rounded-full border align-middle"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Свернуть" : "Раскрыть"} ${
                          row.kind === "city" || row.kind === "pending-city" ? "город" : "студию"
                        } ${row.label}`}
                        onClick={() => toggle(node)}
                      >
                        {isOpen ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
                      </button>
                    )}
                    {row.label}
                    {row.kind === "pending-studio" && (
                      <span className="block text-xs">{row.status}</span>
                    )}
                  </TableCell>
                  {cells ? (
                    <Cells
                      cells={cells}
                      partial={row.kind === "city" ? cityPartial.get(row.label) : undefined}
                    />
                  ) : (
                    FB_ATT_METRICS.map((m) => (
                      <TableCell key={m} className="text-right">
                        —
                      </TableCell>
                    ))
                  )}
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                  {r.ready
                    ? "За выбранный период завершённых занятий нет."
                    : "Загрузите данные занятий для выбранного периода."}
                </TableCell>
              </TableRow>
            )}
            {totalCells && (
              <TableRow className="bg-muted/30 font-semibold">
                <TableCell>Итого</TableCell>
                <Cells cells={totalCells} partial={totalPartial ?? undefined} />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <details className="rounded-lg border bg-background p-4 text-sm">
        <summary className="cursor-pointer font-medium select-none">
          Как считаются показатели
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          {FB_ATT_TEXT.rules.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      </details>
    </div>
  );
}

/** Ячейки строки: значения или изменение; промежуточный итог — «*» и подсказка. */
function Cells({ cells, partial }: { cells: FbAttCell[]; partial?: PartialCell[] }) {
  return (
    <>
      {cells.map((cell, i) => {
        const p = partial?.[i];
        return (
          <TableCell
            key={FB_ATT_METRICS[i]}
            className={cn(
              "text-right whitespace-nowrap tabular-nums",
              cell.tone && !p && TONE[cell.tone],
            )}
            title={p ? `Учтено студий: ${p.known}. Доступная часть выбранной группы.` : undefined}
          >
            {p ? p.text : cell.text}
          </TableCell>
        );
      })}
    </>
  );
}
