import { useSyncExternalStore, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info, Wallet } from "lucide-react";

import {
  ShellSkeleton,
  ControlSkeletonView,
  TableCardSkeleton,
  TableSkeletonRows,
  ToolbarSkeleton,
  type ControlSkeleton,
  type HeaderSkeleton,
} from "@/components/skeletons";
import { FieldHint } from "@/components/ui/field-hint";
import { StatTile } from "@/components/ui/stat-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { todayISO } from "@/lib/format";
import { defaultPeriod, periodLabel, type PeriodKey } from "@/lib/payroll";
import { STAFF_ITEMS } from "@/lib/nav-sections";
import type { StudioFormat } from "@/lib/studio-formats";
import {
  SCHEDULE_SKELETON_HOURS,
  isScheduleSkeletonCell,
  readSkeletonFormat,
} from "@/lib/page-skeleton-layout";
import {
  CLASSES_CHARTS,
  CLASSES_COLUMNS,
  CLASSES_GRID,
  CLASSES_STATS,
  CLIENTS_CHARTS,
  CLIENTS_GRID,
  CLIENTS_STATS,
  DASHBOARD_CHART_HEIGHT,
  DASHBOARD_FILTERS,
  DASHBOARD_HEATMAP_HEIGHT,
  DASHBOARD_PIE_HEIGHT,
  DASHBOARD_RANK_HEIGHT,
  DASHBOARD_TITLES,
  MARKETING_CHARTS,
  MARKETING_GRID,
  MARKETING_STATS,
  OVERVIEW_CHARTS,
  OVERVIEW_GRID,
  OVERVIEW_STATS,
  SALES_CHARTS,
  SALES_GRID,
  SALES_STATS,
  SOURCE_COLUMNS,
  TRAINER_COLUMNS,
  WORKOUT_COLUMNS,
} from "@/lib/dashboard-stats";
import { AN_HOME_TEXT, AN_TITLES } from "@/lib/analytics/labels";
import { ONEC_BOARD_PRESETS } from "@/lib/analytics/onec-reports/data";
import { BOARD_NAMES, type OnecBoard } from "@/lib/analytics/onec-reports/payload";
import { CLUBS_HIDDEN } from "@/lib/launch";

/*
 * Скелетоны страниц админки — по одному на раздел, каждый повторяет
 * структуру СВОЕЙ страницы: заголовок, плавающие кнопки действий, плашку фильтров с теми
 * же контролами, заголовки колонок, плитки, карточки, вкладки. Статичные
 * подписи (вкладки, колонки, названия плиток) — настоящим текстом, болванки
 * — только на месте данных.
 *
 * Кто показывает: `pendingComponent` роута (пока грузится код страницы), а
 * через RoutePendingSkeleton — AccessGate, каркас до входа и RequireFormat.
 * Тела-скелетоны (ScriptsListSkeleton, NpsSurveysSkeleton…) страницы берут
 * и для своих данных — тогда переход «скелетон роута → страница грузит
 * данные → данные» идёт без смены раскладки.
 *
 * Модуль попадает в основной бандл (pendingComponent не выносится в чанк
 * страницы) — сюда только разметка: без запросов, тяжёлых библиотек и
 * импорта из файлов страниц.
 *
 * Меняешь раскладку страницы (колонку, фильтр, кнопку) — поправь и её
 * скелетон здесь. Правила — .interface-design/system.md, «Скелетоны».
 */

// ---------------------------------------------------------------------------
// Общие кусочки

const noSubscribe = () => () => {};

/**
 * Формат активного клуба для страниц, у которых от него зависит раскладка
 * (колонки «Продаж», «Тренировок», фильтр «Расписания»). Без запроса: из
 * localStorage (его пишет StudioBranding). На сервере и при гидратации —
 * подписочный, чтобы разметка совпала с серверной.
 */
function useSkeletonFormat(): StudioFormat {
  return useSyncExternalStore(noSubscribe, readSkeletonFormat, () => "subscription");
}

/**
 * Вкладки со статичными подписями, активная — как у настоящих Tabs.
 * className — у обёртки (как у корня Tabs: toolbar-full и т. п.), сама
 * плашка не растягивается.
 */
function TabsSkeleton({
  labels,
  active = 0,
  className,
}: {
  labels: string[];
  /** Какая вкладка активна по умолчанию у страницы. */
  active?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative inline-flex h-10 items-center justify-center rounded-full bg-muted p-1 text-muted-foreground max-sm:max-w-full">
        {labels.map((label, i) => (
          <span
            key={label}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-medium",
              i === active && "bg-primary text-primary-foreground",
            )}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Вкладки раздела «Сотрудники» на белой плашке (components/staff-tabs.tsx);
 * active — url страницы, children — контролы после вкладок на той же плашке.
 */
function StaffTabsSkeleton({ active, children }: { active: string; children?: ReactNode }) {
  return (
    <ToolbarSkeleton search={false}>
      <TabsSkeleton
        labels={STAFF_ITEMS.map((i) => i.tab)}
        active={STAFF_ITEMS.findIndex((i) => i.url === active)}
        className="toolbar-full max-w-full overflow-x-auto"
      />
      {children}
    </ToolbarSkeleton>
  );
}

/** Кнопка-иконка (стрелки периода): круг 40×40 с рамкой, как outline icon. */
function IconButtonSkeleton({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground/60">
      {children}
    </span>
  );
}

/** Плитка с настоящей подписью и болванкой значения. */
function StatTileSkeleton({ label, icon }: { label: string; icon?: ReactNode }) {
  return <StatTile label={label} icon={icon} loading />;
}

/** Поле формы: подпись + контрол 40px (или своя высота). */
function FieldSkeleton({ className, control = "h-10" }: { className?: string; control?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      <Skeleton className="h-4 w-24" />
      <Skeleton className={cn("w-full", control)} />
    </div>
  );
}

/** Табличный раздел: фильтры (если есть) + таблица с подвалом. */
function TablePage({
  title,
  actions,
  toolbar,
  headers,
  pagination = true,
  rows,
  wrap = true,
  tabs,
  kb,
  network,
}: {
  title: string;
  /** Раздел, общий для сети (ShellSkeleton network). */
  network?: boolean;
  /** Страница базы знаний — её шапка (ShellSkeleton kb). */
  kb?: boolean | "tool";
  actions?: ControlSkeleton[];
  /** Вкладки над плашкой фильтров (раздел «Сотрудники»). */
  tabs?: ReactNode;
  /** Плашка фильтров: null — у страницы её нет. */
  toolbar: { search?: boolean; controls?: ControlSkeleton[] } | null;
  headers: HeaderSkeleton[];
  pagination?: boolean;
  rows?: number;
  /** false — таблица прямо в main, без контейнера space-y-3. */
  wrap?: boolean;
}) {
  const table = <TableCardSkeleton headers={headers} rows={rows} pagination={pagination} />;
  return (
    <ShellSkeleton title={title} actions={actions} kb={kb} network={network}>
      {wrap ? (
        <div className="space-y-3">
          {tabs}
          {toolbar && <ToolbarSkeleton {...toolbar} />}
          {table}
        </div>
      ) : (
        table
      )}
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Вход

export function AuthPageSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-background p-6">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-3/4" />
        <FieldSkeleton />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Дашборд

/**
 * Плитки показателей подраздела дашборда — подписи настоящие, болванки на
 * месте значения и сравнения (components/dashboard/stat-cards.tsx).
 */
export function DashboardStatsSkeleton({
  labels,
  className,
}: {
  labels: string[];
  className: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:gap-3", className)}>
      {labels.map((label) => (
        // Та же сетка, что у плиток (stat-cards.tsx): строки — subgrid.
        <div
          key={label}
          className="row-span-3 grid grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
          <Skeleton className="mt-0.5 h-6 w-24" />
          <Skeleton className="mt-0.5 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Панель графика дашборда: настоящий заголовок, болванка графика (components/dashboard/chart-panel.tsx). */
export function DashboardChartSkeleton({
  title,
  height,
  className,
  children,
}: {
  title: string;
  height?: number;
  className?: string;
  /** Своя болванка вместо прямоугольника графика (рейтинг, круговая). */
  children?: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border bg-background p-3 sm:p-4", className)}>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children ?? <Skeleton className="w-full" style={{ height }} />}
    </section>
  );
}

/** «Топ 10»: место, имя с полосой, значение (RankList). */
export function DashboardRankSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2">
          <Skeleton className="h-3 w-3" />
          <div>
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="mt-1 h-1.5 w-full" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Круговая диаграмма с легендой (PiePlot + PieLegend). */
export function DashboardPieSkeleton({ height, rows = 3 }: { height: number; rows?: number }) {
  return (
    <>
      <div className="flex items-center justify-center" style={{ height }}>
        <Skeleton className="aspect-square h-[90%] rounded-full" />
      </div>
      <div className="mt-3 space-y-1.5">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </>
  );
}

/**
 * Поле плашки фильтров дашборда с подписью и «?» над ним (решение владельца
 * 2026-10-11: в остальных плашках подписей нет). Ширина — как у фильтра, w-48.
 */
export function DashboardFilterField({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: ReactNode;
}) {
  return (
    <div className="grid w-48 gap-1">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}
        <FieldHint>{tip}</FieldHint>
      </span>
      {children}
    </div>
  );
}

/** Плашка фильтров дашборда («Период», «Клубы») и тело подраздела. */
export function DashboardBodySkeleton({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="table-toolbar flex flex-wrap items-end gap-2 rounded-lg border bg-background p-2 sm:px-3">
        {[DASHBOARD_FILTERS.period, DASHBOARD_FILTERS.clubs].map((f) => (
          <DashboardFilterField key={f.label} {...f}>
            <Skeleton className="h-10 w-full" />
          </DashboardFilterField>
        ))}
      </div>
      {children}
    </div>
  );
}

/** «Общие показатели»: плитки, выручка по дням, продления и посещения. */
export function DashboardOverviewSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton
        labels={OVERVIEW_STATS.map((s) => s.label)}
        className={OVERVIEW_GRID}
      />
      <DashboardChartSkeleton
        title={OVERVIEW_CHARTS.revenue.title}
        height={DASHBOARD_CHART_HEIGHT}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <DashboardChartSkeleton
          title={OVERVIEW_CHARTS.rates.title}
          height={DASHBOARD_CHART_HEIGHT}
        />
        <DashboardChartSkeleton
          title={OVERVIEW_CHARTS.visits.title}
          height={DASHBOARD_CHART_HEIGHT}
        />
      </div>
    </>
  );
}

export function DashboardPageSkeleton() {
  return (
    <ShellSkeleton title={DASHBOARD_TITLES.overview}>
      <DashboardBodySkeleton>
        <DashboardOverviewSkeleton />
      </DashboardBodySkeleton>
    </ShellSkeleton>
  );
}

/** «Продажи»: плитки, три круговые, два рейтинга. */
export function DashboardSalesSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton labels={SALES_STATS.map((s) => s.label)} className={SALES_GRID} />
      <div className="grid gap-3 lg:grid-cols-3">
        {[SALES_CHARTS.origin, SALES_CHARTS.methods, SALES_CHARTS.subjects].map((c) => (
          <DashboardChartSkeleton key={c.title} title={c.title}>
            <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} />
          </DashboardChartSkeleton>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {[SALES_CHARTS.topMemberships, SALES_CHARTS.topSellers].map((c) => (
          <DashboardChartSkeleton key={c.title} title={c.title}>
            <DashboardRankSkeleton />
          </DashboardChartSkeleton>
        ))}
      </div>
    </>
  );
}

export function DashboardSalesPageSkeleton() {
  return (
    <ShellSkeleton title={DASHBOARD_TITLES.sales}>
      <DashboardBodySkeleton>
        <DashboardSalesSkeleton />
      </DashboardBodySkeleton>
    </ShellSkeleton>
  );
}

/** «Клиенты»: плитки, возраст и топ по посещениям, топ по LTV. */
export function DashboardClientsSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton labels={CLIENTS_STATS.map((s) => s.label)} className={CLIENTS_GRID} />
      <div className="grid gap-3 lg:grid-cols-2">
        <DashboardChartSkeleton title={CLIENTS_CHARTS.ages.title} height={DASHBOARD_RANK_HEIGHT} />
        <DashboardChartSkeleton title={CLIENTS_CHARTS.topVisits.title}>
          <DashboardRankSkeleton />
        </DashboardChartSkeleton>
      </div>
      <DashboardChartSkeleton title={CLIENTS_CHARTS.topLtv.title}>
        <DashboardRankSkeleton />
      </DashboardChartSkeleton>
    </>
  );
}

export function DashboardClientsPageSkeleton() {
  return (
    <ShellSkeleton title={DASHBOARD_TITLES.clients}>
      <DashboardBodySkeleton>
        <DashboardClientsSkeleton />
      </DashboardBodySkeleton>
    </ShellSkeleton>
  );
}

/**
 * Таблица показателей дашборда (components/dashboard/metric-table.tsx):
 * настоящая шапка — название и колонки, болванки строк.
 */
export function DashboardTableSkeleton({
  name,
  columns,
  rows = 5,
}: {
  name: string;
  columns: string[];
  rows?: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{name}</TableHead>
          {columns.map((c) => (
            <TableHead key={c} className="text-right">
              {c}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableSkeletonRows columns={columns.length + 1} rows={rows} />
      </TableBody>
    </Table>
  );
}

/** «Путь новых клиентов»: подпись шага, полоса, число и доля (components/dashboard/funnel.tsx). */
export function DashboardFunnelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3">
          <div>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1 h-6 w-full" />
          </div>
          <div className="space-y-1">
            <Skeleton className="ml-auto h-4 w-10" />
            <Skeleton className="ml-auto h-3 w-8" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** «Занятия»: плитки, загрузка расписания, тренеры, тренировки, слоты. */
export function DashboardClassesSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton labels={CLASSES_STATS.map((s) => s.label)} className={CLASSES_GRID} />
      <DashboardChartSkeleton
        title={CLASSES_CHARTS.heatmap.title}
        height={DASHBOARD_HEATMAP_HEIGHT}
      />
      <DashboardChartSkeleton title={CLASSES_CHARTS.trainers.title}>
        <DashboardTableSkeleton
          name="Тренер"
          columns={TRAINER_COLUMNS.map((k) => CLASSES_COLUMNS[k].label)}
        />
      </DashboardChartSkeleton>
      <DashboardChartSkeleton title={CLASSES_CHARTS.workouts.title}>
        <DashboardTableSkeleton
          name="Тренировка"
          columns={WORKOUT_COLUMNS.map((k) => CLASSES_COLUMNS[k].label)}
        />
      </DashboardChartSkeleton>
      <div className="grid gap-3 lg:grid-cols-2">
        {[CLASSES_CHARTS.topSlots, CLASSES_CHARTS.weakSlots].map((c) => (
          <DashboardChartSkeleton key={c.title} title={c.title}>
            <DashboardRankSkeleton />
          </DashboardChartSkeleton>
        ))}
      </div>
    </>
  );
}

export function DashboardClassesPageSkeleton() {
  return (
    <ShellSkeleton title={DASHBOARD_TITLES.classes}>
      <DashboardBodySkeleton>
        <DashboardClassesSkeleton />
      </DashboardBodySkeleton>
    </ShellSkeleton>
  );
}

/** «Маркетинг»: плитки, путь новых клиентов, источники, цели, промокоды, каналы. */
export function DashboardMarketingSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton
        labels={MARKETING_STATS.map((s) => s.label)}
        className={MARKETING_GRID}
      />
      <div className="grid gap-3 lg:grid-cols-3">
        <DashboardChartSkeleton title={MARKETING_CHARTS.funnel.title} className="lg:col-span-2">
          <DashboardFunnelSkeleton />
        </DashboardChartSkeleton>
        <DashboardChartSkeleton title={MARKETING_CHARTS.sources.title}>
          <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} rows={4} />
        </DashboardChartSkeleton>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <DashboardChartSkeleton
          title={MARKETING_CHARTS.sourcesTable.title}
          className="lg:col-span-2"
        >
          <DashboardTableSkeleton
            name="Источник"
            columns={Object.values(SOURCE_COLUMNS).map((c) => c.label)}
          />
        </DashboardChartSkeleton>
        <DashboardChartSkeleton title={MARKETING_CHARTS.goals.title}>
          <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} rows={4} />
        </DashboardChartSkeleton>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <DashboardChartSkeleton title={MARKETING_CHARTS.promoCodes.title}>
          <DashboardRankSkeleton rows={5} />
        </DashboardChartSkeleton>
        <DashboardChartSkeleton title={MARKETING_CHARTS.channels.title}>
          <DashboardPieSkeleton height={DASHBOARD_PIE_HEIGHT} rows={2} />
        </DashboardChartSkeleton>
      </div>
    </>
  );
}

export function DashboardMarketingPageSkeleton() {
  return (
    <ShellSkeleton title={DASHBOARD_TITLES.marketing}>
      <DashboardBodySkeleton>
        <DashboardMarketingSkeleton />
      </DashboardBodySkeleton>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Расписание

const HOURS = Array.from({ length: 14 }, (_, i) => i + 9); // 9..22, как в schedule.tsx
const SLOT_FULL = 72;
const SLOT_EMPTY = 28;
const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Болванка карточки занятия в слоте сетки. */
export function EntryCardSkeleton() {
  return (
    <div className="pointer-events-none absolute inset-1 space-y-1.5 rounded-md border bg-background p-2">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function ScheduleGridSkeleton({ days, packages }: { days: number; packages: boolean }) {
  const single = days === 1;
  return (
    <div className="overflow-auto rounded-lg border bg-background md:max-h-[calc(100dvh-220px)]">
      <div
        className={cn("grid", !single && "min-w-[1200px]")}
        style={{ gridTemplateColumns: `${single ? 52 : 60}px repeat(${days}, minmax(0, 1fr))` }}
      >
        {!single && (
          <>
            <div className="sticky top-0 z-20 border-b border-r bg-background" />
            {DAY_NAMES.map((d) => (
              <div
                key={d}
                className="sticky top-0 z-20 space-y-1 border-b border-r bg-background p-2 text-center text-xs"
              >
                <div className="uppercase tracking-wide text-muted-foreground">{d}</div>
                <Skeleton className="mx-auto h-3 w-10" />
              </div>
            ))}
          </>
        )}
        {HOURS.map((hour) => {
          const height = SCHEDULE_SKELETON_HOURS.has(hour) ? SLOT_FULL : SLOT_EMPTY;
          return (
            <div key={hour} className="contents">
              <div
                className="border-b border-r px-2 text-right text-xs text-muted-foreground"
                style={{ height, lineHeight: "1rem", paddingTop: 4 }}
              >
                {String(hour).padStart(2, "0")}:00
              </div>
              {Array.from({ length: days }, (_, di) => (
                <div
                  key={di}
                  className={cn(
                    "relative border-b border-r max-md:border-r-0",
                    packages && "bg-canvas/50",
                  )}
                  style={{ height }}
                >
                  {isScheduleSkeletonCell(hour, di, single) && <EntryCardSkeleton />}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SchedulePageSkeleton() {
  const packages = useSkeletonFormat() === "packages";
  return (
    <ShellSkeleton
      title="Расписание"
      actions={[{ label: "Дублировать неделю" }, { label: "Добавить занятие" }]}
    >
      <div className="space-y-3">
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <PeriodStepperSkeleton />
          <div className="toolbar-full flex flex-wrap items-center gap-2 sm:ml-auto">
            {!packages && <Skeleton className="h-10 w-40 max-sm:flex-1" />}
            <Skeleton className="h-10 w-[25rem] max-sm:h-[4.5rem] max-sm:w-full" />
            <Skeleton className="h-10 w-48 max-sm:flex-1" />
            <Skeleton className="h-10 w-48 max-sm:flex-1" />
          </div>
        </div>
        {/* Телефон: переключатель дней и сетка одного дня. */}
        <div className="grid grid-cols-7 gap-1 rounded-lg border bg-background p-1 md:hidden">
          {DAY_NAMES.map((d) => (
            <div key={d} className="flex flex-col items-center gap-1 py-1.5 text-xs">
              <span className="uppercase text-muted-foreground">{d}</span>
              <Skeleton className="h-4 w-5" />
            </div>
          ))}
        </div>
        <div className="md:hidden">
          <ScheduleGridSkeleton days={1} packages={packages} />
        </div>
        <div className="max-md:hidden">
          <ScheduleGridSkeleton days={7} packages={packages} />
        </div>
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Клуб: клиенты и продажи

export function ClientsPageSkeleton() {
  return (
    <TablePage
      title="Клиенты"
      actions={[{ label: "Добавить клиента" }]}
      // Два фильтра периода (DateRangeFilter) — поля w-48, как селекты.
      toolbar={{ controls: ["w-40", "w-48", "w-48", "w-48"] }}
      headers={[
        { label: "Клиент", className: "min-w-[240px]" },
        { label: "Статус", className: "w-[80px]" },
        "Телефон",
        "Email",
        "Заметки",
        "Последний визит",
        "Пол",
        "Дата рождения",
        "Регистрация",
        "Добавлен",
      ]}
    />
  );
}

export function SalesPageSkeleton() {
  return (
    <TablePage
      title="Продажи"
      actions={[{ label: "Новая продажа" }]}
      toolbar={{}}
      headers={[
        { label: "Клиент", className: "min-w-[220px]" },
        "Контакты",
        "Дата",
        "Источник",
        "Абонемент",
        "Статус",
        "Тип оплаты",
        "Промо-код",
        "Сумма",
        "Первый взнос",
        "Рассрочка",
        "Администратор",
        "Комментарий",
      ]}
    />
  );
}

export function ClientMembershipsPageSkeleton() {
  return (
    <TablePage
      title="Абонементы"
      actions={[{ label: "Продажа" }]}
      toolbar={{ controls: ["w-48", "w-48", "w-48", "w-40", "w-48", "w-48", "w-40", "w-48"] }}
      headers={[
        { label: "Клиент", className: "min-w-[170px]" },
        "Абонемент",
        "Статус",
        "Платежи",
        "Комментарии",
        "Баланс",
        "Сумма",
        "Продал / тренер",
        "Клуб продажи",
        "Добавлен",
      ]}
    />
  );
}

export function OtherSalesPageSkeleton() {
  return (
    <ShellSkeleton title="Прочие продажи" actions={[{ label: "Добавить продажу" }]}>
      <div className="space-y-3">
        <ToolbarSkeleton search={false}>
          <TabsSkeleton labels={["Продажи", "Позиции"]} className="toolbar-full" />
        </ToolbarSkeleton>
        <TableCardSkeleton
          pagination
          headers={[
            "Позиция",
            "Тип",
            "Клиент",
            { label: "Кол-во", className: "text-right" },
            { label: "Цена", className: "text-right" },
            { label: "Сумма", className: "text-right" },
            "Оплата",
            "Дата",
            "Администратор",
            "Комментарий",
          ]}
        />
      </div>
    </ShellSkeleton>
  );
}

export function BookingsLogPageSkeleton() {
  // «Отметить пропущенные» — только у подписочных клубов.
  const packages = useSkeletonFormat() === "packages";
  return (
    <TablePage
      title="История записей"
      actions={packages ? [] : [{ label: "Отметить пропущенные", icon: false }]}
      toolbar={{ controls: ["w-48"] }}
      headers={[
        { label: "Клиент", className: "min-w-[220px]" },
        "Контакты",
        "Тренировка",
        { label: "Дата и время", className: "w-[160px]" },
        { label: "Статус", className: "w-[140px]" },
        { label: "MET", className: "w-[70px] text-right" },
        { label: "Вес, кг", className: "w-[80px] text-right" },
        { label: "Длит., мин", className: "w-[80px] text-right" },
        { label: "Ккал", className: "w-[90px] text-right" },
        { label: "Отменена", className: "w-[160px]" },
        { label: "Причина отмены", className: "min-w-[180px]" },
      ]}
    />
  );
}

export function AutorenewPageSkeleton() {
  return (
    <TablePage
      title="Отмены автопродления"
      toolbar={{ controls: ["w-48"] }}
      headers={[
        { label: "Клиент", className: "min-w-[220px]" },
        "Контакты",
        "Абонемент",
        { label: "Действует до", className: "w-[140px]" },
        { label: "Причина отмены", className: "w-[180px]" },
        { label: "Отменено", className: "w-[160px]" },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Клуб: номенклатура и справочники

export function MembershipsPageSkeleton() {
  return (
    <TablePage
      title="Номенклатуры"
      actions={[{ label: "Добавить абонемент" }]}
      toolbar={{}}
      headers={[
        { label: "Обложка", className: "w-[80px]" },
        "Название",
        "Описание",
        "Преимущества",
        "Посещения",
        "Срок",
        "Автопродление",
        "Рассрочка",
        "Цена",
        "Статус",
      ]}
    />
  );
}

export function PackagesPageSkeleton() {
  return (
    <TablePage
      title="Номенклатуры"
      actions={[{ label: "Добавить" }]}
      toolbar={{}}
      pagination={false}
      headers={[
        "",
        "Название",
        "Тип",
        "Тренировок",
        "Срок действия",
        "Стоимость",
        "Платежей",
        "Описание",
        "Статус",
      ]}
    />
  );
}

export function PromocodesPageSkeleton() {
  return (
    <TablePage
      title="Промокоды"
      actions={[{ label: "Добавить промокод" }]}
      toolbar={null}
      headers={[
        "Название",
        "Промокод",
        "Скидка",
        "Действует до",
        "Применений",
        "Описание",
        { label: "Активен", className: "w-[100px]" },
      ]}
    />
  );
}

export function WorkoutsPageSkeleton() {
  const packages = useSkeletonFormat() === "packages";
  return (
    <TablePage
      title="Тренировки"
      actions={[{ label: "Добавить тренировку" }]}
      toolbar={{}}
      headers={[
        packages
          ? { label: "Цвет", className: "w-[80px]" }
          : { label: "Иконка", className: "w-[100px]" },
        "Название",
        ...(packages ? [] : [{ label: "Тип", className: "w-[160px]" }]),
        "Описание",
        { label: "Вместимость", className: "w-[120px]" },
        { label: "MET", className: "w-[90px]" },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Клуб: финансы

export function CashPageSkeleton() {
  return (
    <ShellSkeleton title="Касса">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTileSkeleton icon={<Wallet />} label="Баланс" />
        </div>
        <div className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 text-lg font-semibold">Новая операция</h2>
          {/* Клуб, тип, категория, сумма, кто проводит; дата и комментарий. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <FieldSkeleton className="sm:col-span-2" />
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton />
            <FieldSkeleton className="sm:col-span-2" />
            <FieldSkeleton className="sm:col-span-2 lg:col-span-4" control="h-16" />
          </div>
          <div className="mt-3 flex justify-end">
            <Skeleton className="h-10 w-32" />
          </div>
        </div>
        <TableCardSkeleton
          title="История операций"
          pagination
          headers={["Дата", "Клуб", "Тип", "Категория", "Сумма", "Сотрудник", "Комментарий"]}
        />
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Клуб: обратная связь

/** Три плитки «Обратной связи» — с подписями, значения грузятся. */
export function FeedbackStatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {["В этом месяце", "Не отработано", "Отработано в этом месяце"].map((label) => (
        <StatTileSkeleton key={label} label={label} />
      ))}
    </div>
  );
}

export function FeedbackPageSkeleton() {
  return (
    <ShellSkeleton title="Обратная связь" actions={[{ label: "Добавить" }]}>
      <div className="space-y-3">
        <FeedbackStatsSkeleton />
        <ToolbarSkeleton search={false} controls={["w-48", "w-48", "w-40", "w-40", "w-48"]} />
        <TableCardSkeleton
          pagination
          headers={[
            "Дата",
            "Тема",
            "Сообщение",
            { label: "Оценка", className: "w-[80px] text-center" },
            "Имя",
            "Клуб",
            "Контакт",
            "Статус",
            "Отработал",
          ]}
        />
      </div>
    </ShellSkeleton>
  );
}

/** Плитки «Заявок»: не отработано, пришло и отработано за месяц. */
export function RequestsStatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {["Не отработано", "Пришло в этом месяце", "Отработано в этом месяце"].map((label) => (
        <StatTileSkeleton key={label} label={label} />
      ))}
    </div>
  );
}

export function RequestsPageSkeleton() {
  return (
    <ShellSkeleton title="Заявки">
      <div className="space-y-3">
        <RequestsStatsSkeleton />
        <ToolbarSkeleton search={false} controls={["w-48", "w-48", "w-48"]} />
        <TableCardSkeleton
          pagination
          headers={[
            "Дата",
            "Клиент",
            "Клуб",
            "Заявка",
            "Цели",
            "Комментарий",
            "Абонемент",
            "Статус",
          ]}
        />
      </div>
    </ShellSkeleton>
  );
}

/** Вкладка «Опросы» NPS: пять карточек опросов по четыре показателя. */
export function NpsSurveysSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="rounded-lg border bg-background p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mb-4 mt-2 h-3 w-64 max-w-full" />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {["NPS", "Ответов", "Промо", "Критики"].map((label) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <Skeleton className="mt-1 h-7 w-12" />
              </div>
            ))}
          </div>
          {/* Показы в приложении (у «Общего» — плашка «Не реализовано»). */}
          <Skeleton className="mt-4 h-3 w-72 max-w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Вкладка «Статистика» NPS: пять KPI, два графика, таблица. Фильтры — на
 * плашке с табами, она настоящая и во время загрузки.
 */
export function NpsStatsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="rounded-lg border bg-background p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-14" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="rounded-lg border bg-background p-5">
            <Skeleton className="mb-4 h-4 w-40" />
            <Skeleton className="h-[240px] w-full" />
          </div>
        ))}
      </div>
      <TableCardSkeleton
        pagination
        headers={[
          "Дата",
          "Клиент",
          "Клуб",
          { label: "Оценка", className: "w-[80px]" },
          "Категория",
          "Комментарий",
          "Опрос",
          "Прочитано",
        ]}
      />
    </div>
  );
}

export function NpsPageSkeleton() {
  return (
    <ShellSkeleton title="NPS-опросы" actions={[{ label: "Добавить ответ" }]}>
      <div className="space-y-3">
        <ToolbarSkeleton search={false}>
          <TabsSkeleton labels={["Опросы", "Статистика"]} className="toolbar-full" />
          {/* Фильтр «Клуб» — при нескольких клубах. */}
          <Skeleton className="h-10 w-56" />
        </ToolbarSkeleton>
        {/* Плашка «как показываются опросы» над карточками. */}
        <Skeleton className="h-16 w-full rounded-md" />
        <NpsSurveysSkeleton />
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Мобильное приложение

export function NewsPageSkeleton() {
  return <ShowcaseSkeleton title="Новости" add="Добавить новость" />;
}

export function ServicesPageSkeleton() {
  return <ShowcaseSkeleton title="Услуги" add="Добавить услугу" />;
}

function ShowcaseSkeleton({ title, add }: { title: string; add: string }) {
  return (
    <TablePage
      title={title}
      actions={[{ label: add }]}
      toolbar={null}
      headers={[
        { label: "Порядок", className: "w-[90px]" },
        { label: "Картинка", className: "w-[100px]" },
        { label: "Баннер", className: "w-[140px]" },
        "Заголовок",
        { label: "Клубы", className: "w-[180px]" },
        "Описание",
        { label: "Кнопка", className: "w-[140px]" },
      ]}
    />
  );
}

export function PushPageSkeleton() {
  return (
    <TablePage
      title="Пуш-уведомления"
      actions={[{ label: "Добавить уведомление" }]}
      toolbar={null}
      headers={[
        "Заголовок",
        { label: "Клубы", className: "w-[180px]" },
        "Сегмент",
        "Отправка",
        "Статус",
        "Получатели",
        "Отправлено",
        "Доставлено",
        "Прочитано",
      ]}
    />
  );
}

/** «Триггеры» (/push-triggers): пояснение и группы карточек триггеров. */
export function PushTriggersPageSkeleton() {
  return (
    <ShellSkeleton title="Триггерные уведомления">
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-14 w-full rounded-md" />
        <PushTriggersListSkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** Карточки триггеров: название, описание, текст, статистика; справа — включатель и «Изменить». */
export function PushTriggersListSkeleton() {
  return (
    <div className="space-y-6">
      {[3, 2].map((cards, g) => (
        <div key={g} className="space-y-3">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: cards }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-3 rounded-lg border bg-background p-4 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-56 max-w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-16 w-full rounded-md" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                <Skeleton className="h-5 w-9 rounded-full" />
                <Skeleton className="h-9 w-28 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Форма «Контактов и правил» (/club-settings): две секции, 3 и 1 поле. */
export function ClubSettingsFormSkeleton() {
  return (
    <div className="max-w-2xl space-y-8">
      {[2, 1].map((fields, i) => (
        <div key={i} className="space-y-4 rounded-lg border bg-background p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          {Array.from({ length: fields }).map((_, j) => (
            <div key={j} className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Выбор клуба над формой «Контактов и правил». */
export function ClubPickerSkeleton() {
  return <ToolbarSkeleton search={false} controls={["w-48"]} />;
}

export function ClubSettingsPageSkeleton() {
  return (
    <ShellSkeleton title="Контакты и правила" actions={[{ label: "Сохранить" }]}>
      <div className="max-w-2xl space-y-6">
        <ClubPickerSkeleton />
        <ClubSettingsFormSkeleton />
      </div>
    </ShellSkeleton>
  );
}

/**
 * Форма «Настроек приложения»: по карточке на клиентское приложение
 * (иконка, подпись, предпросмотр). До загрузки клубов — две.
 */
export function AppSettingsFormSkeleton({ apps = 2 }: { apps?: number }) {
  return (
    <div className="max-w-2xl space-y-8">
      {Array.from({ length: apps }).map((_, i) => (
        <div key={i} className="space-y-4 rounded-lg border bg-background p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-72" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <div className="flex items-center gap-3">
              <Skeleton className="h-16 w-16 rounded-[22%]" />
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-10 w-full max-w-80" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-36 w-44 rounded-xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Форма «О нас»: справка и шесть секций — обложка, три галереи (студии и
 * массажный кабинет),
 * сообщество (три числа и фото), Instagram (подписчики и сетка).
 */
export function AppAboutFormSkeleton() {
  const title = (
    <div className="space-y-2">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
  const label = <Skeleton className="h-4 w-1/4" />;
  return (
    <div className="max-w-2xl space-y-8">
      <Skeleton className="h-14 w-full rounded-md" />
      <div className="space-y-4 rounded-lg border bg-background p-6">
        {title}
        {label}
        <div className="flex items-center gap-3">
          <Skeleton className="h-16 w-24" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-4 rounded-lg border bg-background p-6">
          {title}
          {label}
          <div className="flex gap-3">
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} className="h-28 w-[90px]" />
            ))}
          </div>
          <Skeleton className="h-9 w-36 rounded-full" />
        </div>
      ))}
      <div className="space-y-4 rounded-lg border bg-background p-6">
        {title}
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            {label}
            <Skeleton className="h-10 w-48" />
          </div>
        ))}
        {label}
        <div className="flex items-center gap-3">
          <Skeleton className="h-16 w-24" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
      </div>
      <div className="space-y-4 rounded-lg border bg-background p-6">
        {title}
        {label}
        <Skeleton className="h-10 w-48" />
        {label}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-16 w-16" />
                <Skeleton className="h-9 w-24 rounded-full" />
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AppAboutPageSkeleton() {
  return (
    <ShellSkeleton title="О нас" actions={[{ label: "Сохранить" }]}>
      <AppAboutFormSkeleton />
    </ShellSkeleton>
  );
}

export function AppSettingsPageSkeleton() {
  return (
    <ShellSkeleton title="Настройки приложения" actions={[{ label: "Сохранить" }]}>
      <AppSettingsFormSkeleton />
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Импорт из 1С

export function Import1cPageSkeleton() {
  return (
    <ShellSkeleton title="Импорт из 1С">
      <div className="max-w-2xl space-y-8">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-4 rounded-lg border bg-background p-6">
            <div className="space-y-2">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-9 w-40 rounded-full" />
          </div>
        ))}
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Сотрудники

export function TrainersPageSkeleton() {
  return (
    <TablePage
      title="Сотрудники"
      actions={[{ label: "Добавить сотрудника" }]}
      toolbar={null}
      tabs={<StaffTabsSkeleton active="/trainers" />}
      headers={[
        { label: "Фото", className: "w-[80px]" },
        "Имя",
        "Роль",
        "Клубы",
        "Telegram",
        "Банк",
        "Счёт",
        "Владелец счёта",
      ]}
    />
  );
}

export function PayRatesPageSkeleton() {
  return (
    <ShellSkeleton title="Зарплатные ставки">
      <div className="space-y-3">
        <StaffTabsSkeleton active="/pay-rates" />
        <div className="rounded-md border bg-muted/40 p-3">
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
        <TableCardSkeleton
          pagination
          headers={[
            "Сотрудник",
            "Смена администратора",
            "Групповая тренировка",
            "Персональная тренировка",
          ]}
        />
      </div>
    </ShellSkeleton>
  );
}

/** Листание периода (PeriodStepper): ◀ «Текущий …» ▶ и подпись. */
function PeriodStepperSkeleton() {
  return (
    <div className="toolbar-full flex items-center gap-2">
      <IconButtonSkeleton>
        <ChevronLeft className="size-4" />
      </IconButtonSkeleton>
      <Skeleton className="h-10 w-36 rounded-full max-sm:flex-1" />
      <IconButtonSkeleton>
        <ChevronRight className="size-4" />
      </IconButtonSkeleton>
      <Skeleton className="ml-1 h-4 w-28 max-sm:hidden" />
    </div>
  );
}

export function AdminShiftsPageSkeleton() {
  return (
    <ShellSkeleton title="График администраторов">
      <div className="space-y-3">
        <StaffTabsSkeleton active="/admin-shifts">
          <PeriodStepperSkeleton />
        </StaffTabsSkeleton>
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-max border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 w-28 min-w-28 border-r border-b bg-background px-3 py-2 text-left text-xs font-medium text-muted-foreground sm:w-36 sm:min-w-36">
                  Клуб
                </th>
                {Array.from({ length: 30 }, (_, i) => (
                  <th
                    key={i}
                    className="w-[88px] min-w-[88px] space-y-1 border-r border-b px-1 py-1.5 last:border-r-0"
                  >
                    <Skeleton className="mx-auto h-3 w-5" />
                    <Skeleton className="mx-auto size-7 rounded-full" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 2 }, (_, r) => (
                <tr key={r}>
                  <th className="sticky left-0 z-10 border-r border-b bg-background px-3 py-2">
                    <Skeleton className="h-4 w-20" />
                  </th>
                  {Array.from({ length: 30 }, (_, i) => (
                    <td key={i} className="border-r border-b p-1 align-top last:border-r-0">
                      <div className="flex min-h-14 flex-col gap-1">
                        <Skeleton className="h-6 w-full" />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Skeleton className="mx-1 h-3 w-full max-w-2xl" />
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="rounded-lg border bg-background">
            <div className="space-y-1.5 p-4 pb-0">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
              <FieldSkeleton className="sm:col-span-2 xl:col-span-1" />
              <FieldSkeleton />
              <FieldSkeleton />
              <FieldSkeleton />
              <FieldSkeleton className="sm:col-span-2 xl:col-span-3" />
              <div className="flex items-end">
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Дата", "Сотрудник", "Сумма", "Причина", "Добавил"].map((h, i) => (
                      <TableHead key={i} className={cn(i === 2 && "text-right")}>
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableSkeletonRows columns={5} rows={3} />
                </TableBody>
              </Table>
            </div>
          </section>
          <section className="rounded-lg border bg-background p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-1.5 h-3 w-48" />
            <ul className="mt-3 divide-y">
              {Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-7 w-8" />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function PayrollPageSkeleton() {
  // Вкладки периода — с настоящими подписями и выбранной по умолчанию, как у
  // страницы. Дата — только на клиенте: на сервере и при гидратации — аванс.
  const today = useSyncExternalStore(noSubscribe, todayISO, () => null);
  const { month, period } = today
    ? defaultPeriod(today)
    : { month: "2026-01", period: "advance" as PeriodKey };
  const periods: PeriodKey[] = ["advance", "main", "month"];
  return (
    <ShellSkeleton title="Зарплаты">
      <div className="space-y-3">
        <StaffTabsSkeleton active="/payroll" />
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <PeriodStepperSkeleton />
          <TabsSkeleton
            labels={periods.map((p) => periodLabel(month, p))}
            active={periods.indexOf(period)}
            className="toolbar-full max-sm:w-full"
          />
          <div className="toolbar-full flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:ml-auto">
            <span className="flex items-center gap-1">
              Выплачено: <Skeleton className="h-4 w-16" />
            </span>
            <span className="flex items-center gap-1">
              Осталось: <Skeleton className="h-4 w-16" />
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
        <ToolbarSkeleton controls={["w-48", "w-48"]} />
        <TableCardSkeleton
          headers={[
            { label: "Сотрудник", className: "min-w-[220px]" },
            "Роль",
            { label: "Оклад", className: "text-right" },
            { label: "Продажи", className: "text-right" },
            { label: "Бонус 5%", className: "text-right" },
            { label: "Корректир.", className: "text-right" },
            { label: "Итого", className: "text-right" },
            "Статус",
          ]}
        />
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Доступы, клубы, Kate

export function AccessUsersPageSkeleton() {
  return (
    <TablePage
      title="Пользователи"
      toolbar={{
        search: true,
        controls: CLUBS_HIDDEN
          ? ["w-44", "w-44", "w-44", "w-44", "w-44"]
          : ["w-44", "w-44", "w-44", "w-44", "w-44", "w-44"],
      }}
      pagination={false}
      rows={8}
      headers={
        CLUBS_HIDDEN
          ? [
              "Пользователь",
              "Должность и подразделение",
              "Клубы собственника",
              "Роли",
              "Статус",
              "Последний вход",
            ]
          : [
              "Пользователь",
              "Должность и подразделение",
              "Клубы собственника",
              "Роли",
              "Клубы",
              "Статус",
              "Последний вход",
            ]
      }
    />
  );
}

export function AccessRolesPageSkeleton() {
  return (
    <TablePage
      title="Роли"
      toolbar={null}
      pagination={false}
      rows={8}
      headers={["Роль", "Права", "Люди"]}
    />
  );
}

export function AccessLogPageSkeleton() {
  return (
    <TablePage
      title="Журнал доступа"
      toolbar={{ search: true }}
      pagination={false}
      rows={10}
      headers={["Когда", "Кто", "Что"]}
    />
  );
}

/** Карточка пользователя: шапка с аватаркой, роли, подразделения, личные права. */
export function AccessUserPageSkeleton() {
  return (
    <ShellSkeleton title="Пользователь">
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-4 w-32" />
        <section className="flex items-start gap-4 rounded-lg border bg-background p-4">
          <Skeleton className="size-16 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
        </section>
        {["Роли", "Подразделения", "Итоговые права"].map((title) => (
          <section key={title} className="space-y-3 rounded-lg border bg-background p-4">
            <h2 className="font-semibold">{title}</h2>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </section>
        ))}
      </div>
    </ShellSkeleton>
  );
}

/** Роль: название и матрица прав по блокам. */
export function AccessRolePageSkeleton() {
  return (
    <ShellSkeleton title="Роль">
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-24" />
        <section className="space-y-3 rounded-lg border bg-background p-4">
          <FieldSkeleton />
          <FieldSkeleton control="h-16" />
        </section>
        <section className="space-y-3 rounded-lg border bg-background p-4">
          <h2 className="font-semibold">Кому выдана</h2>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </section>
        {Array.from({ length: 3 }, (_, i) => (
          <section key={i} className="space-y-3 rounded-lg border p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full" />
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 6 }, (_, j) => (
                <Skeleton key={j} className="h-4 w-32" />
              ))}
            </div>
          </section>
        ))}
      </div>
    </ShellSkeleton>
  );
}

/** Оргструктура: вкладки, дерево подразделений слева, подразделение справа. */
export function AccessStructurePageSkeleton() {
  return (
    <ShellSkeleton title="Оргструктура">
      <div className="space-y-4">
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="toolbar-full h-10 w-80 max-w-full rounded-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <section className="space-y-2 rounded-lg border bg-background p-3">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </section>
          <section className="space-y-3 rounded-lg border bg-background p-4">
            <Skeleton className="h-5 w-48" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </section>
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function StudiosPageSkeleton() {
  return (
    <TablePage
      title="Клубы"
      toolbar={null}
      wrap={false}
      pagination={false}
      rows={2}
      headers={[
        "Название",
        { label: "Логотип", className: "w-[180px]" },
        "Тип",
        "Цвет",
        // Без адресов клиентских приложений колонки нет (studios.tsx).
        ...(CLUBS_HIDDEN ? [] : ["Приложение клиентов"]),
      ]}
    />
  );
}

export function AssistantPageSkeleton() {
  return (
    <ShellSkeleton title="KATE — AI АССИСТЕНТ">
      <div className="mx-auto h-[calc(100dvh-8rem)] w-full max-w-3xl lg:max-w-5xl">
        <div className="flex h-full overflow-hidden rounded-lg border bg-background">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
              <Skeleton className="size-14 rounded-full" />
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            {/* Готовые вопросы лентой — до lg. */}
            <div className="flex gap-2 overflow-hidden border-t px-3 pt-3 lg:hidden">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-56 shrink-0 rounded-lg" />
              ))}
            </div>
            <div className="flex gap-2 border-t p-3 max-lg:border-t-0">
              <Skeleton className="h-20 flex-1" />
              <Skeleton className="h-20 w-10" />
            </div>
          </div>
          {/* Готовые вопросы колонкой справа — с lg. */}
          <div className="hidden w-64 shrink-0 space-y-2 border-l p-3 lg:block">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Скрипты LS

/** Карточка скрипта: тёмная шапка, сообщения в «колодцах», подвал. */
export function ScriptCardSkeleton({ messages = 1 }: { messages?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center gap-2 bg-sidebar px-4 py-3">
        <Skeleton className="h-5 w-56 max-w-[60%] bg-white/15" />
        <Skeleton className="h-5 w-14 rounded-full bg-white/10" />
        <Skeleton className="ml-auto h-8 w-8 bg-white/10 sm:w-48" />
      </div>
      <div className="space-y-4 px-4 py-3">
        {Array.from({ length: messages }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-32" />
            </div>
            <div className="space-y-2 rounded-md bg-canvas px-4 py-3">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-2">
        <Skeleton className="h-3 w-40" />
      </div>
    </div>
  );
}

/**
 * Список скриптов, пока грузится дерево: в «Все скрипты» — по разделам
 * (заголовок + счётчик + карточки), в разделе — просто карточки.
 */
export function ScriptsListSkeleton({ grouped }: { grouped: boolean }) {
  if (!grouped)
    return (
      <div className="space-y-3">
        <ScriptCardSkeleton messages={2} />
        <ScriptCardSkeleton />
        <ScriptCardSkeleton />
      </div>
    );
  return (
    <>
      {[2, 1].map((cards, i) => (
        <section key={i} className="space-y-3">
          <div className="flex items-center gap-2 pt-2">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-5 w-7 rounded-full" />
          </div>
          {Array.from({ length: cards }, (_, j) => (
            <ScriptCardSkeleton key={j} messages={j === 0 ? 2 : 1} />
          ))}
        </section>
      ))}
    </>
  );
}

/** Закреплённая панель поиска и языков — как в scripts-page.tsx. */
function ScriptsToolbarSkeleton() {
  return (
    <div className="sticky -top-3 z-20 -mx-1 -mt-3 bg-canvas px-1 pt-3 pb-2 sm:-top-4 sm:-mt-4 sm:pt-4 lg:-top-6 lg:-mt-6 lg:pt-6">
      <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
        <Skeleton className="toolbar-search h-10 w-full max-w-96" />
        <TabsSkeleton labels={["RU", "EN", "GE"]} />
      </div>
    </div>
  );
}

function ScriptsPageSkeleton({ grouped }: { grouped: boolean }) {
  return (
    <ShellSkeleton title={grouped ? "Все скрипты" : "Скрипты LS"}>
      <div className="max-w-4xl space-y-3">
        <ScriptsToolbarSkeleton />
        <Skeleton className="h-4 w-48" />
        <ScriptsListSkeleton grouped={grouped} />
      </div>
    </ShellSkeleton>
  );
}

export function ScriptsAllPageSkeleton() {
  return <ScriptsPageSkeleton grouped />;
}

export function ScriptsSectionPageSkeleton() {
  return <ScriptsPageSkeleton grouped={false} />;
}

/** Лента карточек «Хронологии» / «Предложений»: шапка, текст, поля. */
export function ScriptsFeedSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-3 rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="ml-auto h-3 w-32" />
          </div>
          <Skeleton className="h-3.5 w-3/4" />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Плитки статистики скриптов («Копирования», «Звонки»). */
export function ScriptsStatTilesSkeleton({ labels }: { labels: string[] }) {
  return (
    <div
      className={cn(
        "grid gap-3",
        labels.length === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2 lg:grid-cols-4",
      )}
    >
      {labels.map((label) => (
        <StatTileSkeleton key={label} label={label} />
      ))}
    </div>
  );
}

/** «Звонки» → «Сводка»: три плитки, воронка этапов, где заканчивают. */
export function CallStatsSummarySkeleton() {
  return (
    <div className="space-y-3">
      <ScriptsStatTilesSkeleton labels={CALL_TILES} />
      {[
        { title: "w-40", headers: ["#", "Этап", "Доля дошедших", "Дошли", "Закончились здесь"] },
        { title: "w-48", headers: ["Блок", "Доля", "Звонков", "%"] },
      ].map((t, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className={cn("h-6", t.title)} />
          <TableCardSkeleton headers={t.headers} rows={4} />
        </div>
      ))}
    </div>
  );
}

/** «Подстановка»: три блока настроек с сеткой полей. */
export function ScriptsSubstitutionSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-full max-w-xl" />
      {[2, 3, 2].map((rows, i) => (
        <div key={i} className="space-y-4 rounded-lg border bg-background p-4 sm:p-6">
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
          {Array.from({ length: rows }, (_, j) => (
            <div
              key={j}
              className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(10rem,14rem)_repeat(3,minmax(0,1fr))_2rem] md:items-center"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <span />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Вкладки «Настроек скриптов» — подписи статичные, как в settings.tsx. */
const SCRIPTS_SETTINGS_TABS = [
  { key: "history", label: "Хронология" },
  { key: "suggestions", label: "Предложения" },
  { key: "stats", label: "Статистика" },
  { key: "calls", label: "Звонки" },
  { key: "vars", label: "Подстановка" },
];

const PERIOD_TABS = ["Сегодня", "7 дней", "30 дней", "Всё время"];

/** Фильтр периода статистики: вкладки + две даты. */
function PeriodFilterSkeleton() {
  return (
    <>
      {/* По умолчанию у статистики — «30 дней». */}
      <TabsSkeleton labels={PERIOD_TABS} active={2} className="toolbar-full" />
      <Skeleton className="h-10 w-40" />
      <Skeleton className="h-10 w-40" />
    </>
  );
}

/** «Статистика» (копирования): фильтры, четыре плитки, таблица скриптов. */
export function CopyStatsSkeleton() {
  return (
    <div className="space-y-3">
      <ToolbarSkeleton search={false}>
        <PeriodFilterSkeleton />
        <Skeleton className="h-10 w-48" />
        <TabsSkeleton labels={["Все языки", "RU", "EN", "GE"]} className="toolbar-full" />
      </ToolbarSkeleton>
      <ScriptsStatTilesSkeleton
        labels={["Копирований", "RU · русский", "EN · английский", "GE · грузинский"]}
      />
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Скрипты</h2>
        <TableCardSkeleton
          rows={5}
          headers={[
            { label: "#", className: "w-12" },
            "Скрипт",
            { label: "Доля", className: "w-40" },
            "Всего",
            "RU",
            "EN",
            "GE",
          ]}
        />
      </div>
    </div>
  );
}

const CALL_TILES = ["Звонков за период", "Дошли до конца сценария", "Шагов сценария в среднем"];

/** «Звонки»: фильтр периода, «Сводка / Звонки» и сводка. */
export function CallStatsSkeleton() {
  return (
    <div className="space-y-3">
      <ToolbarSkeleton search={false}>
        <PeriodFilterSkeleton />
        <TabsSkeleton labels={["Сводка", "Звонки"]} className="toolbar-full sm:ml-auto" />
      </ToolbarSkeleton>
      <Skeleton className="h-4 w-80 max-w-full" />
      <CallStatsSummarySkeleton />
    </div>
  );
}

/** Тело «Настроек скриптов» для вкладки `tab` (из адреса, ?tab=). */
export function ScriptsSettingsBodySkeleton({ tab = "history" }: { tab?: string }) {
  const known = SCRIPTS_SETTINGS_TABS.some((t) => t.key === tab) ? tab : "history";
  return (
    <div className="space-y-3">
      <ToolbarSkeleton search={false}>
        <TabsSkeleton
          labels={SCRIPTS_SETTINGS_TABS.map((t) => t.label)}
          active={SCRIPTS_SETTINGS_TABS.findIndex((t) => t.key === known)}
          className="toolbar-full max-w-full overflow-x-auto"
        />
      </ToolbarSkeleton>
      {known === "stats" ? (
        <CopyStatsSkeleton />
      ) : known === "calls" ? (
        <CallStatsSkeleton />
      ) : known === "vars" ? (
        <ScriptsSubstitutionSkeleton />
      ) : (
        <ScriptsFeedSkeleton />
      )}
    </div>
  );
}

export function ScriptsSettingsPageSkeleton() {
  const tab = useRouterState({
    select: (s) => (s.location.search as { tab?: string }).tab,
  });
  return (
    <ShellSkeleton title="Настройки скриптов">
      <ScriptsSettingsBodySkeleton tab={tab} />
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// База знаний

/** «Базы знаний» (/kb): список баз. */
export function KbBasesPageSkeleton() {
  return (
    <ShellSkeleton title="Базы знаний">
      <div className="mx-auto max-w-3xl space-y-3">
        <ul className="divide-y rounded-lg border bg-background">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48 max-w-[60%]" />
                <Skeleton className="h-3.5 w-72 max-w-[80%]" />
              </div>
            </li>
          ))}
        </ul>
        {/* «Место» — KbStorageCard. */}
        <section className="rounded-lg border bg-background p-4">
          <h2 className="mb-3 text-sm font-semibold">Место</h2>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-full" />
        </section>
      </div>
    </ShellSkeleton>
  );
}

/** Шапка папки или статьи: крошки-надзаголовок, заголовок, строка «Обновлено». */
function KbHeadSkeleton({ meta = true }: { meta?: boolean }) {
  return (
    <div className="pt-2 pb-5 sm:pb-6">
      <Skeleton className="mb-2 h-4 w-56 max-w-[70%]" />
      <Skeleton className="h-8 w-80 max-w-[85%]" />
      {meta && <Skeleton className="mt-3 h-4 w-60 max-w-[70%]" />}
    </div>
  );
}

/** Главная базы и папка: шапка и список вложенного. */
export function KbFolderBodySkeleton() {
  return (
    <div className="mx-auto max-w-3xl">
      <KbHeadSkeleton meta={false} />
      <ul className="divide-y rounded-lg border bg-background">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-5 rounded" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-3.5 w-20" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Статья: шапка, текст и оглавление справа (с xl). */
export function KbArticleBodySkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      <div className="min-w-0 max-w-3xl flex-1">
        <div className="px-5 py-5 sm:px-10 sm:py-8">
          <Skeleton className="mb-2 h-4 w-56 max-w-[70%]" />
          <Skeleton className="h-8 w-96 max-w-[85%]" />
          <Skeleton className="mt-3 h-4 w-64 max-w-[70%]" />
          <div className="mt-8 space-y-3">
            {["w-full", "w-11/12", "w-4/5", "w-full", "w-2/3", "w-10/12", "w-3/4"].map((w, i) => (
              <Skeleton key={i} className={cn("h-4", w)} />
            ))}
          </div>
        </div>
      </div>
      <div className="hidden w-56 shrink-0 space-y-2 pt-9 xl:block">
        <Skeleton className="h-4 w-24" />
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" />
        ))}
      </div>
    </div>
  );
}

/** Страница базы, папки или статьи: что именно — станет ясно из дерева. */
export function KbNodePageSkeleton() {
  return (
    <ShellSkeleton title="База знаний" kb>
      <KbFolderBodySkeleton />
    </ShellSkeleton>
  );
}

/** Аналитика базы: заголовок, вкладки и период, плитки, полоса чтения, график. */
export function KbAnalyticsPageSkeleton() {
  return (
    <ShellSkeleton title="Аналитика" kb="tool">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="px-1 pb-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-1.5 h-7 w-44" />
        </div>
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="toolbar-full h-10 w-96 max-w-full rounded-full" />
          <Skeleton className="toolbar-full h-10 w-64 rounded-full sm:ml-auto" />
        </div>
        <DashboardStatsSkeleton
          labels={[
            "Прочитано",
            "Читатели",
            "Открытия статей",
            "Время чтения",
            "Дочитали до конца",
            "Поиск без ответа",
          ]}
          className="lg:grid-cols-3 2xl:grid-cols-6"
        />
        <DashboardChartSkeleton title="Прочитано по базе" height={40} />
        <DashboardChartSkeleton title="Активность по дням" height={260} />
      </div>
    </ShellSkeleton>
  );
}

export function KbTemplatesPageSkeleton() {
  return (
    <TablePage
      kb="tool"
      title="Шаблоны"
      toolbar={null}
      pagination={false}
      headers={["Шаблон", "Обновлён", ""]}
      rows={4}
    />
  );
}

export function KbTrashPageSkeleton() {
  return (
    <TablePage
      kb="tool"
      title="Корзина"
      toolbar={null}
      pagination={false}
      headers={["Что удалено", "Удалил", "Удалится навсегда", ""]}
      rows={4}
    />
  );
}

// ---------------------------------------------------------------------------
// Академия (шапка без поиска клиента — ShellSkeleton network)

/** Шапка курса: обложка, название, описание, полоса хода. */
function AcademyCourseHeadSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-background p-4 sm:flex-row sm:p-5">
      <Skeleton className="aspect-[16/9] w-full shrink-0 self-start rounded-md sm:w-56" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-6 w-72 max-w-[80%]" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="mt-3 h-1.5 w-full max-w-md" />
      </div>
    </div>
  );
}

export function AcademyMyPageSkeleton() {
  return (
    <ShellSkeleton title="Мои курсы" network>
      <div className="mx-auto max-w-5xl space-y-3">
        <Skeleton className="h-4 w-32" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-lg border bg-background">
              <Skeleton className="aspect-[16/9] w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="mt-4 h-1.5 w-full" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AcademyCoursePageSkeleton() {
  return (
    <ShellSkeleton title="Курс" network>
      <div className="mx-auto max-w-6xl space-y-4">
        <AcademyCourseHeadSkeleton />
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="space-y-1 rounded-lg border bg-background p-2 lg:w-72">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
          <div className="flex-1 space-y-3 rounded-lg border bg-background p-6">
            <Skeleton className="h-6 w-60" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </div>
    </ShellSkeleton>
  );
}

function AcademyAttemptSkeleton({ title }: { title: string }) {
  return (
    <ShellSkeleton title={title} network>
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="space-y-3 rounded-lg border bg-background p-5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-lg border bg-background p-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </ShellSkeleton>
  );
}

export function AcademyAttemptPageSkeleton() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AcademyAttemptSkeleton
      title={pathname.startsWith("/academy/review") ? "Проверка ответов" : "Результат теста"}
    />
  );
}

export function AcademyReviewPageSkeleton() {
  return (
    <ShellSkeleton title="Проверка ответов" network>
      <div className="mx-auto max-w-5xl">
        <TableCardSkeleton
          headers={["Сотрудник", "Курс и тест", "Свободных ответов", "Отправлено"]}
          rows={4}
          pagination={false}
        />
      </div>
    </ShellSkeleton>
  );
}

export function AcademyCoursesPageSkeleton() {
  return (
    <ShellSkeleton title="Курсы" network actions={["w-36"]}>
      <div className="mx-auto max-w-5xl space-y-4">
        <ToolbarSkeleton search controls={["w-80"]} />
        <Skeleton className="h-4 w-28" />
        <ul className="divide-y rounded-lg border bg-background">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="aspect-[16/9] w-28 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-60 max-w-[70%]" />
                <Skeleton className="h-3 w-32" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </ShellSkeleton>
  );
}

export function AcademyBuilderPageSkeleton() {
  return (
    <ShellSkeleton title="Курс" network>
      <div className="mx-auto max-w-5xl space-y-4">
        <AcademyCourseHeadSkeleton />
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <div className="toolbar-full inline-flex h-10 items-center gap-1 rounded-full bg-muted p-1">
            {["Содержание", "Ученики", "Ошибки"].map((t) => (
              <span key={t} className="px-3 text-sm text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </div>
        <ul className="divide-y rounded-lg border bg-background">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="size-4 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-64 max-w-[70%]" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </ShellSkeleton>
  );
}

export function AcademyStepPageSkeleton() {
  return (
    <ShellSkeleton title="Шаг курса" network>
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-3.5 w-40" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="min-h-80 space-y-3 rounded-lg border bg-background p-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AcademyReportPageSkeleton() {
  return (
    <ShellSkeleton title="Отчёт по обучению" network>
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="table-toolbar flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <div className="toolbar-full inline-flex h-10 items-center gap-1 rounded-full bg-muted p-1">
            {["Курсы", "Сотрудники"].map((t) => (
              <span key={t} className="px-3 text-sm text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </div>
        <TableCardSkeleton
          headers={[
            "Курс",
            "Учеников",
            "Прошли",
            "Проходят / не начали",
            "На проверке",
            "Просрочено",
          ]}
          rows={4}
          pagination={false}
        />
      </div>
    </ShellSkeleton>
  );
}

export function AcademySettingsPageSkeleton() {
  return (
    <ShellSkeleton title="Настройки Академии" network>
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="space-y-2">
          <h2 className="font-semibold">Папки курсов</h2>
          <ul className="divide-y rounded-lg border bg-background">
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="flex items-center gap-2 px-3 py-2.5">
                <Skeleton className="h-4 w-40" />
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-2">
          <h2 className="font-semibold">Кто ведёт обучение</h2>
          <Skeleton className="h-4 w-full" />
        </section>
      </div>
    </ShellSkeleton>
  );
}

// ---------------------------------------------------------------------------
// «Аналитика» (перенос портала аналитики Lady Stretch, ANALYTICS_PLAN.md)

/** Шапка главной «Аналитики» (как у их главной) и карточки под ней. */
export function AnalyticsHomeBody({
  greeting,
  children,
}: {
  /** null — имя ещё не загружено. */
  greeting: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-background p-5">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {AN_HOME_TEXT.eyebrow}
        </div>
        {greeting === null ? (
          <Skeleton className="mt-1 h-7 w-64" />
        ) : (
          <h2 className="mt-1 text-xl font-semibold">{greeting}</h2>
        )}
        <p className="mt-1 text-sm text-muted-foreground">{AN_HOME_TEXT.lead}</p>
      </section>
      {children}
    </div>
  );
}

export function AnalyticsHomePageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.home} network>
      <AnalyticsHomeBody greeting={null}>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="min-h-28 space-y-2 rounded-lg border bg-background p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      </AnalyticsHomeBody>
    </ShellSkeleton>
  );
}

/** Плашка фильтров доски 1С: поля заданной ширины (пилюли — rounded-full). */
function OnecToolbarSkeleton({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 rounded-lg border bg-background p-2 sm:px-3">
      {items.map((cls, i) => (
        <Skeleton key={i} className={cn("h-9", cls)} />
      ))}
    </div>
  );
}

function OnecTilesSkeleton({ count, grid }: { count: number; grid: string }) {
  return (
    <div className={cn("grid gap-3", grid)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24 rounded-lg" />
      ))}
    </div>
  );
}

/**
 * Тело доски 1С, пока считаются данные: раскладка своей доски (их блоки по
 * порядку) — и в скелетоне страницы, и в рамке отчёта.
 */
export function OnecBoardBodySkeleton({ board }: { board: OnecBoard }) {
  const table = <Skeleton className="h-96 w-full rounded-lg" />;
  switch (board) {
    case "revenue":
      return (
        <div className="space-y-4">
          <OnecTilesSkeleton count={6} grid="grid-cols-2 md:grid-cols-3 2xl:grid-cols-6" />
          <OnecToolbarSkeleton
            items={["w-full sm:w-72", "w-48", ...Array<string>(6).fill("w-32 rounded-full")]}
          />
          {table}
        </div>
      );
    case "sales":
      return (
        <div className="space-y-4">
          <OnecTilesSkeleton count={6} grid="grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" />
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_1.6fr]">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-56 rounded-lg" />
            ))}
          </div>
          <OnecToolbarSkeleton items={["w-full sm:w-72", "w-48", "w-48"]} />
          {table}
        </div>
      );
    case "activities":
      return (
        <div className="space-y-4">
          <OnecToolbarSkeleton items={["w-48", "w-48", "w-48", "w-48"]} />
          <OnecTilesSkeleton count={6} grid="sm:grid-cols-2 lg:grid-cols-3" />
          {table}
        </div>
      );
    case "funnel":
      return (
        <div className="space-y-4">
          <OnecToolbarSkeleton items={["w-48", "w-48", "w-48", "w-48"]} />
          <OnecTilesSkeleton count={8} grid="grid-cols-2 xl:grid-cols-4" />
          {table}
        </div>
      );
    case "zero":
      return (
        <div className="space-y-4">
          <Skeleton className="h-3 w-56" />
          <OnecToolbarSkeleton items={["w-full sm:w-72", "w-48", "w-48"]} />
          <OnecTilesSkeleton count={4} grid="grid-cols-2 lg:grid-cols-4" />
          {table}
        </div>
      );
    case "partner":
      return (
        <div className="space-y-4">
          <OnecToolbarSkeleton items={["w-48", "w-48", "w-44 rounded-full"]} />
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-3 w-80 max-w-full" />
          </div>
          <OnecTilesSkeleton count={4} grid="grid-cols-2 lg:grid-cols-4" />
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Skeleton className="h-56 rounded-lg" />
            <Skeleton className="h-56 rounded-lg" />
          </div>
        </div>
      );
  }
}

/** Страница отчёта 1С: плашка периода (у части досок — без «С начала …»), подпись, доска. */
function OnecReportPageSkeleton({ board }: { board: OnecBoard }) {
  return (
    <ShellSkeleton title={BOARD_NAMES[board]} network>
      <div className="space-y-4">
        <OnecToolbarSkeleton
          items={
            ONEC_BOARD_PRESETS[board]
              ? ["w-56", "w-36 rounded-full", "w-40 rounded-full", "w-32 rounded-full"]
              : ["w-56"]
          }
        />
        <Skeleton className="h-3 w-96 max-w-full" />
        <OnecBoardBodySkeleton board={board} />
      </div>
    </ShellSkeleton>
  );
}
export const AnalyticsOnecRevenuePageSkeleton = () => <OnecReportPageSkeleton board="revenue" />;
export const AnalyticsOnecSalesPageSkeleton = () => <OnecReportPageSkeleton board="sales" />;
export const AnalyticsOnecActivitiesPageSkeleton = () => (
  <OnecReportPageSkeleton board="activities" />
);
export const AnalyticsOnecFunnelPageSkeleton = () => <OnecReportPageSkeleton board="funnel" />;
export const AnalyticsOnecZeroPageSkeleton = () => <OnecReportPageSkeleton board="zero" />;
export const AnalyticsOnecMycityPageSkeleton = () => <OnecReportPageSkeleton board="partner" />;

/** «Обработка 1С»: табы на плашке, окно обработки, папки выгрузок. */
export function AnalyticsOnecPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.onec} network>
      <div className="space-y-4">
        <div className="rounded-lg border bg-background p-2">
          <Skeleton className="h-9 w-80 max-w-full rounded-full" />
        </div>
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-9 w-32 rounded-full" />
              <Skeleton className="h-9 w-44 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-3 rounded-lg border bg-background p-4">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-64 max-w-full" />
              <Skeleton className="h-4 w-56" />
            </div>
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsPartnersPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.partners} network>
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-lg" />
        <TableCardSkeleton
          headers={["Партнёр", "Города", "Доступ к отчётам", "Статус", ""]}
          rows={5}
          pagination
        />
      </div>
    </ShellSkeleton>
  );
}

/** Карточка партнёра под ссылкой «К списку партнёров»: реквизиты, города. */
export function AnalyticsPartnerBodySkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full rounded-lg" />
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }, (_, i) => (
            <FieldSkeleton key={i} />
          ))}
        </div>
      </div>
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <Skeleton className="h-6 w-64" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-72 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPartnerPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.partner} network>
      <div className="max-w-5xl space-y-4">
        <Skeleton className="h-5 w-40" />
        <AnalyticsPartnerBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsActivityPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.activity} network>
      <div className="space-y-3">
        <ToolbarSkeleton search={false} controls={["w-64"]} />
        <Skeleton className="h-4 w-full max-w-xl" />
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTileSkeleton label="Визитов за период" />
          <StatTileSkeleton label="Активное время команды" />
          <StatTileSkeleton label="Не заходили" />
        </div>
        <TableCardSkeleton
          headers={[
            "Пользователь",
            "Визиты",
            "Активное время",
            "Просмотры",
            "Дашборды",
            "Последняя активность",
            "Статус",
          ]}
          rows={8}
          pagination
        />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsJournalPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.journal} network>
      <div className="space-y-3">
        <Skeleton className="h-12 w-full rounded-lg" />
        <TableCardSkeleton
          headers={["Когда", "Пользователь", "Действие", "Детали"]}
          rows={10}
          pagination
        />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsApiPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.api} network>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <TableCardSkeleton
          headers={[
            "Название",
            "Действует",
            "Создан",
            "Последнее использование",
            "Запросов за 30 дней",
          ]}
          rows={2}
          title="Ключи"
        />
        <TableCardSkeleton
          headers={["Когда", "Ключ", "Запрос", "Ответ", "Размер"]}
          rows={4}
          title="Последние запросы"
        />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsExcelCleanerPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.excelCleaner} network>
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="space-y-4 rounded-lg border bg-background p-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-36 rounded-full" />
            <Skeleton className="h-9 w-40 rounded-full" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsTop10PageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.top10} network>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="flex gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="h-9 w-44 rounded-md" />
          <Skeleton className="h-9 w-44 rounded-md" />
          <Skeleton className="ml-auto h-9 w-36 rounded-full" />
        </div>
        <Skeleton className="h-9 w-72 max-w-full rounded-full" />
        <div className="grid gap-4 xl:grid-cols-2">
          {[
            "Покупка в день пробного",
            "Покупка за 14 дней",
            "Топ по продлениям",
            "Топ по возвращённым",
          ].map((title) => (
            <TableCardSkeleton
              key={title}
              title={title}
              headers={["Место", "Город", "", "", ""]}
              rows={10}
            />
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

/** Отзыв клиента или партнёра — карточка с аватаркой, текстом и подписями. */
function ReviewCardSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-6 w-14 rounded-full" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <div className="grid grid-cols-3 gap-2 border-t pt-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function AnalyticsReviewsBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 rounded-lg border bg-background p-4 md:grid-cols-[1fr_1.5fr_1fr]">
        <div className="space-y-2">
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-44" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <TableCardSkeleton
        title="Статистика по тренерам"
        headers={["Тренер", "Оценок", "Средняя", "≤ 3", "Комментариев"]}
        rows={5}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <ReviewCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function AnalyticsReviewsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.reviews} network>
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-9 w-56 rounded-md" />
        </div>
        <AnalyticsReviewsBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsReviewsUploadPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.reviewsUpload} network>
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-36 rounded-full" />
            <Skeleton className="h-9 w-44 rounded-full" />
          </div>
        </div>
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-3 border-t pt-3">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsStaffLinksPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.staffLinks} network>
      <div className="space-y-3">
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="flex gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="h-9 w-72 max-w-full rounded-md" />
          <Skeleton className="h-9 w-48 rounded-md" />
        </div>
        <TableCardSkeleton headers={["Сотрудник", "Ссылка", ""]} rows={8} />
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsStaffStatsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.staffStats} network>
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg border bg-background p-2 sm:px-3">
          <Skeleton className="h-9 w-72 max-w-full rounded-md" />
          <Skeleton className="h-9 w-56 rounded-md" />
        </div>
        <TableCardSkeleton
          title="Статистика сотрудников"
          headers={["Сотрудник", "Ответов", "Вопрос 1", "Вопрос 2", "NPS", "Рекомендаций"]}
          rows={4}
        />
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <ReviewCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

/** Публичная форма отзыва о сотруднике — без каркаса портала. */
export function AnalyticsFeedbackPageSkeleton() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="w-full max-w-xl space-y-5 rounded-xl border bg-background p-6 sm:p-8">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-48" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        ))}
        <Skeleton className="mx-auto h-10 w-32 rounded-full" />
      </div>
    </div>
  );
}

/** «VK Ads» → «Рекламные кабинеты»: пояснение, фильтры, таблица кабинетов. */
export function AnalyticsVkAccountsPageSkeleton() {
  return (
    <TablePage
      title={AN_TITLES.vkAccounts}
      network
      actions={["w-40"]}
      toolbar={{ search: true, controls: ["w-48", "w-48"] }}
      headers={["Кабинет", "Город и партнёр", "Остаток", "Обновлён", "Ключ", "Статус", ""]}
      pagination={false}
      rows={10}
    />
  );
}

/** «VK Ads» → «Расходы по кабинетам»: дата, четыре плитки, таблица. */
export function AnalyticsVkSpendPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkSpend} network>
      <div className="space-y-4">
        <ToolbarSkeleton search={false} controls={["w-48"]} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTileSkeleton label="Всего за день" />
          <StatTileSkeleton label="Расход ЛФ" />
          <StatTileSkeleton label="Расход СС — остаток после ЛФ" />
          <StatTileSkeleton label="Кабинетов с данными" />
        </div>
        <TableCardSkeleton
          title="Все рекламные кабинеты"
          headers={[
            "Кабинет",
            "Город",
            "Партнёр",
            "Всего",
            "ЛФ",
            "СС (остаток)",
            "Кампаний",
            "Обновлено",
            "Статус",
          ]}
          rows={10}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «VK Ads» → «Реестр таргета»: пояснение, фильтры, три плашки, города. */
export function AnalyticsVkRegisterPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkRegister} network>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <ToolbarSkeleton search={false} controls={["w-56", "w-48"]} />
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </ShellSkeleton>
  );
}

/** «VK Ads» → «Планы таргета»: месяц, планы месяца, история. */
export function AnalyticsVkPlansPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkPlans} network>
      <div className="space-y-4">
        <ToolbarSkeleton search={false} controls={["w-44"]} />
        <TableCardSkeleton
          title="Планы месяца"
          headers={["Бренд", "Город", "Заявки и целевой CPL", "Плановый бюджет"]}
          rows={8}
        />
        <TableCardSkeleton
          title="История корректировок"
          headers={[
            "Бренд",
            "Город",
            "Было заявок",
            "Был CPL",
            "Стало заявок",
            "Стал CPL",
            "Администратор",
            "Когда",
          ]}
          rows={4}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «VK Ads» → «Таргетологи»: пояснение, назначения. */
export function AnalyticsVkTargetologistsPageSkeleton() {
  return (
    <TablePage
      title={AN_TITLES.vkTargetologists}
      network
      actions={["w-44"]}
      toolbar={{ search: true, controls: [] }}
      headers={["Бренд", "Город", "Таргетолог", ""]}
      pagination={false}
      rows={8}
    />
  );
}

/** «VK Ads» → «Сбор лид-форм»: подключение Drive, создание таблиц, таблицы. */
export function AnalyticsVkLeadFormsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkLeadForms} network>
      <div className="max-w-5xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-44 w-full rounded-lg" />
        <TableCardSkeleton
          title="Подключённые таблицы"
          headers={["Город", "Кабинет", "Таблица", "Старт сбора", "Заявки"]}
          rows={6}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «CRM» → «Интеграция amoCRM»: форма подключения, список подключений. */
export function AnalyticsAmoPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.amo} network>
      <div className="max-w-5xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <TableCardSkeleton
          title="Подключения amoCRM"
          headers={["Подключение", "Статус", ""]}
          rows={3}
        />
      </div>
    </ShellSkeleton>
  );
}

/** Подключение amoCRM: токен, справочники, ответственные, правила, квалификация, сбор. */
export function AnalyticsAmoConnectionBodySkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-28 w-full rounded-lg" />
      <TableCardSkeleton
        title="Ответственные amoCRM → города и партнёры"
        headers={["Ответственный", "Направление", "Город", "Партнёр", ""]}
        rows={3}
      />
      <Skeleton className="h-72 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}

export function AnalyticsAmoConnectionPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.amoConnection} network>
      <div className="max-w-5xl space-y-4">
        <Skeleton className="h-5 w-48" />
        <AnalyticsAmoConnectionBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** «Маркетинг Lady Stretch / Lady Jump»: пять плиток, блоки городов. */
export function AnalyticsMktBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
      <Skeleton className="h-56 rounded-lg" />
    </div>
  );
}

function AnalyticsMktPageSkeleton({ title }: { title: string }) {
  return (
    <ShellSkeleton title={title} network>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <ToolbarSkeleton search={false} controls={["w-36", "w-56", "w-56", "w-80"]} />
        <Skeleton className="h-4 w-full max-w-xl" />
        <AnalyticsMktBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

export const AnalyticsMktStretchPageSkeleton = () => (
  <AnalyticsMktPageSkeleton title={AN_TITLES.mktStretch} />
);
export const AnalyticsMktJumpPageSkeleton = () => (
  <AnalyticsMktPageSkeleton title={AN_TITLES.mktJump} />
);

/** «Авито» → «Кабинеты Авито»: пояснение и таблица кабинетов. */
export function AnalyticsAvitoAccountsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.avitoAccounts} network>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <TableCardSkeleton
          title="Подключённые кабинеты"
          headers={["Кабинет", "Направление", "Город", "API", "Структура", "Статистика", ""]}
          rows={4}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «Авито» → «Планы Авито»: месяц и планы городов. */
export function AnalyticsAvitoPlansPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.avitoPlans} network>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <ToolbarSkeleton search={false} controls={["w-44"]} />
        <TableCardSkeleton
          title="Планы на месяц"
          headers={["Город", "План заявок и CPL", "Плановый бюджет"]}
          rows={6}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «Реестр Авито»: три плитки и города. */
export function AnalyticsAvitoRegisterBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}

export function AnalyticsAvitoRegisterPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.avitoRegister} network>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <ToolbarSkeleton search={false} controls={["w-56"]} />
        <AnalyticsAvitoRegisterBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** «CRM» → «Интеграция FitBase»: пояснение, загрузка всех студий, карточки студий. */
export function AnalyticsFitbasePageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.fitbase} network actions={["w-44"]}>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-6 w-56" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-lg" />
          ))}
        </div>
      </div>
    </ShellSkeleton>
  );
}

/** «Интеграция FitBase» → студия: карточка, проверка, правила, посещаемость. */
export function AnalyticsFitbaseConnectionPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.fitbaseConnection} network>
      <div className="max-w-5xl space-y-4">
        <Skeleton className="h-9 w-32 rounded-full" />
        <Skeleton className="h-44 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </ShellSkeleton>
  );
}

/** «FitBase» → «Выручка по городам»: шесть плиток, кнопки, таблица городов. */
export function AnalyticsFbRevenueBodySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}

export function AnalyticsFbRevenuePageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.fbRevenue} network>
      <div className="space-y-4">
        <Skeleton className="h-5 w-80 max-w-full" />
        <ToolbarSkeleton controls={["w-48", "w-40", "w-40"]} />
        <AnalyticsFbRevenueBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** «FitBase» → «Продажи абонементов»: плитки, средние чеки, графики, таблица. */
export function AnalyticsFbSalesBodySkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-64" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-52 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}

export function AnalyticsFbSalesPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.fbSales} network>
      <div className="space-y-4">
        <ToolbarSkeleton controls={["w-56", "w-44", "w-48", "w-44"]} />
        <AnalyticsFbSalesBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** «FitBase» → «Маркетинговый отчёт»: карточки городов. */
export function AnalyticsFbMarketingBodySkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-80 rounded-lg" />
      ))}
    </div>
  );
}

export function AnalyticsFbMarketingPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.fbMarketing} network>
      <div className="space-y-4">
        <ToolbarSkeleton search={false} controls={["w-56", "w-44", "w-48"]} />
        <AnalyticsFbMarketingBodySkeleton />
      </div>
    </ShellSkeleton>
  );
}

/** «Квиз» → «Квиз-лендинги»: пояснение, четыре плитки, города. */
export function AnalyticsQuizPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.quiz} network actions={["w-36"]}>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton
              key={i}
              className={i === 3 ? "col-span-2 h-20 rounded-lg lg:col-span-1" : "h-20 rounded-lg"}
            />
          ))}
        </div>
        <TableCardSkeleton
          title="Города лендинга"
          headers={["Город", "Ссылка", "Пробное", "Студии", "Google-таблица", "Заявки", ""]}
          rows={4}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «Квиз» → «Заявки квиза»: пояснение, город и состояние, заявки. */
export function AnalyticsQuizLeadsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.quizLeads} network>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <ToolbarSkeleton search={false} controls={["w-52", "w-80"]} />
        <TableCardSkeleton
          headers={[
            "Дата и время",
            "Город",
            "Имя и телефон",
            "Рекомендация",
            "Ответы",
            "UTM",
            "Таблица",
            "",
          ]}
          rows={8}
          pagination
        />
      </div>
    </ShellSkeleton>
  );
}

/**
 * Квиз-лендинг (без каркаса портала): белая колонка на сиреневом, как их
 * лендинг, — заголовок, плитки результатов, кнопка.
 */
export function QuizLandingSkeleton() {
  return (
    <div className="min-h-dvh bg-[#f4eff8] sm:p-5">
      <div className="mx-auto flex min-h-dvh w-full max-w-[620px] flex-col justify-center gap-4 bg-white px-6 py-8 sm:min-h-[calc(100dvh-40px)] sm:rounded-3xl sm:px-13">
        <Skeleton className="h-4 w-40 bg-[#eee1fa]" />
        <Skeleton className="h-24 w-full bg-[#eee1fa]" />
        <Skeleton className="h-12 w-4/5 bg-[#eee1fa]" />
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl bg-[#e6d8f3]" />
          ))}
        </div>
        <Skeleton className="h-12 w-full bg-[#eee1fa]" />
        <Skeleton className="h-14 w-full rounded-2xl bg-[#d9bff2]" />
      </div>
    </div>
  );
}

/** «VK Ads» → «Контроль бюджетов»: бот, каналы, плитки порогов, кабинеты. */
export function AnalyticsVkAlertsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkAlerts} network>
      <div className="max-w-6xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
        <TableCardSkeleton
          title="Кабинеты, требующие внимания"
          headers={[
            "Кабинет",
            "Уровень",
            "Остаток",
            "Средние траты/день",
            "Хватит на",
            "Рекомендуем пополнить",
          ]}
          rows={5}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «VK Ads» → «Источники СС»: ключ Google, источники. */
export function AnalyticsVkSourcesPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkSources} network>
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <TableCardSkeleton
          title="Подключённые источники"
          headers={["Бренд", "Город", "Лиды СС", "Заявки СС", ""]}
          rows={6}
        />
      </div>
    </ShellSkeleton>
  );
}

/** «Инструменты» → «Обслуживание VK Ads»: карточки действий. */
export function AnalyticsVkToolsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.vkTools} network>
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <Skeleton className="h-5 w-72 max-w-full" />
          <Skeleton className="h-4 w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-40 rounded-full" />
            <Skeleton className="h-9 w-40 rounded-full" />
          </div>
        </div>
      </div>
    </ShellSkeleton>
  );
}

export function AnalyticsJobsPageSkeleton() {
  return (
    <ShellSkeleton title={AN_TITLES.jobs} network>
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <TableCardSkeleton
          headers={["Задача", "Включена", "Последний запуск", "Итог", ""]}
          rows={3}
          pagination={false}
        />
      </div>
    </ShellSkeleton>
  );
}
