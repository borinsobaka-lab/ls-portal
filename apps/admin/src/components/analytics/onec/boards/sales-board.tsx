import { useEffect, useMemo, useState } from "react";

import { SalesMetricCard, SalesQuoteCard } from "@/components/analytics/onec/boards/sales/cards";
import { SalesChartsRow } from "@/components/analytics/onec/boards/sales/charts";
import { SalesTable } from "@/components/analytics/onec/boards/sales/table";
import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SalesPayload } from "@/lib/analytics/onec-reports/payload";
import {
  SALES_ALL,
  SALES_CARD_LABELS,
  SALES_TOP_CARDS,
  cycleSalesSort,
  salesBoardPeriod,
  salesCardTexts,
  salesCardTrends,
  salesCharts,
  salesCityOptions,
  salesCityVisible,
  salesFiltered,
  salesSelectCity,
  salesSelection,
  salesStudioOptions,
  salesTableRows,
  salesTotals,
  salesUrlValue,
  type SalesFilters,
  type SalesSort,
  type SalesTableRow,
} from "@/lib/analytics/onec-reports/sales";

/**
 * Доска «Продажи абонементов» — перенос их sales.html (с их слоем
 * оформления): плитки со сравнением с прошлым месяцем, средние чеки,
 * графики по месяцам, фильтры города и студии, таблица «город → студия →
 * номенклатура» с сортировкой по колонкам. Расчёты — lib/analytics/
 * onec-reports/sales.ts. У них смена периода перезагружала страницу —
 * здесь доска собирается заново (раскрытые строки, сортировка, поиск
 * города — с нуля), город и студия — из адреса.
 */
export function SalesBoard({
  payload,
  controls,
}: {
  payload: SalesPayload;
  controls: OnecControls;
}) {
  return (
    <SalesBoardView
      key={`${payload.start}|${payload.end}|${payload.generatedAt}`}
      payload={payload}
      controls={controls}
    />
  );
}

// Значения пунктов списка: у Radix пустое значение запрещено, а город или
// студия с пустым названием у них — обычный пункт.
const ITEM = "v:";
const toItem = (v: string) => (v === SALES_ALL ? SALES_ALL : ITEM + v);
const fromItem = (v: string) => (v === SALES_ALL ? SALES_ALL : v.slice(ITEM.length));

function SalesBoardView({ payload, controls }: { payload: SalesPayload; controls: OnecControls }) {
  const period = salesBoardPeriod(payload);
  // Без месяца периода их слой оформления не срабатывал: сравнений у плиток,
  // нижнего ряда и графиков нет, суммы — с «₽».
  const decorated = period !== "";

  const [filters, setFilters] = useState<SalesFilters>(() =>
    salesSelection(payload, controls.search),
  );
  const [citySearch, setCitySearch] = useState("");
  const [sort, setSort] = useState<SalesSort>(null);
  const [expandedCities, setExpandedCities] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedStudios, setExpandedStudios] = useState<ReadonlySet<string>>(() => new Set());

  // Город и студия — в адресе (их server-controls: переживают смену
  // периода); «все» и несуществующие у них в адрес не попадали.
  const urlCity = salesUrlValue(filters.city);
  const urlStudio = salesUrlValue(filters.studio);
  useEffect(() => {
    if (controls.search.city !== urlCity || controls.search.studio !== urlStudio)
      controls.setFilters({ city: urlCity, studio: urlStudio });
  }, [controls, urlCity, urlStudio]);

  const cities = useMemo(() => salesCityOptions(payload), [payload]);
  const studios = useMemo(() => salesStudioOptions(payload, filters.city), [payload, filters]);
  const rows = useMemo(() => salesFiltered(payload, filters), [payload, filters]);
  const cards = useMemo(() => salesCardTexts(salesTotals(rows), decorated), [rows, decorated]);
  const trends = useMemo(
    () => (decorated ? salesCardTrends(payload, period, filters.city, filters.studio) : null),
    [payload, period, filters, decorated],
  );
  const charts = useMemo(() => salesCharts(payload, period, filters), [payload, period, filters]);
  const tableRows = useMemo(
    () => salesTableRows(payload, rows, period, sort, expandedCities, expandedStudios),
    [payload, rows, period, sort, expandedCities, expandedStudios],
  );

  const toggle = (row: SalesTableRow) => {
    const key = row.toggle;
    if (key === null) return;
    const flip = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    };
    if (row.level === "city") setExpandedCities(flip);
    else setExpandedStudios(flip);
  };

  const cardItems = SALES_CARD_LABELS.map((label, i) => ({ label, value: cards[i] }));
  const visibleCities = cities.filter((c) => salesCityVisible(c, citySearch));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {(decorated ? cardItems.slice(0, SALES_TOP_CARDS) : cardItems).map((c, i) => (
          <SalesMetricCard
            key={c.label}
            label={c.label}
            value={c.value}
            trend={trends ? trends[i] : undefined}
          />
        ))}
      </div>

      {decorated && (
        <div className="grid gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-[1fr_1fr_1fr_1.6fr]">
          {cardItems.slice(SALES_TOP_CARDS).map((c) => (
            <SalesMetricCard key={c.label} label={c.label} value={c.value} />
          ))}
          <SalesQuoteCard className="row-span-2 sm:col-span-3 xl:col-span-1" />
        </div>
      )}

      {charts && <SalesChartsRow charts={charts} />}

      <TableToolbar>
        <ToolbarSearch value={citySearch} onChange={setCitySearch} placeholder="Найти город" />
        <Select
          value={toItem(filters.city)}
          onValueChange={(v) => setFilters(salesSelectCity(payload, filters, fromItem(v)))}
        >
          <SelectTrigger className="w-48" aria-label="Город">
            <SelectValue>{filters.city === SALES_ALL ? "Все города" : filters.city}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SALES_ALL}>Все города</SelectItem>
            {visibleCities.map((c) => (
              <SelectItem key={c} value={toItem(c)}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={toItem(filters.studio)}
          onValueChange={(v) => setFilters({ ...filters, studio: fromItem(v) })}
        >
          <SelectTrigger className="w-48" aria-label="Студия">
            <SelectValue>
              {filters.studio === SALES_ALL ? "Все студии" : filters.studio}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SALES_ALL}>Все студии</SelectItem>
            {studios.map((s) => (
              <SelectItem key={s} value={toItem(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableToolbar>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-background py-8 text-center text-sm text-muted-foreground">
          Нет данных по выбранным фильтрам
        </div>
      ) : (
        <SalesTable
          rows={tableRows}
          sort={sort}
          onSort={(key) => setSort((s) => cycleSalesSort(s, key))}
          onToggle={toggle}
        />
      )}
    </div>
  );
}
