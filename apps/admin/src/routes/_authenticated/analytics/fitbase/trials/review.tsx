import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsFbTrialsReviewBodySkeleton,
  AnalyticsFbTrialsReviewPageSkeleton,
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
import { fbTrialsReviewQuery } from "@/lib/analytics/fitbase/data";
import { fbDefaultPeriod } from "@/lib/analytics/fitbase/reports";
import {
  FB_REVIEW_HEADERS,
  FB_REVIEW_STATUSES,
  FB_REVIEW_TEXT,
  fbReviewCsv,
  fbReviewRows,
} from "@/lib/analytics/fitbase/trials";
import { AN_TITLES } from "@/lib/analytics/labels";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BRANDS = ["Lady Jump", "Lady Stretch"] as const;

type ReviewSearch = {
  from?: string;
  to?: string;
  city?: string;
  studio?: string;
  brand?: (typeof BRANDS)[number];
  status?: string;
};

export const Route = createFileRoute("/_authenticated/analytics/fitbase/trials/review")({
  head: () => ({ meta: [{ title: "Проверка записей FitBase — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): ReviewSearch => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 200) : undefined);
    return {
      from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
      to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
      city: str(s.city),
      studio: typeof s.studio === "string" && /^\d+$/.test(s.studio) ? s.studio : undefined,
      brand: (BRANDS as readonly string[]).includes(s.brand as string)
        ? (s.brand as ReviewSearch["brand"])
        : undefined,
      status: typeof s.status === "string" && s.status in FB_REVIEW_STATUSES ? s.status : undefined,
    };
  },
  pendingComponent: AnalyticsFbTrialsReviewPageSkeleton,
  component: AnalyticsFbTrialsReviewPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = "all";
const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * «Воронка пробных» → «Записи без услуги / абонемента» — их
 * fitbase_trial_review: записи периода, тип которых не определён, с CSV для
 * проверки (без персональных данных клиентов). Право — как у воронки.
 */
function AnalyticsFbTrialsReviewPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const def = fbDefaultPeriod(mskToday());
  const filters = {
    from: search.from ?? def.from,
    to: search.to ?? def.to,
    city: search.city ?? "",
    studio: search.studio ?? "",
    brand: search.brand ?? "",
    status: search.status ?? "",
  };
  const { data, error, isPending, isFetching } = useQuery(fbTrialsReviewQuery(filters));
  const rows = useMemo(() => (data ? fbReviewRows(data) : []), [data]);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const set = (patch: Partial<ReviewSearch>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });
  const connections = data?.connections ?? [];
  const cities = [...new Set(connections.map((c) => c.city))].sort(codeSort);
  const download = () => {
    const blob = new Blob([fbReviewCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fitbase-review.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const back = {
    from: search.from,
    to: search.to,
    city: search.city,
    studio: search.studio,
    brand: search.brand,
  };

  return (
    <AdminShell title={AN_TITLES.fbTrialsReview}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/analytics/fitbase/trials" search={back}>
              <ArrowLeft />
              Вернуться к воронке
            </Link>
          </Button>
        </div>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{FB_REVIEW_TEXT.intro}</p>
          <p>{FB_REVIEW_TEXT.time}</p>
        </div>
        <TableToolbar>
          <DateRangeFilter
            value={draft ?? { from: toDate(filters.from), to: toDate(filters.to) }}
            placeholder="Период"
            showLabel={false}
            title="Период занятий"
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
            <SelectTrigger className="w-48" aria-label="Филиал">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все филиалы</SelectItem>
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
              set({ brand: v === ALL ? undefined : (v as ReviewSearch["brand"]) })
            }
          >
            <SelectTrigger className="w-44" aria-label="Направление">
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
          <Select
            value={filters.status || ALL}
            onValueChange={(v) => set({ status: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-48" aria-label="Статус">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Все статусы</SelectItem>
              {Object.entries(FB_REVIEW_STATUSES).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarReset
            active={Object.values(search).some(Boolean)}
            onReset={() => {
              setDraft(undefined);
              void navigate({ search: {} });
            }}
          />
        </TableToolbar>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? (
          <AnalyticsFbTrialsReviewBodySkeleton />
        ) : (
          <div
            className={cn("space-y-3", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                Найдено записей: <b>{rows.length}</b>
              </p>
              <Button variant="outline" onClick={download}>
                <Download />
                Скачать CSV — все найденные записи
              </Button>
            </div>
            <section className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    {FB_REVIEW_HEADERS.map(([key, title]) => (
                      <TableHead key={key}>{title}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 500).map((row) => (
                    <TableRow key={`${row.branch}|${row.registration_id}`}>
                      {FB_REVIEW_HEADERS.map(([key]) => (
                        <TableCell key={key} className="whitespace-nowrap">
                          {row[key]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  {!rows.length && (
                    <TableRow>
                      <TableCell
                        colSpan={FB_REVIEW_HEADERS.length}
                        className="py-6 text-center text-muted-foreground"
                      >
                        Записей с неопределённым типом нет.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </section>
            {rows.length > 500 && (
              <p className="text-sm text-muted-foreground">{FB_REVIEW_TEXT.limit}</p>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
