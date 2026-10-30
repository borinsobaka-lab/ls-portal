import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import {
  AnalyticsReviewsBodySkeleton,
  AnalyticsReviewsPageSkeleton,
} from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AN_TITLES } from "@/lib/analytics/labels";
import { rvReportQuery, type RvComment, type RvReport } from "@/lib/analytics/reviews/data";
import {
  formatReviewDate,
  pyFixed,
  ratingBars,
  ratingStars,
  ratingText,
  rvDefaultPeriod,
  rvInitials,
  rvPeriod,
} from "@/lib/analytics/reviews/view";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type ReviewsSearch = { city?: string; from?: string; to?: string };

export const Route = createFileRoute("/_authenticated/analytics/reviews/")({
  head: () => ({ meta: [{ title: "Отзывы и оценки — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): ReviewsSearch => ({
    city: typeof s.city === "string" && s.city ? s.city : undefined,
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
  }),
  pendingComponent: AnalyticsReviewsPageSkeleton,
  component: AnalyticsReviewsPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Комментариев на экране сразу; дальше — «Показать ещё». */
const COMMENTS_PAGE = 60;

/**
 * «Аналитика» → «Отзывы» → «Статистика клиентов» — их reviews_page: оценки
 * занятий по городу и периоду (по умолчанию — текущий месяц), средняя и
 * распределение, тренеры (сначала с более низкой средней), комментарии
 * (сначала с более низкой оценкой). Администратору — все города с оценками,
 * партнёру — свои.
 */
function AnalyticsReviewsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const fallback = rvDefaultPeriod();
  const { from, to } = rvPeriod(search.from ?? fallback.from, search.to ?? fallback.to);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const { data, error, isPending, isFetching } = useQuery(
    rvReportQuery(search.city ?? "", from, to),
  );
  const cities = data?.cities ?? [];
  const city = data?.city ?? "";
  const report = data?.report ?? null;

  return (
    <AdminShell title={AN_TITLES.reviews}>
      <div className="space-y-4">
        <TableToolbar>
          {cities.length === 1 ? (
            <span className="px-1 text-sm">
              <span className="text-muted-foreground">Город </span>
              <b>{city}</b>
            </span>
          ) : (
            <div className="w-56" title="Город">
              <label htmlFor="reviews-city" className="sr-only">
                Город
              </label>
              <SearchableCombobox
                id="reviews-city"
                value={city}
                onChange={(v) =>
                  void navigate({ search: (s: ReviewsSearch) => ({ ...s, city: v }) })
                }
                options={cities.map((c) => ({ value: c, label: c, searchText: c }))}
                placeholder="Город"
                searchPlaceholder="Найти город"
                emptyText="Город не найден"
                disabled={!cities.length}
              />
            </div>
          )}
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период по дате оценки"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                void navigate({
                  search: (s: ReviewsSearch) => ({ ...s, from: toIso(r.from!), to: toIso(r.to!) }),
                });
              } else setDraft(r);
            }}
          />
        </TableToolbar>

        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : isPending ? (
          <AnalyticsReviewsBodySkeleton />
        ) : !report || !report.total ? (
          <div className="space-y-2 rounded-lg border bg-background p-6">
            <h2 className="font-semibold">Оценки по городам</h2>
            <p className="text-sm text-muted-foreground">
              По умолчанию показан текущий месяц. Выберите один день или любой период, чтобы
              посмотреть оценки.
            </p>
            <p className="pt-2 text-sm text-muted-foreground">
              {!city
                ? "Выберите город и период."
                : "По выбранному городу и периоду оценок пока нет."}
            </p>
          </div>
        ) : (
          <div className={cn("space-y-4", isFetching && "opacity-60 transition-opacity")}>
            <p className="text-xs font-semibold tracking-wide text-brand-on-light uppercase">
              Отзывы · {city}
            </p>
            <Overview report={report} />
            <Trainers report={report} />
            <Comments key={`${city}|${from}|${to}`} comments={report.comments} />
          </div>
        )}
      </div>
    </AdminShell>
  );
}

/** Их reviews-overview: средняя со звёздами, распределение, комментарии. */
function Overview({ report }: { report: RvReport }) {
  const bars = ratingBars(report.ratings);
  return (
    <section className="grid gap-6 rounded-lg border bg-background p-5 md:grid-cols-[1fr_1.6fr_1fr]">
      <div>
        <div className="text-4xl font-semibold tabular-nums">{pyFixed(report.average, 1)}</div>
        <div className="mt-1 text-lg tracking-widest text-amber-400" aria-hidden>
          {ratingStars(report.average)}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Средняя оценка на основе {formatNumber(report.total)} отзывов
        </div>
      </div>
      <div className="space-y-1.5" aria-label="Распределение оценок">
        {bars.map((b) => (
          <div key={b.value} className="flex items-center gap-3 text-sm">
            <span className="w-8 shrink-0 tabular-nums">{b.value} ★</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-brand"
                style={{ width: `${b.percent.toFixed(1)}%` }}
              />
            </span>
            <strong className="w-16 shrink-0 text-right font-medium tabular-nums">
              {formatNumber(b.count)}
            </strong>
          </div>
        ))}
      </div>
      <div>
        <div className="text-3xl font-semibold text-brand-on-light tabular-nums">
          {formatNumber(report.comments.length)}
        </div>
        <div className="text-sm">с текстовым комментарием</div>
        <div className="mt-2 text-sm text-muted-foreground">
          {formatNumber(report.negative)} оценок — 3 и ниже
        </div>
      </div>
    </section>
  );
}

/** Их «Статистика по тренерам»: сначала более низкая средняя оценка. */
function Trainers({ report }: { report: RvReport }) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Статистика по тренерам</h2>
        <span className="text-xs text-muted-foreground">Сначала более низкая средняя оценка</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Тренер</TableHead>
            <TableHead className="text-right">Оценок</TableHead>
            <TableHead className="text-right">Средняя</TableHead>
            <TableHead className="text-right">≤ 3</TableHead>
            <TableHead className="text-right">Комментариев</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.trainers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-sm text-muted-foreground">
                Нет данных.
              </TableCell>
            </TableRow>
          ) : (
            report.trainers.map((t) => (
              <TableRow key={t.trainer}>
                <TableCell className="font-medium">{t.trainer}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(t.count)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {pyFixed(t.average, 2)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(t.negative)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(t.comments)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

/** Их «Отзывы клиентов»: карточки, сначала с более низкой оценкой. */
function Comments({ comments }: { comments: RvComment[] }) {
  const [shown, setShown] = useState(COMMENTS_PAGE);
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Отзывы клиентов</h2>
        <span className="text-sm text-muted-foreground">{formatNumber(comments.length)} шт.</span>
      </div>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Нет текстовых комментариев.</p>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {comments.slice(0, shown).map((c) => (
              <CommentCard key={c.id} comment={c} />
            ))}
          </div>
          {shown < comments.length && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setShown((n) => n + COMMENTS_PAGE)}>
                Показать ещё ({formatNumber(comments.length - shown)})
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CommentCard({ comment: c }: { comment: RvComment }) {
  const negative = c.rating <= 3;
  const name = c.client_name || "Клиент";
  return (
    <article
      className={cn(
        "flex flex-col rounded-lg border bg-background p-4",
        c.comment.length >= 330 && "lg:col-span-2",
        negative && "border-destructive/40 bg-destructive/5",
      )}
    >
      <header className="flex items-center gap-3 border-b pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand-on-light">
          {rvInitials(name, "К")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{c.studio}</div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-sm font-semibold tabular-nums",
            negative ? "bg-destructive/10 text-destructive" : "bg-amber-100 text-amber-800",
          )}
        >
          ★ {ratingText(c.rating)}
        </span>
      </header>
      <p className="mt-3 flex-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {c.comment}
      </p>
      <footer className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-3">
        <span>
          <span className="block text-muted-foreground">Тренер</span>
          {c.trainer}
        </span>
        <span>
          <span className="block text-muted-foreground">Направление</span>
          {c.service || "—"}
        </span>
        <span>
          <span className="block text-muted-foreground">Оценка</span>
          {formatReviewDate(c.rating_date)}
        </span>
      </footer>
    </article>
  );
}
