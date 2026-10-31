import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Star } from "lucide-react";

import {
  Change,
  FunnelRows,
  MetricCard,
  MetricGrid,
  Panel,
  PanelValue,
  Section,
  Tone,
} from "@/components/analytics/onec/boards/mycity/parts";
import { SALE_ORIGIN_COLOR } from "@/components/dashboard/colors";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useTableSort } from "@/hooks/use-table-sort";
import { anCan } from "@/lib/analytics/access";
import {
  fbCityDirections,
  fbCityFmt,
  fbCityPct,
  fbCityPercent,
  fbCityProducts,
  fbCityRub,
  fbMyCitySummary,
  type FbCityDirection,
  type FbCityProduct,
  type FbCitySummary,
  type FbMyCityPayload,
  type FbMyCityTrialRow,
} from "@/lib/analytics/fitbase/mycity";
import { label as monthLabel } from "@/lib/analytics/onec-reports/payload";
import {
  DIRECTION_SORT,
  PRODUCT_SEGMENTS,
  TREND_CHART_HEIGHT,
  nextDirectionSort,
  trendLabel,
  type DirectionSort,
  type DirectionSortKey,
  type ProductSegment,
  type SalesTrend,
} from "@/lib/analytics/onec-reports/mycity";
import { cn } from "@/lib/utils";

const RevenueBars = lazy(() =>
  import("@/components/analytics/onec/boards/mycity/plots").then((m) => ({
    default: m.RevenueBars,
  })),
);
const SalesTrendPlot = lazy(() =>
  import("@/components/analytics/onec/boards/mycity/plots").then((m) => ({
    default: m.SalesTrendPlot,
  })),
);

const CHART_COLOR = "var(--brand)";
const TREND_COLORS = { newSales: SALE_ORIGIN_COLOR.new, repeatSales: SALE_ORIGIN_COLOR.renewal };
const NUM = "text-right [&>span]:justify-end";

/** Их renderSalesTrend на значениях FitBase: пусто — точка на нуле, подпись «—». */
function trendOf(summary: FbCitySummary): SalesTrend {
  const points = summary.trend.map((t) => ({
    key: t.key,
    label: trendLabel(t.key),
    newSales: t.newSales ?? 0,
    repeatSales: t.repeatSales ?? 0,
    text: { newSales: fbCityFmt(t.newSales), repeatSales: fbCityFmt(t.repeatSales) },
  }));
  const maximum = Math.max(...points.flatMap((x) => [x.newSales, x.repeatSales]), 1);
  const ceiling = Math.max(2, Math.ceil(maximum / 2) * 2);
  return { points, ceiling, ticks: [0, 0.5, 1].map((f) => Math.round(ceiling * (1 - f))) };
}

/**
 * «Мой город · FitBase» — их fitbase_partner_view: доска «Мой город» 1С
 * (partner.html + partner-reference.js) на фактах FitBase выбранных студий:
 * итоги — их totals, конверсии — воронка FitBase, пусто — «—», заметки о
 * полноте данных внизу. Город и студия меняют отчёт целиком (страница
 * перезапрашивает данные).
 */
export function FitbaseCityBoard({
  payload,
  pending,
}: {
  payload: FbMyCityPayload;
  pending: boolean;
}) {
  const summary = useMemo(() => fbMyCitySummary(payload), [payload]);
  const trend = useMemo(() => trendOf(summary), [summary]);
  const canReviews = anCan(useAdminAccess()?.analytics, "reviews");
  const be = summary.breakEven;
  const city = payload.selectedCity;

  return (
    <div
      className={cn("space-y-6 transition-opacity", pending && "opacity-60")}
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl leading-tight font-semibold">{summary.title}</h2>
          <p className="text-sm text-muted-foreground">{summary.subtitle}</p>
          <p className="text-xs text-muted-foreground">Обновлено: {payload.generatedAt}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReviews && (
            <Button variant="outline" asChild>
              <Link
                to="/analytics/reviews"
                search={{ city: city || undefined, from: payload.start, to: payload.end }}
              >
                <Star />
                Оценки клиентов
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/analytics/crm/marketing/lady-jump">
              <ExternalLink />
              Маркетинговый отчет
            </Link>
          </Button>
        </div>
      </div>

      <MetricGrid>
        <MetricCard
          label="Выручка за период"
          value={summary.revenue}
          detail={
            summary.revenueDelta ? (
              <>
                <Change up={summary.revenueDelta.up}>{summary.revenueDelta.text}</Change> к прошлому
                месяцу
              </>
            ) : (
              "Нет периода для сравнения"
            )
          }
        />
        <MetricCard
          label="Продажи абонементов"
          value={summary.sales}
          detail={summary.newSalesDetail}
        />
        <MetricCard
          label="Доходимость на занятия"
          value={summary.attendance}
          detail={summary.attendanceDetail}
        />
        <MetricCard
          label="Конверсия пробных за 14 дней"
          value={summary.conversion}
          detail={summary.conversionDetail}
        />
      </MetricGrid>

      <Section title="Финансы" aside="Оплаты FitBase минус возвраты">
        <div className="grid gap-3 lg:grid-cols-[7fr_5fr]">
          <Panel title="Выручка по месяцам">
            <ChartBox height={180}>
              <RevenueBars
                bars={summary.revenueBars.map((b) => ({ ...b, label: monthLabel(b.period) }))}
                color={CHART_COLOR}
              />
            </ChartBox>
          </Panel>
          <Panel title="Точка 0 по городу">
            <PanelValue
              label="Цель Lady Stretch"
              value={be.value}
              detail={
                be.kind === "set" ? (
                  <>
                    Факт {be.above ? "выше" : "ниже"} точки 0 на{" "}
                    <Tone up={be.above}>{be.amount}</Tone>
                  </>
                ) : (
                  be.detail
                )
              }
            />
            <InfoNote className="mt-4">
              Точка 0 считается на уровне города и не распределяется по отдельным студиям.
            </InfoNote>
          </Panel>
        </div>
      </Section>

      <Section title="Продажи абонементов" aside="Продажи и оплаты по правилам FitBase">
        <MetricGrid>
          <MetricCard label="Новые продажи" value={summary.newSales} detail={summary.newPayments} />
          <MetricCard
            label="Продления"
            value={summary.repeatSales}
            detail={summary.repeatPayments}
          />
          <MetricCard
            label="Средний чек, новый"
            value={summary.newCheck}
            detail="Оплаты / новые продажи"
          />
          <MetricCard
            label="Средний чек, продление"
            value={summary.repeatCheck}
            detail="Оплаты / продления"
          />
        </MetricGrid>
        <Panel
          title="Динамика продаж"
          aside={
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <LegendDot color={TREND_COLORS.newSales}>Новые продажи</LegendDot>
              <LegendDot color={TREND_COLORS.repeatSales}>Продления</LegendDot>
            </div>
          }
        >
          {trend.points.length ? (
            <ChartBox
              height={TREND_CHART_HEIGHT}
              label="Динамика новых продаж и продлений за шесть месяцев"
            >
              <SalesTrendPlot trend={trend} colors={TREND_COLORS} />
            </ChartBox>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Нет данных за выбранный период
            </div>
          )}
        </Panel>
      </Section>

      <ProductsSection payload={payload} />

      <Section title="Занятия и посещаемость" aside="Только фактически проведённые занятия">
        <MetricGrid>
          <MetricCard label="Проведено занятий" value={summary.classes} />
          <MetricCard
            label="Клиентов записано"
            value={summary.booked}
            detail={summary.bookedRate}
          />
          <MetricCard
            label="Клиентов посетило"
            value={summary.attended}
            detail={summary.attendedRate}
          />
          <MetricCard
            label="Доходимость"
            value={summary.attendance}
            detail="Посетило / записалось"
          />
        </MetricGrid>
      </Section>

      <DirectionsSection payload={payload} />

      <Section title="Воронка пробных занятий" aside="Конверсия по подтверждённым окнам FitBase">
        <div className="grid gap-3 lg:grid-cols-[7fr_5fr]">
          <Panel title="Путь клиента за период">
            <FunnelRows steps={summary.funnel} color={CHART_COLOR} />
          </Panel>
          <Panel title="Ключевые конверсии">
            <div className="space-y-3">
              <PanelValue
                label="Доходимость до пробного"
                value={summary.trialAttendance}
                detail={summary.trialAttendanceDetail}
              />
              <Separator />
              <PanelValue
                label="Покупка в день пробного"
                value={summary.dayConversion}
                detail={summary.dayConversionDetail}
              />
              <Separator />
              <PanelValue
                label="Дожим после пробного"
                value={summary.laterConversion}
                detail="После дня пробного, в завершённых 14-дневных окнах"
              />
            </div>
          </Panel>
        </div>
      </Section>

      <Section title="Номенклатуры пробных занятий" aside="Запись → приход → покупка">
        <TrialProductsTable rows={payload.fitbase.trialProducts} />
      </Section>

      <Section title="Студии города" aside="Свод ключевых показателей за выбранный период">
        <StudiosTable rows={summary.studios} />
      </Section>

      <InfoNote className="space-y-1">
        {payload.fitbase.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </InfoNote>
    </div>
  );
}

function ChartBox({
  height,
  label,
  children,
}: {
  height: number;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ height }} role={label ? "img" : undefined} aria-label={label}>
      <Suspense fallback={<Skeleton className="h-full w-full" />}>{children}</Suspense>
    </div>
  );
}

function LegendDot({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

function TableCard({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border bg-background">{children}</div>;
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** «Что покупают»: все / новые / продления, по убыванию проданного. */
function ProductsSection({ payload }: { payload: FbMyCityPayload }) {
  const [segment, setSegment] = useState<ProductSegment>("all");
  const sort = useTableSort<FbCityProduct>({
    name: (r) => r.name,
    count: (r) => r.count,
    amount: (r) => r.amount,
  });
  const rows = sort.apply(fbCityProducts(payload, segment));
  return (
    <Section
      title="Что покупают"
      aside={
        <SegmentedControl
          aria-label="Тип покупателя"
          value={segment}
          onChange={setSegment}
          options={PRODUCT_SEGMENTS}
        />
      }
    >
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Номенклатура</TableHead>
              <TableHead className={NUM} {...sort.head("count")}>
                Продано
              </TableHead>
              <TableHead className={NUM} {...sort.head("amount")}>
                Сумма продаж
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={3}>Нет данных</EmptyRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="min-w-40 font-medium">{r.name}</TableCell>
                  <TableCell className="text-right">{fbCityFmt(r.count)}</TableCell>
                  <TableCell className="text-right">{fbCityRub(r.amount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableCard>
    </Section>
  );
}

const DIRECTION_COLUMNS: { key: DirectionSortKey; label: string }[] = [
  { key: "classes", label: "Занятий" },
  { key: "booked", label: "Записано" },
  { key: "attended", label: "Посетило" },
  { key: "attendance", label: "Доходимость" },
];

function DirectionsSection({ payload }: { payload: FbMyCityPayload }) {
  const [sort, setSort] = useState<DirectionSort>(DIRECTION_SORT);
  const rows: FbCityDirection[] = fbCityDirections(payload, sort);
  return (
    <Section
      title="Направления занятий"
      aside={
        <p className="text-sm text-muted-foreground max-md:hidden">
          Кликните по показателю для сортировки
        </p>
      }
    >
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Направление</TableHead>
              {DIRECTION_COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className={NUM}
                  sortDir={sort.key === c.key ? sort.order : null}
                  onSort={() => setSort((cur) => nextDirectionSort(cur, c.key))}
                >
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>Нет данных</EmptyRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="min-w-40 font-medium">{r.name}</TableCell>
                  <TableCell className="text-right">{fbCityFmt(r.classes)}</TableCell>
                  <TableCell className="text-right">{fbCityFmt(r.booked)}</TableCell>
                  <TableCell className="text-right">{fbCityFmt(r.attended)}</TableCell>
                  <TableCell className="text-right">{fbCityPct(r.attended, r.booked)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableCard>
    </Section>
  );
}

/** Их таблица номенклатур пробных FitBase: по названию пробной услуги. */
function TrialProductsTable({ rows: source }: { rows: FbMyCityTrialRow[] }) {
  const sort = useTableSort<FbMyCityTrialRow>({
    name: (r) => r.label,
    registered: (r) => r.registered,
    visited: (r) => r.visited,
    attendance: (r) => r.attendance,
    day: (r) => r.day,
    dayConversion: (r) => r.day_conversion,
    within: (r) => r.within,
    conversion: (r) => r.conversion,
  });
  const rows = sort.apply(source);
  const head = (key: string, label: string) => (
    <TableHead className={NUM} {...sort.head(key)}>
      {label}
    </TableHead>
  );
  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead {...sort.head("name")}>Номенклатура пробного</TableHead>
            {head("registered", "Записано")}
            {head("visited", "Пришло")}
            {head("attendance", "Доходимость")}
            {head("day", "Купило в день")}
            {head("dayConversion", "Конверсия в день")}
            {head("within", "Купило за 14 дней")}
            {head("conversion", "Конверсия за 14 дней")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={8}>Нет определённых пробных за выбранный период</EmptyRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="min-w-40 font-medium">{r.label}</TableCell>
                <TableCell className="text-right">{fbCityFmt(r.registered)}</TableCell>
                <TableCell className="text-right">{fbCityFmt(r.visited)}</TableCell>
                <TableCell className="text-right">{fbCityPercent(r.attendance)}</TableCell>
                <TableCell className="text-right">{fbCityFmt(r.day)}</TableCell>
                <TableCell className="text-right">{fbCityPercent(r.day_conversion)}</TableCell>
                <TableCell className="text-right">{fbCityFmt(r.within)}</TableCell>
                <TableCell className="text-right">{fbCityPercent(r.conversion)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableCard>
  );
}

type StudioRow = FbCitySummary["studios"][number];

/** «Студии города»: их порядок — по названию от Я к А. */
function StudiosTable({ rows: source }: { rows: StudioRow[] }) {
  const sort = useTableSort<StudioRow>({
    name: (r) => r.name,
    revenue: (r) => r.total.revenue,
    sales: (r) => r.total.sales,
    attendance: (r) =>
      r.total.attended !== null && r.total.booked ? r.total.attended / r.total.booked : null,
    conversion: (r) => r.conversionValue,
  });
  const rows = sort.apply(source);
  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead {...sort.head("name")}>Студия</TableHead>
            <TableHead className={NUM} {...sort.head("revenue")}>
              Выручка
            </TableHead>
            <TableHead className={NUM} {...sort.head("sales")}>
              Продажи
            </TableHead>
            <TableHead className={NUM} {...sort.head("attendance")}>
              Доходимость
            </TableHead>
            <TableHead className={NUM} {...sort.head("conversion")}>
              Конверсия 14 дней
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={5}>Нет данных по выбранному сочетанию</EmptyRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="min-w-40 font-medium">{r.name}</TableCell>
                <TableCell className="text-right">{r.revenue}</TableCell>
                <TableCell className="text-right">{r.sales}</TableCell>
                <TableCell className="text-right">{r.attendance}</TableCell>
                <TableCell className="text-right">{r.conversion}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableCard>
  );
}
