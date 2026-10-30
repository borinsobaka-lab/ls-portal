import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsMktBodySkeleton } from "@/components/page-skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
import { FieldHint } from "@/components/ui/field-hint";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { amoMarketingQuery } from "@/lib/analytics/amo/data";
import {
  MKT_RESULTS,
  MKT_TEXT,
  mktGroups,
  mktKpis,
  mktModeNote,
  type MktBrand,
  type MktCells,
  type MktGroup,
  type MktResult,
  type MktSearch,
} from "@/lib/analytics/amo/marketing";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/**
 * «Аналитика» → «CRM» → «Маркетинг Lady Stretch / Lady Jump» — их
 * marketing_report_page: когорта лидов месяца создания сделки amoCRM по
 * городам, партнёрам и рекламным каналам, «на 1-е число» (срез) или «на
 * сегодня». Фильтры — в адресе и применяются сразу (у них — по кнопке
 * режима). Партнёру — без выбора партнёра, только его города.
 */
export function MarketingReport({
  brand,
  title,
  search,
  onSearch,
}: {
  brand: MktBrand;
  title: string;
  search: MktSearch;
  onSearch: (patch: Partial<MktSearch>) => void;
}) {
  const result: MktResult = search.result ?? "today";
  const { data, error, isPending, isFetching } = useQuery(
    amoMarketingQuery({
      brand,
      month: search.month,
      city: search.city,
      partner: search.partner,
      result,
    }),
  );
  const groups = data ? mktGroups(data) : [];
  const kpis = data ? mktKpis(data.rows) : [];
  const months = data ? (data.months.length ? data.months : [data.month]) : [];
  const filtered = !!(search.month || search.city || search.partner);

  return (
    <AdminShell title={title}>
      <div className="space-y-4">
        <InfoNote>
          {MKT_TEXT.lead}
          {data?.limited && <span className="mt-1 block">{MKT_TEXT.limited}</span>}
        </InfoNote>
        <TableToolbar>
          <Select
            value={data?.month ?? search.month ?? ""}
            onValueChange={(v) => onSearch({ month: v })}
            disabled={!data}
          >
            <SelectTrigger className="w-36" aria-label="Месяц">
              <SelectValue placeholder="Месяц" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={data?.city || ALL}
            onValueChange={(v) => onSearch({ city: v === ALL ? undefined : v })}
            disabled={!data}
          >
            <SelectTrigger className="w-56" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{MKT_TEXT.allCities}</SelectItem>
              {data?.cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!data?.is_partner && (
            <Select
              value={data?.partner || ALL}
              onValueChange={(v) => onSearch({ partner: v === ALL ? undefined : v })}
              disabled={!data}
            >
              <SelectTrigger className="w-56" aria-label="Партнёр">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{MKT_TEXT.allPartners}</SelectItem>
                {data?.partners.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <SegmentedControl
            aria-label="Дата результата"
            value={result}
            onChange={(v) => onSearch({ result: v === "first" ? "first" : undefined })}
            options={MKT_RESULTS}
          />
          <ToolbarReset
            active={filtered}
            onReset={() => onSearch({ month: undefined, city: undefined, partner: undefined })}
          />
        </TableToolbar>
        {data && (
          <p className="text-sm text-muted-foreground">{mktModeNote(data.result, data.snapshot)}</p>
        )}

        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? (
          <AnalyticsMktBodySkeleton />
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {kpis.map((k) => (
                <StatTile key={k.label} label={k.label} value={k.value} note={k.note} />
              ))}
            </div>
            {groups.length === 0 ? (
              <section className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
                {MKT_TEXT.empty}
              </section>
            ) : (
              groups.map((g) => <CityBlock key={g.key} g={g} />)
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

/** Их 14 колонок воронки по каналу. */
const COLUMNS: { label: string; cell: (c: MktCells) => ReactNode }[] = [
  { label: "Рекламный канал", cell: (c) => c.source },
  { label: "Бюджет", cell: (c) => c.budget },
  { label: "Лиды", cell: (c) => c.leads },
  { label: "Цена лида", cell: (c) => c.cpl },
  { label: "Квал.", cell: (c) => c.qualified },
  { label: "Лид → квал.", cell: (c) => c.leadToQualified },
  { label: "Запис.", cell: (c) => c.booked },
  { label: "Квал. → запись", cell: (c) => c.qualifiedToBooked },
  { label: "Пришли", cell: (c) => c.attended },
  { label: "Запись → пришли", cell: (c) => c.bookedToAttended },
  { label: "Купили", cell: (c) => c.paid },
  { label: "Пришли → купили", cell: (c) => c.attendedToPaid },
  { label: "Квал. → купили", cell: (c) => c.qualifiedToPaid },
  { label: "Стоимость продажи", cell: (c) => c.costPerSale },
];

/** Их marketing-city-block: город, партнёр, каналы с подсказкой о квалификации, таблица. */
function CityBlock({ g }: { g: MktGroup }) {
  return (
    <section className="rounded-lg border bg-background">
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4 pb-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{g.city}</h2>
          <p className="text-sm text-muted-foreground">{g.partner}</p>
        </div>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          Рекламные каналы: {g.channels}
          <FieldHint>{g.qualification}</FieldHint>
        </span>
      </header>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            {COLUMNS.map((c, i) => (
              <TableHead
                key={c.label}
                className={cn(
                  "h-auto py-2 text-[11px] leading-tight whitespace-normal",
                  i === 0 ? "min-w-40" : "text-center",
                )}
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...g.rows, g.total].map((r, ri) => {
            const total = ri === g.rows.length;
            return (
              <TableRow key={ri} className={cn(total && "bg-muted/40 font-semibold")}>
                {COLUMNS.map((c, i) => (
                  <TableCell
                    key={c.label}
                    className={cn(
                      "tabular-nums",
                      i === 0 ? "font-medium" : "text-center whitespace-nowrap",
                      total && i === 0 && "text-brand-on-light",
                    )}
                  >
                    {c.cell(r)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
