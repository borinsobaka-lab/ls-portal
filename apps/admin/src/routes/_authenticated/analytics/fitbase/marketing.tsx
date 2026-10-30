import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { MapPin } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbMarketingBodySkeleton,
  AnalyticsFbMarketingPageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { FieldHint } from "@/components/ui/field-hint";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { mskToday } from "@/lib/analytics/core";
import { fbMarketingDataQuery } from "@/lib/analytics/fitbase/data";
import {
  fbDefaultPeriod,
  fbMarketingCities,
  fbPeriodOk,
  fbTimestamp,
  type FbMarketingCells,
  type FbMarketingCity,
} from "@/lib/analytics/fitbase/reports";
import { FB_BRANDS } from "@/lib/analytics/fitbase/rules";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type MarketingSearch = { from?: string; to?: string; brand?: string; city?: string };

export const Route = createFileRoute("/_authenticated/analytics/fitbase/marketing")({
  head: () => ({ meta: [{ title: "Маркетинговый отчёт FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): MarketingSearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
    brand: (FB_BRANDS as readonly string[]).includes(s.brand as string)
      ? (s.brand as string)
      : undefined,
    city: typeof s.city === "string" && s.city.trim() ? s.city.slice(0, 200) : undefined,
  }),
  pendingComponent: AnalyticsFbMarketingPageSkeleton,
  component: AnalyticsFbMarketingPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = "all";
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Их подсказка «i» у карточки города. */
const CITY_TIP =
  "Все заявки, включая повторные, включены в итоги. Автообновление ежедневно в 01:00 МСК. Данные последней успешной загрузки FitBase.";

/** Их колонки (report_headers). */
const HEADERS: [keyof FbMarketingCells, string][] = [
  ["source", "Рекламный канал"],
  ["budget", "Бюджет"],
  ["leads", "Лиды"],
  ["lead_price", "Цена лида"],
  ["booked", "Записались"],
  ["lead_booked", "Лид → запись"],
  ["attended", "Пришли"],
  ["booked_attended", "Запись → визит"],
  ["paid", "Купили"],
  ["attended_paid", "Визит → покупка"],
  ["lead_paid", "Лид → покупка"],
  ["sale_price", "Стоимость продажи"],
];
const RATES = new Set(["lead_booked", "booked_attended", "attended_paid", "lead_paid"]);

/**
 * «Аналитика» → «FitBase» → «Маркетинговый отчёт» — их fitbase_report_page:
 * лиды студий направления за период по городам и рекламным каналам (правила
 * этапов и источников из «Интеграции FitBase»), бюджеты VK из реестра
 * таргета, конверсии и дубли по источникам. Право «Маркетинг · FitBase» —
 * вся сеть, только просмотр.
 */
function AnalyticsFbMarketingPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const def = fbDefaultPeriod(mskToday());
  const from = search.from ?? def.from;
  const to = search.to ?? def.to;
  const city = search.city ?? "";
  const valid = fbPeriodOk(from, to);
  const { data, error, isPending, isFetching } = useQuery({
    ...fbMarketingDataQuery(search.brand ?? "", from, to),
    enabled: valid,
  });
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const cities = useMemo(() => (data ? fbMarketingCities(data, city) : []), [data, city]);
  const brand = data?.brand ?? search.brand ?? "Lady Stretch";
  const cityOptions = data
    ? [...new Set(data.connections.filter((c) => c.brand === brand).map((c) => c.city))].sort(
        codeSort,
      )
    : [];
  const set = (patch: Partial<MarketingSearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });

  return (
    <AdminShell title={AN_TITLES.fbMarketing}>
      <div className="space-y-4">
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период отчёта: с даты по дату включительно"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                set({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          <Select value={brand} onValueChange={(v) => set({ brand: v, city: undefined })}>
            <SelectTrigger className="w-44" aria-label="Направление">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FB_BRANDS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={city || ALL}
            onValueChange={(v) => set({ city: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все города</SelectItem>
              {cityOptions.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableToolbar>
        {!valid ? (
          <InfoNote variant="warning">
            Выберите корректный период: начало не позже конца, не больше 366 дней.
          </InfoNote>
        ) : error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? (
          <AnalyticsFbMarketingBodySkeleton />
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            {cities.length ? (
              cities.map((c) => <CityCard key={c.city} c={c} />)
            ) : (
              <section className="rounded-lg border bg-background p-6 text-center">
                <h2 className="font-semibold">Нет данных за выбранный период</h2>
                <p className="text-sm text-muted-foreground">
                  Обновите данные подключённых студий и проверьте период.
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function CityCard({ c }: { c: FbMarketingCity }) {
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <MapPin className="mt-1 size-5 shrink-0 text-brand-on-light" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{c.city}</h2>
            <p className="text-sm text-muted-foreground">Эффективность рекламных каналов</p>
            {c.partners && <p className="text-sm">{c.partners}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip tone="neutral">{c.channels.length} каналов</StatusChip>
          <FieldHint>{CITY_TIP}</FieldHint>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ["leads", "Лиды"],
            ["booked", "Записались"],
            ["attended", "Пришли"],
            ["paid", "Купили"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold tabular-nums">{c.overview[key]}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border">
        <Table mobileCards={false}>
          <TableHeader>
            <TableRow>
              {HEADERS.map(([key, label]) => (
                <TableHead key={key} className={key === "source" ? "min-w-44" : "text-right"}>
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.channels.map((row, i) => (
              <ChannelRow key={i} row={row} />
            ))}
            {!c.channels.length && (
              <TableRow>
                <TableCell colSpan={12} className="py-4 text-center text-muted-foreground">
                  {c.loaded
                    ? "За выбранный период лидов нет."
                    : "Данные ещё не загружены. В интеграции FitBase проверьте доступ, выберите клуб и обновите данные."}
                </TableCell>
              </TableRow>
            )}
            <ChannelRow row={c.total} total />
          </TableBody>
        </Table>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer select-none">
          Дубли по источникам <StatusChip tone="neutral">{c.duplicateCount}</StatusChip>
        </summary>
        <p className="mt-2 text-muted-foreground">
          Повторные заявки уже учтены в лидах и итогах. Число рядом с сочетанием источников — общие
          сделки: один клиент с повторными заявками в одной студии за выбранный период считается
          здесь один раз.
        </p>
        {c.duplicates.length ? (
          <ul className="mt-2 space-y-1">
            {c.duplicates.map((d) => (
              <li key={d.names} className="flex justify-between gap-2">
                <span>{d.names}</span>
                <strong className="tabular-nums">{d.count}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2">За выбранный период дублей нет.</p>
        )}
      </details>
      <p className="text-xs text-muted-foreground">
        {c.syncedAt
          ? `Последние данные: ${fbTimestamp(c.syncedAt)}`
          : "Первая загрузка ещё не завершена."}
      </p>
    </section>
  );
}

function ChannelRow({ row, total = false }: { row: FbMarketingCells; total?: boolean }) {
  return (
    <TableRow className={cn(total && "bg-muted/30 font-semibold")}>
      {HEADERS.map(([key]) => {
        const value = row[key];
        const muted = value === "—" || value === "0" || value === "0%";
        return (
          <TableCell
            key={key}
            className={cn(
              key !== "source" && "text-right whitespace-nowrap tabular-nums",
              RATES.has(key) && "font-medium",
              muted && "text-muted-foreground",
              value === "100%" && "text-emerald-700",
            )}
          >
            {value}
          </TableCell>
        );
      })}
    </TableRow>
  );
}
