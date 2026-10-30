import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";

import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import type { ZeroPayload } from "@/lib/analytics/onec-reports/payload";
import {
  ZERO_ALL,
  zeroExcludedText,
  zeroFilterState,
  zeroFormat,
  zeroMetrics,
  zeroRows,
  zeroSortTree,
  zeroTree,
  zeroVisibleCities,
} from "@/lib/analytics/onec-reports/zero";
import { cn } from "@/lib/utils";

const TEXTS = {
  citySearch: "Найти город",
  city: "Город",
  studio: "Студия",
  allCities: "Все города",
  allStudios: "Все студии",
  name: "Город / студия / номенклатура",
  sales: "Количество нулевых продаж",
  empty: "Нет нулевых продаж по выбранным фильтрам",
  footnote:
    "В отбор включены строки, где «Стоимость» пустая (так 1С обозначает 0 ₽) или явно равна 0.",
};

/** Значение фильтра в адресе: «Все» — без параметра. */
const urlValue = (v: string) => (v === ZERO_ALL ? undefined : v);

/** Radix Select не принимает пустое значение пункта — пустое название кодируем. */
const EMPTY = "\u0000";
const toSelect = (v: string) => (v === "" ? EMPTY : v);
const fromSelect = (v: string) => (v === EMPTY ? "" : v);

/**
 * Доска «Нулевая номенклатура» — их zero.html (/1c?report=zero): «Поиск
 * города», «Город», «Студия», четыре плитки и таблица город → студия →
 * номенклатура с раскрытием. Расчёты — lib/analytics/onec-reports/zero.ts.
 * Их «Период» на доске скрыт (server-controls.css) и всегда равен месяцу
 * начала периода — период выбирает рамка отчёта.
 */
export function ZeroBoard({ payload, controls }: { payload: ZeroPayload; controls: OnecControls }) {
  // У них смена периода перезагружала страницу: раскрытые строки и «Поиск
  // города» начинались заново, город и студия — из адреса.
  return (
    <ZeroBoardView
      key={`${payload.start}|${payload.end}|${payload.generatedAt}`}
      payload={payload}
      controls={controls}
    />
  );
}

function ZeroBoardView({ payload, controls }: { payload: ZeroPayload; controls: OnecControls }) {
  const [citySearch, setCitySearch] = useState("");
  const [openCities, setOpenCities] = useState<ReadonlySet<string>>(new Set());
  const [openStudios, setOpenStudios] = useState<ReadonlySet<string>>(new Set());
  const sort = useTableSort();

  const period = payload.currentPeriod || ZERO_ALL;
  const { search } = controls;
  const state = zeroFilterState(payload.records, {
    period,
    city: search.city ?? ZERO_ALL,
    studio: search.studio ?? ZERO_ALL,
  });
  const filters = { period, city: state.city, studio: state.studio };
  const rows = zeroRows(payload.records, filters);
  const tree = zeroSortTree(zeroTree(rows), sort.sort);
  const visibleCities = zeroVisibleCities(state.cities, citySearch);

  const apply = (city: string, studio: string) =>
    controls.setFilters({ city: urlValue(city), studio: urlValue(studio) });
  const changeCity = (city: string) => {
    const next = zeroFilterState(payload.records, { ...filters, city });
    apply(next.city, next.studio);
  };
  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{zeroExcludedText(payload)}</p>

      <TableToolbar>
        <ToolbarSearch value={citySearch} onChange={setCitySearch} placeholder={TEXTS.citySearch} />
        <Select value={toSelect(state.city)} onValueChange={(v) => changeCity(fromSelect(v))}>
          <SelectTrigger className="w-48" aria-label={TEXTS.city}>
            {/* Выбранный город виден, даже если «Поиск города» спрятал его в списке. */}
            <SelectValue>{state.city === ZERO_ALL ? TEXTS.allCities : state.city}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ZERO_ALL}>{TEXTS.allCities}</SelectItem>
            {visibleCities.map((c) => (
              <SelectItem key={c} value={toSelect(c)}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={toSelect(state.studio)}
          onValueChange={(v) => apply(state.city, fromSelect(v))}
        >
          <SelectTrigger className="w-48" aria-label={TEXTS.studio}>
            <SelectValue>{state.studio === ZERO_ALL ? TEXTS.allStudios : state.studio}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ZERO_ALL}>{TEXTS.allStudios}</SelectItem>
            {state.studios.map((s) => (
              <SelectItem key={s} value={toSelect(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToolbarReset
          active={state.city !== ZERO_ALL || state.studio !== ZERO_ALL || citySearch !== ""}
          onReset={() => {
            setCitySearch("");
            apply(ZERO_ALL, ZERO_ALL);
          }}
        />
      </TableToolbar>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {zeroMetrics(rows).map((m) => (
          <StatTile key={m.label} label={m.label} value={zeroFormat(m.value)} />
        ))}
      </div>

      <div className="rounded-lg border bg-background">
        {/* Две колонки и вложенность: на телефоне — таблицей, не карточками;
            длинные заголовки там переносятся, иначе таблица уезжает вбок. */}
        <Table mobileCards={false}>
          <TableHeader>
            <TableRow>
              <TableHead
                className="max-md:whitespace-normal [&_button]:text-left"
                {...sort.head("name")}
              >
                {TEXTS.name}
              </TableHead>
              <TableHead
                className="text-right max-md:whitespace-normal [&_button]:text-right"
                {...sort.head("sales")}
              >
                {TEXTS.sales}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tree.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2} className="py-8 text-center text-sm text-muted-foreground">
                  {TEXTS.empty}
                </TableCell>
              </TableRow>
            ) : (
              tree.map((city) => {
                const cityOpen = openCities.has(city.name);
                return (
                  <Fragment key={city.name}>
                    <GroupRow
                      level="city"
                      name={city.name}
                      sales={city.sales}
                      open={cityOpen}
                      onToggle={() => setOpenCities((s) => toggle(s, city.name))}
                    />
                    {cityOpen &&
                      city.studios.map((studio) => {
                        const open = openStudios.has(studio.key);
                        return (
                          <Fragment key={studio.key}>
                            <GroupRow
                              level="studio"
                              name={studio.name}
                              sales={studio.sales}
                              open={open}
                              onToggle={() => setOpenStudios((s) => toggle(s, studio.key))}
                            />
                            {open &&
                              studio.products.map((p, i) => (
                                <TableRow key={`${p.code}\u0000${p.product}\u0000${i}`}>
                                  <TableCell className="pl-14">{p.product}</TableCell>
                                  <TableCell className="text-right">
                                    {zeroFormat(p.sales)}
                                  </TableCell>
                                </TableRow>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">{TEXTS.footnote}</p>
    </div>
  );
}

/** Строка города или студии: раскрывается кнопкой со стрелкой или нажатием на строку. */
function GroupRow({
  level,
  name,
  sales,
  open,
  onToggle,
}: {
  level: "city" | "studio";
  name: string;
  sales: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow
      className={cn(
        "cursor-pointer",
        level === "city" ? "bg-muted/40 font-semibold hover:bg-muted/70" : "font-medium",
      )}
      onClick={onToggle}
    >
      <TableCell className={cn(level === "studio" && "pl-8")}>
        <button
          type="button"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="inline-flex items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {name}
        </button>
      </TableCell>
      <TableCell className="text-right">{zeroFormat(sales)}</TableCell>
    </TableRow>
  );
}
