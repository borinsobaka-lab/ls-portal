import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbTrialsBodySkeleton,
  AnalyticsFbTrialsPageSkeleton,
} from "@/components/page-skeletons";
import { TableToolbar, ToolbarReset } from "@/components/table-toolbar";
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
import { mskToday } from "@/lib/analytics/core";
import { startFitbaseTrialsRefresh } from "@/lib/analytics/fitbase.functions";
import { FB_KEY, fbTrialsDataQuery } from "@/lib/analytics/fitbase/data";
import { fbDefaultPeriod, fbTimestamp } from "@/lib/analytics/fitbase/reports";
import {
  FB_TRIAL_LABELS,
  FB_TRIAL_TEXT,
  fbTrialAggregate,
  fbTrialNotes,
  fbTrialNumber,
  fbTrialsReport,
  type FbTrialBucket,
  type FbTrialsData,
} from "@/lib/analytics/fitbase/trials";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BRANDS = ["Lady Jump", "Lady Stretch"] as const;

type TrialsSearch = {
  from?: string;
  to?: string;
  city?: string;
  studio?: string;
  brand?: (typeof BRANDS)[number];
};

export const Route = createFileRoute("/_authenticated/analytics/fitbase/trials/")({
  head: () => ({ meta: [{ title: "Воронка пробных FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): TrialsSearch => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 200) : undefined);
    return {
      from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
      to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
      city: str(s.city),
      studio: typeof s.studio === "string" && /^\d+$/.test(s.studio) ? s.studio : undefined,
      brand: (BRANDS as readonly string[]).includes(s.brand as string)
        ? (s.brand as TrialsSearch["brand"])
        : undefined,
    };
  },
  pendingComponent: AnalyticsFbTrialsPageSkeleton,
  component: AnalyticsFbTrialsPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = "all";
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * «Аналитика» → «FitBase» → «Воронка пробных» — их fitbase_trials.render:
 * записи на пробное, приходы и покупки абонементов в день пробного и за 14
 * дней по городам и студиям, проверка данных, «Записи без услуги». Право
 * «Воронка пробных · FitBase» — вся сеть; «Уточнить пробные» и ссылки на
 * настройки студий — администратору.
 */
function AnalyticsFbTrialsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const def = fbDefaultPeriod(mskToday());
  const filters = {
    from: search.from ?? def.from,
    to: search.to ?? def.to,
    city: search.city ?? "",
    studio: search.studio ?? "",
    brand: search.brand ?? "",
  };
  const { data, error, isPending, isFetching } = useQuery({
    ...fbTrialsDataQuery(filters),
    // Пока идёт общая загрузка — отчёт обновляется сам.
    refetchInterval: (q: { state: { data?: FbTrialsData } }) =>
      q.state.data?.batch?.active ? 20000 : false,
  });
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const set = (patch: Partial<TrialsSearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });
  const connections = data?.connections ?? [];
  const cities = [...new Set(connections.map((c) => c.city))].sort(codeSort);
  const filtered = Object.values(search).some(Boolean);

  return (
    <AdminShell title={AN_TITLES.fbTrials}>
      <div className="space-y-4">
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(filters.from), to: toDate(filters.to) }}
            placeholder="Период"
            showLabel={false}
            title="Период пробных занятий"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                set({ from: toIso(r.from), to: toIso(r.to) });
              } else setDraft(r);
            }}
          />
          <Select
            value={filters.city || ALL}
            onValueChange={(v) => set({ city: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-44" aria-label="Город">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все города</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.studio || ALL}
            onValueChange={(v) => set({ studio: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Студия">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все студии</SelectItem>
              {connections.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.brand || ALL}
            onValueChange={(v) =>
              set({ brand: v === ALL ? undefined : (v as TrialsSearch["brand"]) })
            }
          >
            <SelectTrigger className="w-44" aria-label="Направление сети">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все направления</SelectItem>
              {BRANDS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarReset
            active={filtered}
            onReset={() => {
              setDraft(undefined);
              void navigate({ search: {} });
            }}
          />
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">
            {(error as Error).message}{" "}
            <Link
              to="/analytics/fitbase/trials"
              search={{}}
              className="underline underline-offset-2"
            >
              Вернуться
            </Link>
          </InfoNote>
        ) : !data ? (
          <AnalyticsFbTrialsBodySkeleton />
        ) : (
          <TrialsBody
            data={data}
            filters={filters}
            dim={isFetching && !isPending}
            onRefreshed={() => void qc.invalidateQueries({ queryKey: [...FB_KEY, "trials"] })}
          />
        )}
      </div>
    </AdminShell>
  );
}

function TrialsBody({
  data,
  filters,
  dim,
  onRefreshed,
}: {
  data: FbTrialsData;
  filters: { from: string; to: string; city: string; studio: string; brand: string };
  dim: boolean;
  onRefreshed: () => void;
}) {
  const r = useMemo(() => fbTrialsReport(data), [data]);
  const admin = data.admin;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const busy = Boolean(data.batch?.active);
  const total = r.total;
  const stamps = r.connections.map((c) => c.attendance_synced_at).filter((v): v is number => !!v);
  const updated = stamps.length ? `${fbTimestamp(Math.min(...stamps))} МСК` : "ещё не загружены";
  const allOpen = r.cities.length > 0 && r.cities.every(([name]) => open.has(name));
  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const refresh = async () => {
    setStarting(true);
    try {
      await startFitbaseTrialsRefresh({ data: filters });
      toast.success("Уточнение пробных поставлено в очередь.");
      onRefreshed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const reviewSearch = {
    from: data.from,
    to: data.to,
    city: filters.city || undefined,
    studio: filters.studio || undefined,
    brand: (filters.brand || undefined) as TrialsSearch["brand"],
  };

  return (
    <div className={cn("space-y-4", dim && "opacity-60 transition-opacity")}>
      <p className="text-sm text-muted-foreground">Посещаемость обновлена {updated}</p>
      {busy && (
        <InfoNote>
          <b>Обновление данных выполняется</b> · {data.batch.message || FB_TRIAL_TEXT.busy}
        </InfoNote>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {FB_TRIAL_LABELS.map(([key, label]) => (
          <article key={key} className="min-w-0 rounded-lg border bg-background p-4">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-2xl font-semibold tabular-nums">
              {fbTrialNumber(total, key)}
            </p>
          </article>
        ))}
      </div>
      <section className="rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Воронка по городам и студиям</h2>
            <p className="text-xs text-muted-foreground">Пробные занятия и покупки абонементов</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(allOpen ? new Set() : new Set(r.cities.map(([n]) => n)))}
          >
            {allOpen ? "Свернуть все" : "Раскрыть все"}
          </Button>
        </div>
        <Table mobileCards={false}>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-56">Город / студия</TableHead>
              {FB_TRIAL_LABELS.map(([key, label]) => (
                <TableHead key={key} className="min-w-28 text-right whitespace-normal">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.cities.map(([name, b]) => {
              const members = r.connections
                .filter((c) => c.city === name)
                .sort((x, y) => codeSort(x.name, y.name));
              const isOpen = open.has(name);
              return (
                <Fragment key={name}>
                  <TableRow className="font-medium">
                    <TableCell>
                      <button
                        type="button"
                        className="mr-2 inline-flex size-6 items-center justify-center rounded-full border align-middle"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Свернуть" : "Раскрыть"} город ${name}`}
                        onClick={() => toggle(name)}
                      >
                        {isOpen ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
                      </button>
                      {name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {members.length} студ.
                      </span>
                    </TableCell>
                    <Cells b={b} />
                  </TableRow>
                  {isOpen &&
                    members.map((c) => (
                      <TableRow key={c.id} className="text-muted-foreground">
                        <TableCell className="pl-12">
                          {admin ? (
                            <Link
                              to="/analytics/crm/fitbase/$connectionId"
                              params={{ connectionId: String(c.id) }}
                              className="underline-offset-2 hover:underline"
                            >
                              {c.name}
                            </Link>
                          ) : (
                            c.name
                          )}
                        </TableCell>
                        <Cells b={fbTrialAggregate([r.studios.get(c.id)!])} />
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
            {!r.cities.length && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  Для выбранных фильтров нет подключённых студий.
                </TableCell>
              </TableRow>
            )}
            <TableRow className="bg-muted/30 font-semibold">
              <TableCell>Итого</TableCell>
              <Cells b={total} />
            </TableRow>
          </TableBody>
        </Table>
      </section>
      <details className="rounded-lg border bg-background p-4 text-sm">
        <summary className="cursor-pointer font-medium select-none">
          Проверка данных пробных{" "}
          <span className="font-normal text-muted-foreground">
            · Посещаемость загружена: {total.known} из {total.expected} студий
          </span>
        </summary>
        <p className="mt-2 text-muted-foreground">{FB_TRIAL_TEXT.quality}</p>
        <ul className="mt-2 space-y-1">
          {r.cities.flatMap(([name]) =>
            r.connections
              .filter((c) => c.city === name)
              .sort((x, y) => codeSort(x.name, y.name))
              .map((c) => (
                <li key={c.id}>
                  <b>{c.name}</b>{" "}
                  <span className="text-muted-foreground">
                    {fbTrialNotes(c, r.studios.get(c.id)!, (v) => fbTimestamp(v))}
                  </span>
                </li>
              )),
          )}
        </ul>
      </details>
      {admin && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-4">
          <div className="min-w-0">
            <p className="font-medium">Уточнение данных пробных</p>
            <p className="text-sm text-muted-foreground">{FB_TRIAL_TEXT.refresh}</p>
          </div>
          <Button onClick={() => void refresh()} disabled={busy || starting}>
            {starting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Уточнить пробные по выбранным студиям
          </Button>
        </section>
      )}
      <details className="rounded-lg border bg-background p-4 text-sm">
        <summary className="cursor-pointer font-medium select-none">
          Как считаются показатели
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          {FB_TRIAL_TEXT.rules(total.immature).map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      </details>
      <section className="rounded-lg border bg-background p-4 text-sm">
        <p className="font-medium">Показатели по записям с определённым типом</p>
        <p className="mt-1 text-muted-foreground">{FB_TRIAL_TEXT.separate}</p>
        <Link
          to="/analytics/fitbase/trials/review"
          search={reviewSearch}
          className="mt-2 inline-block font-medium underline underline-offset-2"
        >
          Неопределённый тип: {data.review_count} записей — проверить и выгрузить
        </Link>
      </section>
    </div>
  );
}

function Cells({ b }: { b: FbTrialBucket }) {
  return (
    <>
      {FB_TRIAL_LABELS.map(([key]) => (
        <TableCell key={key} className="text-right whitespace-nowrap tabular-nums">
          {fbTrialNumber(b, key)}
        </TableCell>
      ))}
    </>
  );
}
