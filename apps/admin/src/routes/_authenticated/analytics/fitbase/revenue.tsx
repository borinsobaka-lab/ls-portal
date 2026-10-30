import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import {
  AnalyticsFbRevenueBodySkeleton,
  AnalyticsFbRevenuePageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { startFitbaseRevenueRefresh } from "@/lib/analytics/fitbase.functions";
import {
  fbConnectionsQuery,
  fbRevenueDataQuery,
  invalidateFitbase,
} from "@/lib/analytics/fitbase/data";
import {
  fbDots,
  fbMonthName,
  fbRevenueMoney,
  fbRevenueNotes,
  fbRevenueReport,
  fbRevenueToday,
  fbRevenueZero,
  fbTimestamp,
  type FbCoverage,
  type FbRevenueRow,
} from "@/lib/analytics/fitbase/reports";
import { fbRevenuePeriod } from "@/lib/analytics/fitbase/rules";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

type RevenueSearch = { offset?: number; q?: string; status?: "active" | "archived" };

export const Route = createFileRoute("/_authenticated/analytics/fitbase/revenue")({
  head: () => ({ meta: [{ title: "Выручка по городам FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): RevenueSearch => {
    const offset = Number(s.offset);
    return {
      offset: Number.isInteger(offset) && offset > 0 && offset <= 60 ? offset : undefined,
      q: typeof s.q === "string" && s.q.trim() ? s.q.slice(0, 200) : undefined,
      status: s.status === "active" || s.status === "archived" ? s.status : undefined,
    };
  },
  pendingComponent: AnalyticsFbRevenuePageSkeleton,
  component: AnalyticsFbRevenuePage,
});

const TIPS = {
  current: "Оплаты минус возвраты с 1-го числа по вчерашний день включительно.",
  forecast: "Факт месяца / прошедшие дни месяца × число дней месяца.",
};

/** Их «Как считается выручка» (fitbase_revenue_page). */
const RULES = [
  "Все фактически оплаченные операции FitBase по полю amount минус возвраты по дате pay_date. Суммы договоров, бонусы priceBonus и расчёты с депозита priceDeposit отдельно не прибавляются. Суммы — до комиссии эквайринга. Сегодняшние операции исключены и при загрузке, и при расчёте. Даты и граница дня — самарское время (UTC+4).",
  "Прогноз = факт месяца по вчера включительно / прошедшие дни месяца × число дней месяца. В первый день месяца прогноз не выводится. Итоги суммируют доступные данные студий. Неполные суммы отмечены звёздочкой; отсутствующие значения не считаются нулём. Если данных нет ни у одной студии, показан прочерк. Прогноз при неполноте относится только к учтённым студиям. Открытая/закрытая студия — текущий статус в настройках интеграции FitBase. Выручка обновляется ежедневно в 01:00 МСК; вход в раздел не запускает загрузку.",
];

/**
 * «Аналитика» → «FitBase» → «Выручка по городам» — их fitbase_revenue_page:
 * факт текущего месяца по неделям, прогноз и шесть прошлых месяцев по
 * городам и студиям (Самара, по вчера). Право «Выручка · FitBase» — вся
 * сеть; «Обновить выручку» и ссылки на интеграцию — администратору.
 */
function AnalyticsFbRevenuePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const offset = search.offset ?? 0;
  const q = search.q ?? "";
  const status = search.status ?? "";
  const today = fbRevenueToday();
  const period = fbRevenuePeriod(offset, today);
  const { data, error, isPending, isFetching } = useQuery(
    fbRevenueDataQuery(period.fromDate, period.cutoff),
  );
  const report = useMemo(
    () => (data ? fbRevenueReport(data, { offset, search: q, status, today }) : null),
    [data, offset, q, status, today],
  );
  const admin = !!data?.admin;
  const [text, setText] = useState(q);
  const debounced = useDebouncedValue(text, 400);
  useEffect(() => {
    if (debounced.trim() !== q) {
      void navigate({ search: (s) => ({ ...s, q: debounced.trim() || undefined }) });
    }
  }, [debounced, q, navigate]);

  const [openCities, setOpenCities] = useState<Set<string>>(new Set());
  const [hideWeeks, setHideWeeks] = useState(false);
  const [hideZeros, setHideZeros] = useState(false);

  // «Обновить выручку»: загрузка в фоне, страница обновится после неё (их notice).
  const [watching, setWatching] = useState<number[] | null>(null);
  const [starting, setStarting] = useState(false);
  const status_ = useQuery({ ...fbConnectionsQuery, enabled: admin && !!watching });
  useEffect(() => {
    if (!watching || !status_.data) return;
    const busy = status_.data.connections.some((c) => watching.includes(c.id) && c.busy);
    if (!busy) {
      setWatching(null);
      void invalidateFitbase(qc);
    }
  }, [watching, status_.data, qc]);
  const refresh = async () => {
    setStarting(true);
    try {
      const r = await startFitbaseRevenueRefresh({ data: { offset, search: q, status } });
      setWatching(r.ids);
      await qc.invalidateQueries({ queryKey: fbConnectionsQuery.queryKey });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const days = period.days;
  const weekLabels = ["1–4", "5–11", "12–18", "19–25", `26–${days}`];
  const monthLabel = `${fbMonthName(period.first)} ${period.first.slice(0, 4)}`;
  const kpis: [string, string, string][] = report
    ? [
        [
          "Факт текущего месяца",
          fbRevenueMoney(report.total.current),
          "по вчерашний день включительно",
        ],
        ["Прогноз месяца", fbRevenueMoney(report.total.forecast), "по среднему за прошедшие дни"],
        [
          "Факт открытые",
          report.connections.length ? fbRevenueMoney(report.opened.current) : "—",
          "действующие студии",
        ],
        [
          "Факт закрытые",
          report.connections.length ? fbRevenueMoney(report.closed.current) : "—",
          "архивные студии",
        ],
        ["Городов", String(report.cities.length), "в отчёте"],
        [
          "Студий всего",
          `${report.connections.length} / открытых ${report.connections.filter((c) => c.studio_status === "active").length}`,
          "по подключённым студиям",
        ],
      ]
    : [];
  const notes = report ? fbRevenueNotes(report, !!watching) : [];
  const go = (o: number) => void navigate({ search: (s) => ({ ...s, offset: o || undefined }) });

  return (
    <AdminShell
      title={AN_TITLES.fbRevenue}
      actions={
        admin ? (
          <Button onClick={() => void refresh()} disabled={starting || !!watching}>
            {starting || watching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {starting || watching ? "Загружаем…" : "Обновить выручку"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Данные обновлены{" "}
          {report?.updated
            ? fbTimestamp(report.updated, "Europe/Samara", true)
            : "ещё не загружены"}
          {" · "}Оплаты и возвраты по {fbDots(period.cutoff)} включительно
        </p>
        <TableToolbar>
          <ToolbarSearch value={text} onChange={setText} placeholder="Поиск города или студии" />
          <Select
            value={status || "all"}
            onValueChange={(v) =>
              void navigate({
                search: (s) => ({
                  ...s,
                  status: v === "all" ? undefined : (v as "active" | "archived"),
                }),
              })
            }
          >
            <SelectTrigger className="w-48" aria-label="Статус студии">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все студии</SelectItem>
              <SelectItem value="active">Открытые студии</SelectItem>
              <SelectItem value="archived">Закрытые студии</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => go(Math.max(0, offset - 6))} disabled={!offset}>
            <ArrowLeft />К более свежим
          </Button>
          <Button variant="outline" onClick={() => go(offset + 6)} disabled={offset >= 60}>
            К более ранним
            <ArrowRight />
          </Button>
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !report ? (
          <AnalyticsFbRevenueBodySkeleton />
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              {kpis.map(([label, value, note]) => (
                <StatTile key={label} label={label} value={value} note={note} />
              ))}
            </div>
            {notes.map((n, i) => (
              <InfoNote key={i} variant="warning">
                {n.text}{" "}
                {n.link &&
                  (admin ? (
                    <Link to="/analytics/crm/fitbase" className="underline underline-offset-2">
                      {n.link}
                    </Link>
                  ) : (
                    n.link
                  ))}
              </InfoNote>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpenCities(new Set(report.cities.map(([c]) => c)))}
              >
                Раскрыть все
              </Button>
              <Button variant="outline" size="sm" onClick={() => setOpenCities(new Set())}>
                Свернуть все
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-pressed={hideWeeks}
                onClick={() => setHideWeeks((v) => !v)}
              >
                {hideWeeks ? "Развернуть текущий месяц" : "Свернуть текущий месяц"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-pressed={hideZeros}
                onClick={() => setHideZeros((v) => !v)}
              >
                {hideZeros ? "Показать точки 0" : "Скрыть точки 0"}
              </Button>
            </div>
            <section className="rounded-lg border bg-background">
              <Table mobileCards={false}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-56">Город / студия</TableHead>
                    {!hideWeeks &&
                      weekLabels.map((w) => (
                        <TableHead key={w} className="text-right">
                          {w}
                        </TableHead>
                      ))}
                    <TableHead className="bg-muted/50 text-right" tip={TIPS.current}>
                      Итого месяца
                      <span className="block text-xs font-normal">{monthLabel}</span>
                    </TableHead>
                    <TableHead className="bg-muted/50 text-right" tip={TIPS.forecast}>
                      Прогноз
                      <span className="block text-xs font-normal">месяца</span>
                    </TableHead>
                    {period.history.map((m) => (
                      <TableHead key={m} className="text-right">
                        {fbMonthName(m)}
                        <span className="block text-xs font-normal">{m.slice(0, 4)}</span>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell>Итого по сети</TableCell>
                    <Cells row={report.total} hideWeeks={hideWeeks} />
                  </TableRow>
                  {report.cities.map(([city, metrics]) => {
                    const studios = report.connections
                      .filter((c) => c.city === city)
                      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
                    const cityZero = studios.every((c) => fbRevenueZero(report.studios[c.id]));
                    if (hideZeros && cityZero) return null;
                    const open = openCities.has(city);
                    return (
                      <Fragment key={city}>
                        <TableRow className="font-medium">
                          <TableCell>
                            <button
                              type="button"
                              className="mr-2 inline-flex size-6 items-center justify-center rounded-full border align-middle"
                              aria-expanded={open}
                              aria-label={`${open ? "Свернуть" : "Раскрыть"} ${city}`}
                              onClick={() =>
                                setOpenCities((s) => {
                                  const n = new Set(s);
                                  if (n.has(city)) n.delete(city);
                                  else n.add(city);
                                  return n;
                                })
                              }
                            >
                              {open ? (
                                <Minus className="size-3.5" />
                              ) : (
                                <Plus className="size-3.5" />
                              )}
                            </button>
                            {city}
                          </TableCell>
                          <Cells row={metrics} hideWeeks={hideWeeks} />
                        </TableRow>
                        {open &&
                          studios
                            .filter((c) => !(hideZeros && fbRevenueZero(report.studios[c.id])))
                            .map((c) => (
                              <TableRow key={c.id} className="text-muted-foreground">
                                <TableCell className="pl-12">
                                  {c.name}{" "}
                                  {c.studio_status === "archived" && (
                                    <StatusChip tone="neutral">закрыта</StatusChip>
                                  )}
                                </TableCell>
                                <Cells row={report.studios[c.id]} hideWeeks={hideWeeks} />
                              </TableRow>
                            ))}
                      </Fragment>
                    );
                  })}
                  {!report.connections.length && (
                    <TableRow>
                      <TableCell colSpan={14} className="py-6 text-center text-muted-foreground">
                        Нет подключённых студий для выбранных фильтров.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </section>
            <details className="rounded-lg border bg-background p-4 text-sm">
              <summary className="cursor-pointer font-medium select-none">
                Как считается выручка
              </summary>
              <div className="mt-2 space-y-2 text-muted-foreground">
                {RULES.map((r) => (
                  <p key={r}>{r}</p>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

/** Ячейки строки: недели, итог, прогноз, месяцы; неполные — «*» и подсказка. */
function Cells({ row, hideWeeks }: { row: FbRevenueRow; hideWeeks: boolean }) {
  const cov = row.coverage;
  const cell = (value: number | null, k: FbCoverage | undefined, key: string, accent = false) => {
    const partial = !!k && k.known < k.expected;
    return (
      <TableCell
        key={key}
        className={cn("text-right whitespace-nowrap tabular-nums", accent && "bg-muted/50")}
        title={partial ? `Учтено студий: ${k.known} из ${k.expected}. Неполные данные.` : undefined}
      >
        {fbRevenueMoney(value)}
        {partial && value !== null && <span aria-label="Неполные данные"> *</span>}
      </TableCell>
    );
  };
  return (
    <>
      {!hideWeeks && row.weeks.map((v, i) => cell(v, cov?.weeks[i], `w${i}`))}
      {cell(row.current, cov?.current, "current", true)}
      {cell(row.forecast, cov?.current, "forecast", true)}
      {row.months.map((v, i) => cell(v, cov?.months[i], `m${i}`))}
    </>
  );
}
