import { useEffect, useMemo, useState } from "react";
import { Building2 } from "lucide-react";

import {
  FunnelCityFilter,
  FunnelDirectionFilter,
} from "@/components/analytics/onec/boards/funnel/funnel-filters";
import { FunnelTable } from "@/components/analytics/onec/boards/funnel/funnel-table";
import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { TableToolbar } from "@/components/table-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FUNNEL_ALL,
  FUNNEL_ALL_STUDIOS,
  FUNNEL_STATUS_OPTIONS,
  funnelCards,
  funnelClearDirections,
  funnelFiltered,
  funnelOptions,
  funnelRange,
  funnelRestore,
  funnelSearchFilters,
  funnelSelect,
  funnelTable,
  funnelToggle,
  funnelToggleDirection,
  funnelTotals,
  unpackFunnel,
  type FunnelFilters,
  type FunnelSelectKey,
  type FunnelTableRow,
} from "@/lib/analytics/onec-reports/funnel";
import type { FunnelPayload } from "@/lib/analytics/onec-reports/payload";

/**
 * Доска «Воронка пробных» — перенос их funnel.html (/1c?report=funnel) с
 * поведенческим слоем funnel-reference.js: фильтры «Город» (с поиском),
 * «Студия», «Направление» (несколько), «Статус студии», восемь плиток и
 * таблица город → студия → направление. Логика и тексты — их
 * (lib/analytics/onec-reports/funnel.ts), вид — наш. Их страница
 * перезагружалась при смене периода: направления и раскрытые строки
 * начинались заново, город, студия и статус приходили из адреса — здесь
 * так же (доска заводится заново на каждый период, фильтры — в адресе).
 * Их шапка («Источник… Обновлено…») — в рамке отчёта, кроме пояснения
 * про 14 дней (FUNNEL_NOTE).
 */
export function FunnelBoard({
  payload,
  controls,
}: {
  payload: FunnelPayload;
  controls: OnecControls;
}) {
  return (
    <FunnelBoardView key={`${payload.start}|${payload.end}`} data={payload} controls={controls} />
  );
}

/** Хвост их строки meta под заголовком доски. */
const FUNNEL_NOTE = "Конверсия за 14 дней включает покупку в день пробного.";

function FunnelBoardView({ data, controls }: { data: FunnelPayload; controls: OnecControls }) {
  const rows = useMemo(() => unpackFunnel(data), [data]);
  const range = useMemo(() => funnelRange(data), [data]);
  const [filters, setFilters] = useState<FunnelFilters>(() =>
    funnelRestore(rows, range, controls.search),
  );
  const [expandedCities, setExpandedCities] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedStudios, setExpandedStudios] = useState<ReadonlySet<string>>(() => new Set());

  // Город, студия и статус — в адресе (их форма периода передавала их
  // дальше): несовпадение после сверки со списками тоже уходит в адрес.
  useEffect(() => {
    const next = funnelSearchFilters(filters);
    const now = controls.search;
    if (next.city !== now.city || next.studio !== now.studio || next.status !== now.status)
      controls.setFilters(next);
  }, [filters, controls]);

  const options = useMemo(() => funnelOptions(rows, range, filters), [rows, range, filters]);
  const filtered = useMemo(() => funnelFiltered(rows, range, filters), [rows, range, filters]);
  const cards = funnelCards(funnelTotals(filtered));
  const tableRows = useMemo(
    () => funnelTable(filtered, expandedCities, expandedStudios),
    [filtered, expandedCities, expandedStudios],
  );

  const select = (key: FunnelSelectKey, value: string) =>
    setFilters((f) => funnelSelect(rows, range, f, key, value));
  const toggle = (row: FunnelTableRow) => {
    if (row.toggleId === undefined) return;
    const id = row.toggleId;
    if (row.level === "city") setExpandedCities((s) => funnelToggle(s, id));
    else setExpandedStudios((s) => funnelToggle(s, id));
  };

  return (
    <div className="space-y-4">
      {/* Продолжение подписи рамки (их meta — одной строкой). */}
      <p className="-mt-3 text-xs text-muted-foreground">{FUNNEL_NOTE}</p>

      <TableToolbar>
        <FunnelCityFilter
          cities={options.cities}
          value={filters.city}
          onChange={(v) => select("city", v)}
        />
        <Select value={filters.studio} onValueChange={(v) => select("studio", v)}>
          <SelectTrigger aria-label="Студия" title="Студия" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FUNNEL_ALL}>{FUNNEL_ALL_STUDIOS}</SelectItem>
            {options.studios.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FunnelDirectionFilter
          options={options.directions}
          selected={filters.directions}
          onToggle={(d, checked) => setFilters((f) => funnelToggleDirection(f, d, checked))}
          onClear={() => setFilters((f) => funnelClearDirections(rows, range, f))}
        />
        <Select value={filters.status} onValueChange={(v) => select("status", v)}>
          <SelectTrigger aria-label="Статус студии" title="Статус студии" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUNNEL_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableToolbar>

      {/* Подпись и число — строки общей сетки (subgrid): числа ряда на одной
          высоте, даже когда подпись соседней плитки в две строки. */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="row-span-2 grid min-w-0 grid-rows-subgrid content-start gap-y-1 rounded-lg border bg-background px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <span className="text-xs font-medium text-muted-foreground sm:text-sm">
              {card.label}
            </span>
            <span className="text-lg font-semibold tabular-nums sm:text-xl">{card.value}</span>
          </div>
        ))}
      </div>

      <section className="min-w-0 rounded-lg border bg-background">
        <div className="flex items-center gap-3 p-3 sm:p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
            <Building2 aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Воронка по городам, студиям и направлениям</h2>
            <p className="text-sm text-muted-foreground">
              Детализация показателей по городам, студиям и направлениям.
            </p>
          </div>
        </div>
        {filtered.length ? (
          <div className="border-t">
            <FunnelTable rows={tableRows} onToggle={toggle} />
          </div>
        ) : (
          <p className="border-t py-8 text-center text-sm text-muted-foreground">
            Нет данных по выбранным фильтрам
          </p>
        )}
      </section>
    </div>
  );
}
