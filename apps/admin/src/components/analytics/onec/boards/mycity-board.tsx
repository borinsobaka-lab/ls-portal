import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

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
import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import {
  DIRECTION_SORT,
  MARKETING_REPORT_URL,
  PRODUCT_SEGMENTS,
  TREND_CHART_HEIGHT,
  directionRows,
  filtersPending,
  fmt,
  boardCity,
  nextDirectionSort,
  partnerRows,
  partnerSummary,
  pct,
  productRows,
  ratio,
  rub,
  salesTrend,
  studioChoices,
  studioRows,
  trialProductRows,
  type DirectionSort,
  type DirectionSortKey,
  type ProductRow,
  type ProductSegment,
  type StudioRow,
  type TrialProductRow,
} from "@/lib/analytics/onec-reports/mycity";
import type { PartnerPayload } from "@/lib/analytics/onec-reports/payload";
import { cn } from "@/lib/utils";

// recharts — отдельным чанком, как графики дашборда: числа доски видны сразу.
const RevenueBars = lazy(() => import("./mycity/plots").then((m) => ({ default: m.RevenueBars })));
const SalesTrendPlot = lazy(() =>
  import("./mycity/plots").then((m) => ({ default: m.SalesTrendPlot })),
);

/** Один показатель графиков доски — цвет клуба, как у графиков дашборда. */
const CHART_COLOR = "var(--brand)";
/** Новые продажи и продления — цвета видов продажи дашборда. */
const TREND_COLORS = { newSales: SALE_ORIGIN_COLOR.new, repeatSales: SALE_ORIGIN_COLOR.renewal };
const ALL_STUDIOS = "__all__";
const CITY_FIELD_ID = "onec-mycity-city";

/**
 * Доска «Мой город» — перенос их partner.html и partner-reference.js
 * (кабинет партнёра): город и студия, главные плитки, финансы и точка 0,
 * продажи и их динамика, что покупают, занятия и направления, воронка
 * пробных, номенклатуры пробных, студии города. Расчёты и подписи — их
 * (lib/analytics/onec-reports/mycity.ts), вид — наш.
 *
 * Город меняется на месте (данные всех студий города уже в отчёте), студия —
 * через адрес: рамка перезагружает отчёт с фильтром студии (их
 * partner_payload). При выбранной студии другой город — снова все студии.
 */
export function PartnerBoard({
  payload,
  controls,
}: {
  payload: PartnerPayload;
  controls: OnecControls;
}) {
  const rows = useMemo(() => partnerRows(payload), [payload]);

  const city = boardCity(payload, controls.search.city);

  const summary = useMemo(() => partnerSummary(payload, city, rows), [payload, city, rows]);
  const trend = useMemo(() => salesTrend(payload, city, rows), [payload, city, rows]);
  const studios = useMemo(() => studioRows(payload, city, rows), [payload, city, rows]);
  const pending = filtersPending(controls.search, payload);

  const studioOptions = studioChoices(payload, city);
  const wantedStudio = controls.search.studio ?? "";
  const studio = studioOptions.includes(wantedStudio) ? wantedStudio : "";

  // Город — в адресе (переживает смену периода и перезагрузку, как их
  // select #city). Без студии данные не перезапрашиваются; при студии смена
  // города сбрасывает её (их changeStudio("")).
  const changeCity = (next: string) => controls.setFilters({ city: next, studio: undefined });
  const changeStudio = (value: string) =>
    controls.setFilters({ city: city || undefined, studio: value || undefined });

  const be = summary.breakEven;

  return (
    <div className="space-y-6">
      <TableToolbar>
        <div className="w-48">
          <label htmlFor={CITY_FIELD_ID} className="sr-only">
            Город
          </label>
          <SearchableCombobox
            id={CITY_FIELD_ID}
            value={city}
            onChange={changeCity}
            options={payload.cities.map((c) => ({ value: c, label: c, searchText: c }))}
            placeholder="Выберите город"
            searchPlaceholder="Найти город"
            emptyText="Город не найден"
          />
        </div>
        <Select
          value={studio || ALL_STUDIOS}
          onValueChange={(v) => changeStudio(v === ALL_STUDIOS ? "" : v)}
        >
          <SelectTrigger className="w-48" aria-label="Студия">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {studioOptions.map((s) => (
              <SelectItem key={s || ALL_STUDIOS} value={s || ALL_STUDIOS}>
                {s || "Все студии"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" asChild className="toolbar-full">
          <a href={MARKETING_REPORT_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            Маркетинговый отчет
          </a>
        </Button>
      </TableToolbar>

      <div
        className={cn("space-y-6 transition-opacity", pending && "opacity-60")}
        aria-busy={pending}
      >
        <div className="space-y-1">
          <h2 className="text-xl leading-tight font-semibold">{summary.title}</h2>
          <p className="text-sm text-muted-foreground">{summary.subtitle}</p>
        </div>

        <MetricGrid>
          <MetricCard
            label="Выручка за период"
            value={summary.revenue}
            detail={
              summary.revenueDelta ? (
                <>
                  <Change up={summary.revenueDelta.up}>{summary.revenueDelta.text}</Change> к
                  прошлому месяцу
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

        <Section title="Финансы" aside="Нетто-выручка: приход минус расход">
          <div className="grid gap-3 lg:grid-cols-[7fr_5fr]">
            <Panel title="Выручка по месяцам">
              <ChartBox height={180}>
                <RevenueBars bars={summary.revenueBars} color={CHART_COLOR} />
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

        <Section title="Продажи абонементов" aside="Только положительно оплаченные абонементы">
          <MetricGrid>
            <MetricCard
              label="Новые продажи"
              value={summary.newSales}
              detail={summary.newPayments}
            />
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

        <ProductsSection payload={payload} city={city} />

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

        <DirectionsSection payload={payload} city={city} />

        <Section title="Воронка пробных занятий" aside="Конверсия считается от пришедших">
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
                  detail="Разница между конверсией в день и за 14 дней"
                />
              </div>
            </Panel>
          </div>
        </Section>

        <Section title="Номенклатуры пробных занятий" aside="Запись → приход → покупка">
          <TrialProductsTable rows={trialProductRows(payload, city)} />
        </Section>

        <Section title="Студии города" aside="Свод ключевых показателей за выбранный период">
          <StudiosTable rows={studios} />
        </Section>
      </div>
    </div>
  );
}

/** Область графика: болванка той же высоты, пока грузится чанк recharts. */
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

const NUM = "text-right [&>span]:justify-end";

/** Обёртка таблицы доски: белая карточка с рамкой. */
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
function ProductsSection({ payload, city }: { payload: PartnerPayload; city: string }) {
  const [segment, setSegment] = useState<ProductSegment>("all");
  const sort = useTableSort<ProductRow>({
    name: (r) => r.name,
    count: (r) => r.count,
    amount: (r) => r.amount,
  });
  const rows = sort.apply(productRows(payload, city, segment));
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
                  <TableCell className="text-right">{fmt(r.count)}</TableCell>
                  <TableCell className="text-right">{rub(r.amount)}</TableCell>
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

/**
 * «Направления занятий»: их сортировка — по занятиям по убыванию, нажатие
 * на показатель — по нему по убыванию, повторное — в обратную сторону.
 */
function DirectionsSection({ payload, city }: { payload: PartnerPayload; city: string }) {
  const [sort, setSort] = useState<DirectionSort>(DIRECTION_SORT);
  const rows = directionRows(payload, city, sort);
  return (
    <Section
      title="Направления занятий"
      aside={
        // На телефоне таблица — карточки без шапки: нажимать не на что.
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
                  <TableCell className="text-right">{fmt(r.classes)}</TableCell>
                  <TableCell className="text-right">{fmt(r.booked)}</TableCell>
                  <TableCell className="text-right">{fmt(r.attended)}</TableCell>
                  <TableCell className="text-right">{pct(r.attended, r.booked)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableCard>
    </Section>
  );
}

/** «Номенклатуры пробных занятий»: по убыванию записавшихся. */
function TrialProductsTable({ rows: source }: { rows: TrialProductRow[] }) {
  const sort = useTableSort<TrialProductRow>({
    name: (r) => r.name,
    trials: (r) => r.trials,
    attended: (r) => r.attended,
    attendance: (r) => ratio(r.attended, r.trials),
    boughtDay: (r) => r.boughtDay,
    dayConversion: (r) => ratio(r.boughtDay, r.attended),
    bought14: (r) => r.bought14,
    conversion14: (r) => ratio(r.bought14, r.attended),
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
            {head("trials", "Записано")}
            {head("attended", "Пришло")}
            {head("attendance", "Доходимость")}
            {head("boughtDay", "Купило в день")}
            {head("dayConversion", "Конверсия в день")}
            {head("bought14", "Купило за 14 дней")}
            {head("conversion14", "Конверсия за 14 дней")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={8}>Нет данных</EmptyRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="min-w-40 font-medium">{r.name}</TableCell>
                <TableCell className="text-right">{fmt(r.trials)}</TableCell>
                <TableCell className="text-right">{fmt(r.attended)}</TableCell>
                <TableCell className="text-right">{pct(r.attended, r.trials)}</TableCell>
                <TableCell className="text-right">{fmt(r.boughtDay)}</TableCell>
                <TableCell className="text-right">{pct(r.boughtDay, r.attended)}</TableCell>
                <TableCell className="text-right">{fmt(r.bought14)}</TableCell>
                <TableCell className="text-right">{pct(r.bought14, r.attended)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/** «Студии города»: свод по студиям (их порядок — по названию от Я к А). */
function StudiosTable({ rows: source }: { rows: StudioRow[] }) {
  const sort = useTableSort<StudioRow>({
    name: (r) => r.name,
    revenue: (r) => r.total.revenue,
    sales: (r) => r.total.sales,
    attendance: (r) => ratio(r.total.attended, r.total.booked),
    conversion: (r) => ratio(r.total.bought_14, r.total.trial_attended),
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
