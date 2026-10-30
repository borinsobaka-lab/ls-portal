import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsTop10PageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AN_TITLES } from "@/lib/analytics/labels";
import { anTop10InfoQuery, anTop10Query, saveXlsx, type Top10Info } from "@/lib/analytics/tools";
import {
  buildTop10Workbook,
  top10DefaultMonths,
  top10FileName,
  top10MonthOptions,
  top10MonthsBetween,
  top10Rank,
  top10Rows,
  top10SheetName,
  top10SourceNote,
  TOP10_NOTES_STATIC,
  TOP10_RANKINGS,
  type Top10Ranking,
  type Top10Row,
} from "@/lib/analytics/top10";
import { formatNumber } from "@/lib/format";
import { onecErrorText } from "@/lib/analytics/onec-page";

export const Route = createFileRoute("/_authenticated/analytics/tools/top10")({
  head: () => ({ meta: [{ title: "Топ-10 городов — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsTop10PageSkeleton,
  component: AnalyticsTop10Page,
});

const MAX_MONTHS = 12;

const browserDeflate = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );

/**
 * «Аналитика» → «Инструменты» → «Топ-10 городов» (администратору аналитики) —
 * их выгрузка partner-rankings: по месяцам четыре рейтинга городских групп и
 * лист «Все города», в их Excel. Данные — из отчётов 1С.
 */
function AnalyticsTop10Page() {
  const { data: info, isPending, error } = useQuery(anTop10InfoQuery);

  return (
    <AdminShell title={AN_TITLES.top10}>
      <div className="space-y-4">
        <InfoNote>
          Рейтинги городских групп по месяцам: покупка в день пробного и за 14 дней (конверсия),
          продления и возвращённые (количество покупок). Excel — как их выгрузка «Топ-10»: лист на
          каждый месяц и «Все города». Данные — из отчётов 1С.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{onecErrorText(error)}</InfoNote>
        ) : isPending ? (
          <RankingsSkeleton />
        ) : !info ? (
          <InfoNote variant="warning">
            Данных отчётов пока нет: запустите{" "}
            <Link
              to="/analytics/tools/onec"
              className="font-medium text-foreground underline underline-offset-2"
            >
              «Обработку 1С»
            </Link>{" "}
            и загрузите данные в отчёты.
          </InfoNote>
        ) : (
          <Top10Body info={info} />
        )}
      </div>
    </AdminShell>
  );
}

function Top10Body({ info }: { info: Top10Info }) {
  const options = useMemo(() => top10MonthOptions(info), [info]);
  const initial = useMemo(() => top10DefaultMonths(info), [info]);
  const [from, setFrom] = useState(initial[0] ?? "");
  const [to, setTo] = useState(initial[initial.length - 1] ?? "");
  const months = from && to && from <= to ? top10MonthsBetween(from, to) : [];
  const tooMany = months.length > MAX_MONTHS;
  const { data, isPending, isFetching, error } = useQuery(anTop10Query(tooMany ? [] : months));
  const [tab, setTab] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = tab && months.includes(tab) ? tab : (months[0] ?? "");
  const rows = useMemo(() => (data ? top10Rows(data) : []), [data]);
  const monthRows = rows.filter((r) => r.month === current);
  const ready = info.returned_ready;

  const download = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const bytes = await buildTop10Workbook(data, months, browserDeflate);
      saveXlsx(bytes, top10FileName(months));
    } catch (e) {
      toast.error("Не удалось собрать Excel", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const monthSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-44" aria-label={label}>
        <SelectValue>{value ? top10SheetName(value) : label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {[...options].reverse().map((m) => (
          <SelectItem key={m} value={m}>
            {top10SheetName(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-4">
      {!ready && (
        <InfoNote variant="warning">
          В данных отчётов ещё нет разделения прежних продлений на возвращённых и обычные продления
          — его считает обработка 1С с 30.10.2026. Запустите{" "}
          <Link
            to="/analytics/tools/onec"
            className="font-medium text-foreground underline underline-offset-2"
          >
            «Обработку 1С»
          </Link>{" "}
          и загрузите данные в отчёты — тогда появятся рейтинги продлений и Excel.
        </InfoNote>
      )}
      <TableToolbar>
        {monthSelect(from, setFrom, "Первый месяц")}
        {monthSelect(to, setTo, "Последний месяц")}
        <Button
          className="ml-auto"
          onClick={() => void download()}
          disabled={!ready || !data || isFetching || saving || months.length === 0 || tooMany}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Download />}
          Скачать Excel
        </Button>
      </TableToolbar>
      {from > to ? (
        <InfoNote variant="warning">Начало периода позже конца.</InfoNote>
      ) : tooMany ? (
        <InfoNote variant="warning">Выберите не больше {MAX_MONTHS} месяцев.</InfoNote>
      ) : error ? (
        <InfoNote variant="warning">{onecErrorText(error)}</InfoNote>
      ) : (
        <>
          {months.length > 1 && (
            <Tabs value={current} onValueChange={setTab} activationMode="manual">
              <TabsList aria-label="Месяцы" className="max-w-full overflow-x-auto">
                {months.map((m) => (
                  <TabsTrigger key={m} value={m}>
                    {top10SheetName(m)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            {TOP10_RANKINGS.filter((d) => ready || d.den).map((d) => (
              <RankingCard
                key={d.key}
                ranking={d}
                rows={monthRows}
                loading={isPending || (isFetching && !rows.some((r) => r.month === current))}
              />
            ))}
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {(data ? [top10SourceNote(data)] : []).concat(TOP10_NOTES_STATIC).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RankingsSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {TOP10_RANKINGS.map((d) => (
        <RankingCard key={d.key} ranking={d} rows={[]} loading />
      ))}
    </div>
  );
}

const pct = (n: number, d: number) =>
  `${(Math.round((n / d) * 1000) / 10).toLocaleString("ru-RU", { minimumFractionDigits: 1 })} %`;

/** Блок рейтинга — как на листе месяца: место, город и три значения. */
function RankingCard({
  ranking: d,
  rows,
  loading,
}: {
  ranking: Top10Ranking;
  rows: Top10Row[];
  loading: boolean;
}) {
  const ranked = top10Rank(rows, d);
  const values = (r: Top10Row): string[] =>
    d.key === "day"
      ? [formatNumber(r.day_base), formatNumber(r.bought_day), pct(r.bought_day, r.day_base)]
      : d.key === "window"
        ? [formatNumber(r.window_base), formatNumber(r.bought_14), pct(r.bought_14, r.window_base)]
        : d.key === "renewals"
          ? [formatNumber(r.renewals), formatNumber(r.sales), formatNumber(r.returned)]
          : [formatNumber(r.returned), formatNumber(r.renewals), formatNumber(r.sales)];
  return (
    <section className="rounded-lg border bg-background">
      <h2 className="px-4 pt-3 pb-2 font-semibold">{d.title}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            {d.headers.map((h, i) => (
              <TableHead key={h} className={i === 0 ? "w-16" : i > 1 ? "text-right" : undefined}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={5} rows={10} />
          ) : ranked.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                Нет городов с данными за этот месяц
              </TableCell>
            </TableRow>
          ) : (
            ranked.map((r, i) => (
              <TableRow key={r.city}>
                <TableCell className="tabular-nums">{i + 1}</TableCell>
                <TableCell className="font-medium">{r.city || "—"}</TableCell>
                {values(r).map((v, k) => (
                  <TableCell key={k} className="text-right tabular-nums">
                    {v}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}
