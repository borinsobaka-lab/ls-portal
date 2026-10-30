import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Minus, Plus } from "lucide-react";

import { DirectionFilter } from "@/components/analytics/onec/boards/activities/direction-filter";
import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ALL,
  FILTER_LABELS,
  NO_FILTERS,
  STATUS_OPTIONS,
  TABLE_MODES,
  activityKpis,
  activityTable,
  comparisonPeriod,
  filterRows,
  filtersSearch,
  matchesFilters,
  periodRows,
  restoreFilters,
  shiftPeriod,
  studioStatusOf,
  unpackActivities,
  updateOptions,
  type ActivityFilters,
  type ActivityKpi,
  type ActivityLine,
  type DeltaKind,
  type TableMode,
} from "@/lib/analytics/onec-reports/activities";
import type { ActivitiesPayload } from "@/lib/analytics/onec-reports/payload";
import { cn } from "@/lib/utils";

/**
 * Доска «Занятия» — перенос их activities.html с activities-reference.js
 * (/1c?report=activities): фильтры «Город» (с поиском), «Студия»,
 * «Направление» (несколько, с поиском), «Статус студии» и «Сбросить»;
 * шесть плиток со сравнением с предыдущим периодом той же длины; таблица
 * «город → студия → направление» с раскрытием и режимами «Текущее / К
 * прошлому месяцу / К прошлому году». Расчёты и тексты — их
 * (lib/analytics/onec-reports/activities.ts), вид — наш. Блок «Сравнение с
 * предыдущими периодами» их activities-reference.js убирает — его нет.
 */
export function ActivitiesBoard({
  payload,
  controls,
}: {
  payload: ActivitiesPayload;
  controls: OnecControls;
}) {
  // У них смена периода перезагружает страницу: раскрытые строки, режим
  // таблицы и направления сбрасываются, город, студия и статус — из адреса.
  return (
    <Board
      key={`${payload.start}|${payload.end}|${payload.generatedAt}`}
      payload={payload}
      controls={controls}
    />
  );
}

const DELTA_TONE: Record<DeltaKind, StatusTone> = {
  up: "positive",
  down: "negative",
  flat: "neutral",
  missing: "neutral",
};

const DELTA_ICON: Record<DeltaKind, typeof ArrowUp | null> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
  missing: null,
};

/** Статус студии в таблице: открытая — действующая, закрытая — прошедшее. */
const statusTone = (status: string): StatusTone => (status === "Открыта" ? "positive" : "neutral");

function Board({ payload, controls }: { payload: ActivitiesPayload; controls: OnecControls }) {
  const rows = useMemo(() => unpackActivities(payload), [payload]);
  const range = useMemo(() => ({ start: payload.start, end: payload.end }), [payload]);
  const [state, setState] = useState(() => restoreFilters(rows, range, controls.search));
  const { filters, options } = state;
  const [directionSearch, setDirectionSearch] = useState("");
  const [expandedCities, setExpandedCities] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedStudios, setExpandedStudios] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<TableMode>("current");
  const cityLabelId = useId();

  // Город, студия и статус — в адресе (их server-controls: переживают смену
  // периода); «все» не пишется. Пишем, только когда меняется выбор на доске
  // (и при открытии — то, что из адреса принялось): адрес, сменившийся сам
  // (назад по истории, пока грузится другой период), не перетираем.
  const { city, studio, status } = filtersSearch(filters);
  const { search, setFilters } = controls;
  const written = useRef<string | null>(null);
  const selection = JSON.stringify([city, studio, status]);
  useEffect(() => {
    if (written.current === selection) return;
    written.current = selection;
    if (city !== search.city || studio !== search.studio || status !== search.status)
      setFilters({ city, studio, status });
  }, [selection, city, studio, status, search.city, search.studio, search.status, setFilters]);

  /** Их обработчики change у #status / #city / #studio: updateOptions(). */
  const change = (next: Partial<ActivityFilters>) =>
    setState(updateOptions(rows, range, { ...filters, ...next }));
  const toggleDirection = (direction: string, checked: boolean) =>
    setState((s) => {
      const rest = s.filters.directions.filter((d) => d !== direction);
      const directions = checked
        ? s.filters.directions.includes(direction)
          ? s.filters.directions
          : [...rest, direction]
        : rest;
      return { ...s, filters: { ...s.filters, directions } };
    });
  const reset = () => {
    setDirectionSearch("");
    setState(updateOptions(rows, range, NO_FILTERS));
  };
  const filtered =
    filters.status !== ALL ||
    filters.city !== ALL ||
    filters.studio !== ALL ||
    filters.directions.length > 0;

  const current = useMemo(() => filterRows(rows, range, filters), [rows, range, filters]);
  const kpis = useMemo(
    () =>
      activityKpis(
        current,
        payload.previousPeriod.records.filter((r) => matchesFilters(r, filters)),
        payload.previousPeriod,
      ),
    [current, payload, filters],
  );
  const lines = useMemo(() => {
    const period = comparisonPeriod(payload);
    return activityTable(
      current,
      periodRows(rows, shiftPeriod(period, -1), filters),
      periodRows(rows, shiftPeriod(period, -12), filters),
      mode,
      expandedCities,
      expandedStudios,
      studioStatusOf(payload),
    );
  }, [current, rows, payload, filters, mode, expandedCities, expandedStudios]);

  const toggleLine = (line: ActivityLine) => {
    const flip = (prev: ReadonlySet<string>) => {
      const next = new Set(prev);
      if (next.has(line.key)) next.delete(line.key);
      else next.add(line.key);
      return next;
    };
    if (line.level === "city") setExpandedCities(flip);
    else setExpandedStudios(flip);
  };

  const cityOptions = [
    { value: ALL, label: "Все города", searchText: "Все города" },
    ...options.cities.map((c, i) => ({ value: String(i), label: c, searchText: c })),
  ];

  return (
    <div className="space-y-4">
      <TableToolbar>
        <div className="w-48">
          <label htmlFor={cityLabelId} className="sr-only">
            {FILTER_LABELS.city}
          </label>
          <SearchableCombobox
            id={cityLabelId}
            value={filters.city === ALL ? ALL : String(options.cities.indexOf(filters.city))}
            onChange={(v) => change({ city: v === ALL ? ALL : options.cities[+v] })}
            options={cityOptions}
            placeholder="Все города"
            searchPlaceholder="Найти город"
            emptyText="Ничего не найдено"
          />
        </div>
        <Select
          value={filters.studio === ALL ? ALL : String(options.studios.indexOf(filters.studio))}
          onValueChange={(v) => change({ studio: v === ALL ? ALL : options.studios[+v] })}
        >
          <SelectTrigger className="w-48" aria-label={FILTER_LABELS.studio}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Все студии</SelectItem>
            {options.studios.map((s, i) => (
              <SelectItem key={s} value={String(i)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DirectionFilter
          options={options.directions}
          selected={filters.directions}
          search={directionSearch}
          onSearchChange={setDirectionSearch}
          onToggle={toggleDirection}
          onClear={() => setState((s) => ({ ...s, filters: { ...s.filters, directions: [] } }))}
        />
        <Select value={filters.status} onValueChange={(v) => change({ status: v })}>
          <SelectTrigger
            className="w-48"
            aria-label={FILTER_LABELS.status}
            title={FILTER_LABELS.status}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToolbarReset active={filtered} onReset={reset} />
      </TableToolbar>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </div>

      <section className="min-w-0 rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Занятия по городам, студиям и направлениям</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Детализация показателей по городам, студиям и направлениям.
            </p>
          </div>
          {/* На телефоне три подписи не помещаются — сегменты прокручиваются. */}
          <div className="max-w-full overflow-x-auto">
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={TABLE_MODES}
              aria-label="Значения в таблице"
            />
          </div>
        </div>
        {current.length ? (
          <ActivityTable lines={lines} onToggle={toggleLine} />
        ) : (
          <p className="border-t py-8 text-center text-sm text-muted-foreground">
            Нет данных по выбранным фильтрам
          </p>
        )}
      </section>
    </div>
  );
}

/** Плитка: подпись, значение и сравнение с предыдущим периодом (их decorate). */
function KpiCard({ kpi }: { kpi: ActivityKpi }) {
  const { kind, text } = kpi.change;
  const Icon = DELTA_ICON[kind];
  return (
    <div className="row-span-3 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3">
      <span className="text-xs font-medium text-muted-foreground sm:text-sm">{kpi.label}</span>
      <span className="text-lg font-semibold tabular-nums sm:text-xl">{kpi.value}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1" title={kpi.title}>
        <StatusChip tone={DELTA_TONE[kind]} className="tabular-nums">
          {Icon && <Icon />}
          {text}
        </StatusChip>
        <span className="text-xs text-muted-foreground">к прошлому периоду</span>
      </span>
    </div>
  );
}

const TREND_CLASS = { up: "text-emerald-700", down: "text-rose-700", "": "" } as const;

/** Их renderTable: города, у раскрытых — студии, у раскрытых студий — направления. */
function ActivityTable({
  lines,
  onToggle,
}: {
  lines: ActivityLine[];
  onToggle: (line: ActivityLine) => void;
}) {
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Город / студия / направление</TableHead>
            <TableHead className="text-right">Проведено</TableHead>
            <TableHead className="text-right">Записано</TableHead>
            <TableHead className="text-right">Посетило</TableHead>
            <TableHead className="py-1.5 text-right leading-tight">
              Среднее записано <br />
              на занятие
            </TableHead>
            <TableHead className="py-1.5 text-right leading-tight">
              Среднее посетило <br />
              на занятие
            </TableHead>
            <TableHead className="text-right">Доходимость</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.key} className={cn(line.level === "studio" && "bg-muted/30")}>
              <TableCell>
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-2",
                    line.level === "studio" && "pl-6",
                    line.level === "direction" && "pl-16",
                  )}
                >
                  {line.level !== "direction" && (
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-expanded={line.expanded}
                      aria-label={`${line.expanded ? "Свернуть" : "Развернуть"}: ${line.name}`}
                      onClick={() => onToggle(line)}
                    >
                      {line.expanded ? <Minus /> : <Plus />}
                    </Button>
                  )}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cn(line.level === "city" && "font-semibold")}>
                      {line.name}
                    </span>
                    {line.status && (
                      <StatusChip tone={statusTone(line.status)}>{line.status}</StatusChip>
                    )}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right">{line.held}</TableCell>
              <TableCell className="text-right">{line.scheduled}</TableCell>
              <TableCell className="text-right">{line.attended}</TableCell>
              {line.cells.map((cell, i) => (
                <TableCell
                  key={i}
                  className={cn("whitespace-nowrap text-right", TREND_CLASS[cell.kind])}
                >
                  {cell.text}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
