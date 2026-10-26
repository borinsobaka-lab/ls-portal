import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { min } from "date-fns";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChartArea,
  ChartColumn,
  ChartLine,
  Minus,
} from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint } from "@/components/ui/field-hint";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChartType } from "@/components/metric-chart-plot";
import { DashboardStatsSkeleton } from "@/components/page-skeletons";
import { useIsMobile } from "@/hooks/use-mobile";
import { toISO, type Period, type SeriesDef } from "@/lib/dashboard-data";
import { detailRows, type DetailRow, type DetailsSpec } from "@/lib/dashboard-details";
import { aggregate, buildBuckets, seriesTotal, type Granularity } from "@/lib/dashboard-series";
import { formatStat, type StatFormat, type StatInfo } from "@/lib/dashboard-stats";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Плитки показателей дашборда: подпись с «?» (что значит показатель),
 * значение и пометка «за период» / «сейчас» справа от него, ниже — сравнение
 * с предыдущим периодом. Плитка с графиком открывает окно с разбивкой по
 * месяцам / неделям / дням; у графика с подробным отчётом (SeriesDef.details)
 * окно шире — график слева, справа список клиентов, продаж, абонементов за
 * период (нажатие на столбец — за него). «Сейчас»-плитка со списком (list)
 * открывает только список.
 */

/** Выбранные клубы и период: по ним грузится график, их название — в окне. */
type ChartTarget = {
  clubIds: string[];
  scope: string;
  name: string;
  color: string;
  /** Период дашборда — за него список справа от графика. */
  period: Period | null;
};

/**
 * Подробный отчёт плитки без графика: строки грузит `load` при открытии
 * окна или страница отдаёт уже посчитанные (`rows`; undefined — ещё грузятся).
 */
export type StatList = {
  details: DetailsSpec;
  /** Подзаголовок окна после клубов; по умолчанию «на сегодня». */
  description?: string;
} & (
  | { load: (studioIds: string[]) => Promise<DetailRow[]>; rows?: never }
  | { rows: DetailRow[] | undefined; load?: never }
);

/** Плитка: подпись, подсказка и вид значения (lib/dashboard-stats.ts) и график в окне. */
export type StatDef<K extends string = string> = StatInfo<K> & {
  /** График в окне плитки; без него и без списка плитка не нажимается. */
  series?: SeriesDef;
  /** Только список (у «сейчас»-плиток истории для графика нет). */
  list?: StatList;
};

// Список с карточкой клиента (формы, libphonenumber-js) — отдельным чанком,
// как и график: дашборд открывается первым после входа.
const DetailsPanel = lazy(() => import("@/components/dashboard/details-panel"));

/** Единица разницы в пунктах — у долей и индексов. */
const POINTS: Partial<Record<StatFormat, string>> = { percent: " п. п.", score: " п." };
const pointsFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function Delta({
  current,
  previous,
  goodWhenUp,
  format,
}: {
  current: number;
  previous: number;
  goodWhenUp: boolean;
  format: StatFormat;
}) {
  if (previous === 0 && current === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" /> без изменений
      </span>
    );
  }
  const diff = current - previous;
  const pct = previous === 0 ? null : (diff / Math.abs(previous)) * 100;
  const up = diff > 0;
  const flat = diff === 0;
  const good = flat ? null : up === goodWhenUp;
  const color = flat ? "text-muted-foreground" : good ? "text-emerald-700" : "text-rose-600";
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  const sign = flat ? "" : up ? "+" : "−";
  // Доли и индексы сравниваем разницей в пунктах: «+50% · 5%» у
  // заполняемости 10% → 15% не читается.
  const points = POINTS[format];
  const diffText = formatStat(format, Math.abs(diff));
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1 text-xs", color)}>
      <Icon className="h-3 w-3" />
      {points !== undefined
        ? `${sign}${pointsFormat.format(Math.abs(diff))}${points}`
        : pct === null
          ? diffText
          : `${sign}${Math.abs(pct).toFixed(0)}% · ${diffText}`}
      <span className="text-muted-foreground max-sm:hidden">к пред. периоду</span>
    </span>
  );
}

export function StatGrid<K extends string>({
  target,
  stats,
  current,
  previous,
  loading,
  periodEnd,
  className,
}: {
  /** Чьи показатели: выбранные клубы (DashboardView) — для окна графика. */
  target: ChartTarget;
  stats: StatDef<K>[];
  current: Partial<Record<K, number>>;
  previous: Partial<Record<K, number>>;
  loading: boolean;
  /** Конец выбранного периода — им заканчивается график в окне плитки. */
  periodEnd: Date;
  /** Сетка плиток — классы колонок под число показателей раздела. */
  className: string;
}) {
  // Показатель держим и после закрытия: иначе окно пустеет, пока гаснет.
  // Храним ключ, а не саму плитку: страница пересчитывает её график и список,
  // когда догружаются данные, — окно должно показывать свежие.
  const [chartKey, setChartKey] = useState<K | null>(null);
  const chartStat = stats.find((s) => s.key === chartKey) ?? null;
  const [chartOpen, setChartOpen] = useState(false);

  if (loading)
    return <DashboardStatsSkeleton labels={stats.map((s) => s.label)} className={className} />;

  return (
    <>
      {/* На телефоне — две плитки в ряд: по одной в столбик показатели
          растягивались на несколько экранов. */}
      <div className={cn("grid grid-cols-2 gap-2 sm:gap-3", className)}>
        {stats.map((stat) => {
          const v = current[stat.key];
          const p = previous[stat.key];
          return (
            <StatCard
              key={stat.key}
              stat={stat}
              value={v === undefined ? "—" : formatStat(stat.format, v)}
              delta={
                stat.compare && v !== undefined && p !== undefined ? (
                  <Delta
                    current={v}
                    previous={p}
                    goodWhenUp={stat.goodWhenUp}
                    format={stat.format}
                  />
                ) : null
              }
              onOpenChart={
                stat.series || stat.list
                  ? () => {
                      setChartKey(stat.key);
                      setChartOpen(true);
                    }
                  : undefined
              }
            />
          );
        })}
      </div>

      <Dialog open={chartOpen} onOpenChange={setChartOpen}>
        <DialogContent
          className={
            chartStat?.series?.details
              ? "sm:max-w-7xl"
              : chartStat?.series
                ? "sm:max-w-5xl"
                : "sm:max-w-2xl"
          }
        >
          {chartStat?.series ? (
            <MetricChart
              key={chartStat.key}
              target={target}
              stat={chartStat}
              def={chartStat.series}
              periodEnd={periodEnd}
            />
          ) : (
            chartStat?.list && (
              <MetricList
                key={chartStat.key}
                target={target}
                stat={chartStat}
                list={chartStat.list}
              />
            )
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatCard({
  stat,
  value,
  delta,
  onOpenChart,
}: {
  stat: StatDef;
  value: string;
  delta: ReactNode;
  onOpenChart?: () => void;
}) {
  const chartable = !!onOpenChart;
  return (
    <div
      className={cn(
        // Подпись, число и сравнение — строки общей сетки плиток (subgrid):
        // число у всех плиток ряда на одной высоте, даже если чья-то подпись
        // заняла две строки.
        "relative row-span-3 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3",
        chartable &&
          "group transition-colors hover:border-foreground/20 has-[button[data-card]:focus-visible]:ring-2 has-[button[data-card]:focus-visible]:ring-ring",
      )}
    >
      {/* Вся плитка — кнопка графика, но «?» внутри неё нельзя (кнопка в
          кнопке): кнопка растянута под содержимым, «?» лежит над ней. */}
      {chartable && (
        <button
          type="button"
          data-card
          onClick={onOpenChart}
          className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-none"
        >
          <span className="sr-only">
            {stat.label} — {stat.series ? "открыть график" : "открыть список"}
          </span>
        </button>
      )}
      {chartable && (
        <ArrowUpRight
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted-foreground transition-[color,transform] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground sm:right-3 sm:top-3"
        />
      )}
      <span
        className={cn(
          "pointer-events-none block text-xs font-medium text-muted-foreground sm:text-sm",
          chartable && "pr-5",
        )}
      >
        <LabelWithHint label={stat.label}>
          <FieldHint className="pointer-events-auto relative z-10 ml-1 align-[-2px]">
            {stat.tip}
          </FieldHint>
        </LabelWithHint>
      </span>
      <span className="pointer-events-none flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-lg font-semibold tabular-nums sm:text-xl">{value}</span>
        {stat.hint && <span className="text-xs text-muted-foreground">{stat.hint}</span>}
      </span>
      {delta ? <span className="pointer-events-none block">{delta}</span> : <span />}
    </div>
  );
}

/**
 * «?» — вместе с последним словом подписи: иначе на узкой плитке он один
 * уезжал на следующую строку («Средний чек за услуги» / «?»).
 */
function LabelWithHint({ label, children }: { label: string; children: ReactNode }) {
  const cut = label.lastIndexOf(" ");
  return (
    <>
      {cut > 0 && `${label.slice(0, cut)} `}
      <span className="whitespace-nowrap">
        {label.slice(cut + 1)}
        {children}
      </span>
    </>
  );
}

/** Знаменатель среднего по умолчанию — продажи (средний чек). */
const SALES_BASE = { label: "Продаж", empty: "нет продаж" };

const GRANULARITIES: {
  value: Granularity;
  label: string;
  span: string;
  unit: string;
  /** Подсказка под графиком с отчётом: «Список за отдельный месяц — …». */
  pick: string;
}[] = [
  {
    value: "month",
    label: "По месяцам",
    span: "12 месяцев",
    unit: "месяц",
    pick: "отдельный месяц — нажмите на него",
  },
  {
    value: "week",
    label: "По неделям",
    span: "12 недель",
    unit: "неделю",
    pick: "отдельную неделю — нажмите на неё",
  },
  {
    value: "day",
    label: "По дням",
    span: "30 дней",
    unit: "день",
    pick: "отдельный день — нажмите на него",
  },
];

// График (recharts, ~100 kB gzip) — отдельным чанком: дашборд открывается
// первым после входа, а окно с графиком нужно не каждый раз.
const MetricChartPlot = lazy(() =>
  import("@/components/metric-chart-plot").then((m) => ({ default: m.MetricChartPlot })),
);

const CHART_TYPES: { value: ChartType; label: string; icon: typeof ChartColumn }[] = [
  { value: "bar", label: "Столбцы", icon: ChartColumn },
  { value: "line", label: "Линия", icon: ChartLine },
  { value: "area", label: "Область", icon: ChartArea },
];

/**
 * Окно графика показателя: разбивка (табы) и вид графика. Окно графика
 * заканчивается периодом, выбранным на дашборде (см. SeriesDef.future).
 */
function MetricChart({
  target,
  stat,
  def,
  periodEnd,
}: {
  target: ChartTarget;
  stat: StatDef;
  def: SeriesDef;
  periodEnd: Date;
}) {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [chartType, setChartType] = useState<ChartType>("bar");
  // Нажатый столбец — список справа за него; ещё раз — снова за период.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const details = def.details;

  const anchor = def.future ? periodEnd : min([periodEnd, new Date()]);
  const anchorISO = toISO(anchor);
  const buckets = useMemo(
    () => buildBuckets(granularity, new Date(`${anchorISO}T00:00:00`)),
    [granularity, anchorISO],
  );
  const period = target.period;
  // Список — за период дашборда: если тот начинается раньше графика (длинный
  // период и разбивка по дням), строки грузим и за него.
  const from = details && period && period.from < buckets[0].from ? period.from : buckets[0].from;
  const to = buckets[buckets.length - 1].to;

  const query = useQuery({
    queryKey: ["dashboard", target.scope, "series", stat.key, granularity, from, to],
    queryFn: async () => {
      const points = await def.load(target.clubIds, from, to);
      return {
        values: aggregate(granularity, buckets, points, def.kind),
        rows: details ? points.flatMap((p) => (p.row ? [p.row] : [])) : [],
      };
    },
    // Пока грузится другая разбивка — прежний график, а не пустое место.
    placeholderData: keepPreviousData,
    meta: { errorMessage: `${target.name}: не удалось загрузить график «${stat.label}»` },
  });

  const values = query.data?.values;
  const selectedIndex = values?.findIndex((v) => v.bucket.key === selectedKey) ?? -1;
  const selected = selectedIndex >= 0 && !query.isPlaceholderData ? values![selectedIndex] : null;
  const listRange = selected
    ? { from: selected.bucket.from, to: selected.bucket.to }
    : (period ?? { from: buckets[0].from, to });
  const { from: listFrom, to: listTo } = listRange;
  const rows = useMemo(
    () =>
      details && query.data && !query.isPlaceholderData
        ? detailRows(query.data.rows, details, { from: listFrom, to: listTo })
        : undefined,
    [details, query.data, query.isPlaceholderData, listFrom, listTo],
  );
  const g = GRANULARITIES.find((x) => x.value === granularity)!;
  const fmt = (n: number) => formatStat(stat.format, n);
  const color = target.color;
  const base = def.base ?? SALES_BASE;

  const data = (values ?? []).map((v) => ({
    tick: v.bucket.tick,
    label: v.bucket.label,
    value: v.value,
    n: v.n,
  }));
  const filled = (values ?? []).filter((v) => v.value !== null && v.value !== 0);
  const total = values ? seriesTotal(def.kind, values) : null;
  const best = filled.reduce<(typeof filled)[number] | null>(
    (b, v) => (b === null || v.value! > b.value! ? v : b),
    null,
  );

  const summary = [
    {
      label: def.kind === "avg" ? `Средний за ${g.span}` : `Итого за ${g.span}`,
      value: total === null ? "—" : fmt(total),
    },
    def.kind === "avg"
      ? {
          label: `${base.label} за ${g.span}`,
          value: formatNumber((values ?? []).reduce((s, v) => s + v.n, 0)),
        }
      : {
          label: `В среднем за ${g.unit}`,
          // Штуки в среднем — целым числом: «1 196,833 посещения» не читается.
          value:
            total === null
              ? "—"
              : fmt(
                  def.kind === "count"
                    ? Math.round(total / buckets.length)
                    : total / buckets.length,
                ),
        },
    {
      label: "Максимум",
      value: best ? fmt(best.value!) : "—",
      note: best?.bucket.label,
    },
  ];

  const chart = (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label="Разбивка"
          value={granularity}
          onChange={(g) => {
            setGranularity(g);
            setSelectedKey(null);
          }}
          options={GRANULARITIES}
        />
        <SegmentedControl
          aria-label="Вид графика"
          iconOnly
          value={chartType}
          onChange={setChartType}
          options={CHART_TYPES}
        />
      </div>

      {/* На телефоне итоги — строками «подпись · значение»: в трети ширины
          суммы вида «18 222 313 GEL» обрезались. */}
      <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        {summary.map((s) => (
          <div
            key={s.label}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border px-3 py-2 sm:grid-cols-1 sm:content-start sm:p-3"
          >
            <div className="text-xs text-muted-foreground">{s.label}</div>
            {values ? (
              <div className="whitespace-nowrap text-sm font-semibold tabular-nums max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1 sm:mt-1 sm:truncate sm:text-lg">
                {s.value}
              </div>
            ) : (
              <Skeleton className="h-6 w-20 max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1 sm:mt-1.5" />
            )}
            {s.note && (
              <div className="truncate text-xs text-muted-foreground first-letter:uppercase">
                {s.note}
              </div>
            )}
          </div>
        ))}
      </div>

      <div
        className={cn("relative transition-opacity", query.isPlaceholderData && "opacity-50")}
        style={{ height: isMobile ? 260 : 340 }}
      >
        {!values ? (
          query.isError ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Не удалось загрузить график
            </div>
          ) : (
            <Skeleton className="h-full w-full" />
          )
        ) : filled.length === 0 && !query.isPlaceholderData ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Нет данных за {g.span}
          </div>
        ) : (
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <MetricChartPlot
              data={data}
              chartType={chartType}
              color={color}
              dots={granularity !== "day"}
              format={fmt}
              showDeals={def.kind === "avg"}
              base={base}
              selected={selected ? selectedIndex : null}
              onSelect={
                details
                  ? (i) => {
                      const key = values[i]?.bucket.key ?? null;
                      setSelectedKey((prev) => (prev === key ? null : key));
                    }
                  : undefined
              }
            />
          </Suspense>
        )}
      </div>
      {details && <p className="text-xs text-muted-foreground">Список за {g.pick} на графике.</p>}
    </div>
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{stat.label}</DialogTitle>
        <DialogDescription>
          {target.name} · {def.description}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {details ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            {chart}
            {/* Высоту строки задаёт график, список прокручивается внутри
                (на широком экране — absolute в details-panel). */}
            <div className="relative min-h-0 max-lg:min-h-64">
              <Suspense fallback={<Skeleton className="h-full min-h-64 w-full" />}>
                <DetailsPanel
                  fit
                  spec={details}
                  rows={rows}
                  loading={!rows && !query.isError}
                  error={query.isError}
                  range={
                    selected
                      ? { label: selected.bucket.label, onReset: () => setSelectedKey(null) }
                      : { label: rangeLabel(listRange) }
                  }
                />
              </Suspense>
            </div>
          </div>
        ) : (
          chart
        )}
      </DialogBody>
    </>
  );
}

/** «1.10.2026 – 31.10.2026» — за что список, когда столбец не выбран. */
function rangeLabel(range: Period) {
  return range.from === range.to
    ? formatDate(range.from)
    : `${formatDate(range.from)} – ${formatDate(range.to)}`;
}

/** Окно «сейчас»-плитки: только список, от периода дашборда не зависит. */
function MetricList({
  target,
  stat,
  list,
}: {
  target: ChartTarget;
  stat: StatDef;
  list: StatList;
}) {
  const load = list.load;
  const query = useQuery({
    queryKey: ["dashboard", target.scope, "list", stat.key],
    queryFn: () => load!(target.clubIds),
    enabled: !!load,
    meta: { errorMessage: `${target.name}: не удалось загрузить список «${stat.label}»` },
  });
  const source = load ? query.data : list.rows;
  const rows = useMemo(() => source && detailRows(source, list.details), [source, list.details]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{stat.label}</DialogTitle>
        <DialogDescription>
          {target.name} · {list.description ?? "на сегодня"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <DetailsPanel
            spec={list.details}
            rows={rows}
            loading={!rows && !query.isError}
            error={query.isError}
          />
        </Suspense>
      </DialogBody>
    </>
  );
}
