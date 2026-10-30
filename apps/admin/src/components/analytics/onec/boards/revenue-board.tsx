import { useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { RevenueSummary } from "@/components/analytics/onec/boards/revenue/revenue-summary";
import { RevenueTable } from "@/components/analytics/onec/boards/revenue/revenue-table";
import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RevenuePayload } from "@/lib/analytics/onec-reports/payload";
import {
  REVENUE_STATUS_OPTIONS,
  allRevenueCities,
  cycleRevenueSort,
  parseRevenueStatus,
  revenueBodyRows,
  revenueColumns,
  revenueSummary,
  visibleRevenueColumns,
  type RevenueSort,
  type RevenueStatus,
} from "@/lib/analytics/onec-reports/revenue";

/**
 * Доска «Выручка» — перенос их revenue.html (/1c?report=revenue): плитки
 * сводки, поиск и фильтр статуса, «Раскрыть / Свернуть все», «Свернуть
 * текущий месяц», «Показать точку 0», прокрутка к более свежим / ранним
 * месяцам и таблица городов со студиями. Логика — lib/analytics/onec-reports/
 * revenue.ts. Их страница перезагружалась при смене периода — поиск,
 * раскрытые города, сортировка и переключатели начинались заново; здесь
 * так же (доска заводится заново на каждый период), и фильтр статуса тоже:
 * их server-controls.js сохранял только поля city / studio / status, а у
 * «Выручки» поле — statusFilter.
 */
export function RevenueBoard({ payload }: { payload: RevenuePayload; controls: OnecControls }) {
  return <RevenueBoardView key={`${payload.start}|${payload.end}`} data={payload} />;
}

function RevenueBoardView({ data }: { data: RevenuePayload }) {
  const [search, setSearch] = useState("");
  // Как у них: фильтр статуса (#statusFilter) их server-controls.js не
  // сохранял — при смене периода он сбрасывается на «Все студии».
  const [status, setStatus] = useState<RevenueStatus>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [sort, setSort] = useState<RevenueSort>(null);
  const [currentMonthVisible, setCurrentMonthVisible] = useState(true);
  const [breakEvenVisible, setBreakEvenVisible] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);

  const metrics = useMemo(() => revenueSummary(data), [data]);
  const allColumns = useMemo(() => revenueColumns(data), [data]);
  const columns = visibleRevenueColumns(allColumns, { currentMonthVisible, breakEvenVisible });
  const rows = useMemo(
    () => revenueBodyRows(data, { search, statusFilter: status, expanded, sort }),
    [data, search, status, expanded, sort],
  );

  const scrollTable = (left: number) =>
    tableRef.current?.parentElement?.scrollBy({ left, behavior: "smooth" });
  const toggleCity = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="space-y-4">
      <RevenueSummary metrics={metrics} />
      <TableToolbar>
        <ToolbarSearch value={search} onChange={setSearch} placeholder="Поиск города или студии" />
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(parseRevenueStatus(value));
          }}
        >
          <SelectTrigger className="toolbar-full w-48" aria-label="Фильтр статуса">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVENUE_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => setExpanded(allRevenueCities(data))}>
          Раскрыть все
        </Button>
        <Button variant="outline" onClick={() => setExpanded(new Set())}>
          Свернуть все
        </Button>
        <Button variant="outline" onClick={() => setCurrentMonthVisible((v) => !v)}>
          {/* На телефоне — «Свернуть месяц»: в половину строки плашки
              полная подпись не помещалась. */}
          <span>
            {currentMonthVisible ? "Свернуть" : "Показать"}
            <span className="max-sm:hidden"> текущий</span> месяц
          </span>
        </Button>
        <Button variant="outline" onClick={() => setBreakEvenVisible((v) => !v)}>
          {breakEvenVisible ? "Скрыть точку 0" : "Показать точку 0"}
        </Button>
        <Button
          variant="outline"
          title="Перейти к более свежим месяцам"
          onClick={() => scrollTable(-700)}
        >
          <ArrowLeft />К более свежим
        </Button>
        <Button
          variant="outline"
          title="Перейти к более ранним месяцам"
          onClick={() => scrollTable(700)}
        >
          К более ранним
          <ArrowRight />
        </Button>
      </TableToolbar>
      <RevenueTable
        columns={columns}
        rows={rows}
        sort={sort}
        onSort={(key) => setSort((prev) => cycleRevenueSort(prev, key))}
        onToggleCity={toggleCity}
        tableRef={tableRef}
      />
    </div>
  );
}
