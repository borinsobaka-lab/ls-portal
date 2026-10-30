import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { AnalyticsStaffStatsPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { rvStaffReportQuery, type RvStaffResponse } from "@/lib/analytics/reviews/data";
import { pyFixed, rvDefaultPeriod, rvInitials, rvPeriod } from "@/lib/analytics/reviews/view";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type StaffStatsSearch = { from?: string; to?: string };

export const Route = createFileRoute("/_authenticated/analytics/reviews/staff/statistics")({
  head: () => ({ meta: [{ title: "Отзывы партнёров — Аналитика — Lady Stretch" }] }),
  validateSearch: (s: Record<string, unknown>): StaffStatsSearch => ({
    from: typeof s.from === "string" && ISO.test(s.from) ? s.from : undefined,
    to: typeof s.to === "string" && ISO.test(s.to) ? s.to : undefined,
  }),
  pendingComponent: AnalyticsStaffStatsPageSkeleton,
  component: AnalyticsStaffStatsPage,
});

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Их поиск: подстрока без регистра (строка таблицы — весь её текст). */
const includes = (text: string, q: string) => !q || text.toLocaleLowerCase("ru").includes(q);

/**
 * «Аналитика» → «Отзывы» → «Статистика сотрудников» (администратору
 * аналитики) — их staff_feedback_page: ответы партнёров по формам сотрудников
 * за период (по умолчанию — текущий месяц по Москве): по сотрудникам —
 * средние по двум вопросам и общая («NPS» у них), сначала с меньшей общей;
 * ниже — ответы, новые сверху. Поиск — по сотруднику, партнёру и городу.
 */
function AnalyticsStaffStatsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const fallback = rvDefaultPeriod();
  const { from, to } = rvPeriod(search.from ?? fallback.from, search.to ?? fallback.to);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const [query, setQuery] = useState("");
  const { data, error, isPending, isFetching } = useQuery(rvStaffReportQuery(from, to));
  const q = query.trim().toLocaleLowerCase("ru");
  const employees = (data?.employees ?? []).filter((e) =>
    includes(
      `${e.name} ${e.position || "—"} ${e.count} ${pyFixed(e.professionalism_average, 1)}/5 ${pyFixed(e.next_steps_average, 1)}/5 ${pyFixed(e.overall_average, 1)}/5 ${e.comments}`,
      q,
    ),
  );
  const responses = (data?.responses ?? []).filter((r) =>
    includes(
      `${r.full_name} ${r.partner_name || "Не указано"} ${r.partner_city || "Не указано"}`,
      q,
    ),
  );

  return (
    <AdminShell title={AN_TITLES.staffStats}>
      <div className="space-y-4">
        <TableToolbar>
          <ToolbarSearch value={query} onChange={setQuery} placeholder="Поиск по сотруднику" />
          <DateRangeFilter
            value={draft ?? { from: toDate(from), to: toDate(to) }}
            placeholder="Период"
            showLabel={false}
            title="Период по дате ответа"
            onChange={(r) => {
              if (r?.from && r.to) {
                setDraft(undefined);
                void navigate({
                  search: (s: StaffStatsSearch) => ({
                    ...s,
                    from: toIso(r.from!),
                    to: toIso(r.to!),
                  }),
                });
              } else setDraft(r);
            }}
          />
        </TableToolbar>

        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <div
            className={cn("space-y-4", isFetching && !isPending && "opacity-60 transition-opacity")}
          >
            <section className="rounded-lg border bg-background">
              <div className="border-b px-4 py-3">
                <h2 className="text-lg font-semibold">Статистика сотрудников</h2>
                <p className="text-sm text-muted-foreground">
                  Всего ответов за период: {isPending ? "…" : formatNumber(data?.total ?? 0)}.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Сотрудник</TableHead>
                    <TableHead className="text-right">Ответов</TableHead>
                    <TableHead className="text-right">Вопрос 1</TableHead>
                    <TableHead className="text-right">Вопрос 2</TableHead>
                    <TableHead className="text-right">NPS</TableHead>
                    <TableHead className="text-right">Рекомендаций</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isPending ? (
                    <TableSkeletonRows columns={6} rows={4} />
                  ) : employees.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-sm text-muted-foreground">
                        {data?.employees.length
                          ? "Сотрудники не найдены."
                          : "За выбранный период ответов пока нет."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    employees.map((e) => (
                      <TableRow key={e.name}>
                        <TableCell>
                          <div className="font-medium">{e.name}</div>
                          <div className="text-xs text-muted-foreground">{e.position || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(e.count)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {pyFixed(e.professionalism_average, 1)}/5
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {pyFixed(e.next_steps_average, 1)}/5
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {pyFixed(e.overall_average, 1)}/5
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(e.comments)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </section>

            {!isPending && (
              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold">Комментарии</h2>
                  <span className="text-sm text-muted-foreground">Новые сверху</span>
                </div>
                {responses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {data?.responses.length
                      ? "Ответы не найдены."
                      : "Комментариев и ответов пока нет."}
                  </p>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {responses.map((r) => (
                      <ResponseCard key={r.id} response={r} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

/** Их staff-response: кто, две оценки, рекомендации, партнёр и время. */
function ResponseCard({ response: r }: { response: RvStaffResponse }) {
  return (
    <article className="flex min-w-0 flex-col rounded-lg border bg-background p-4">
      <header className="flex items-center gap-3 border-b pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand-on-light">
          {rvInitials(r.full_name, "С")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{r.full_name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {r.position || "Должность не указана"}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-amber-100 px-2.5 py-1 text-right text-xs leading-5 font-semibold text-amber-800 tabular-nums">
          Проф. ★ {r.professionalism_rating}/5
          <br />
          Шаги ★ {r.next_steps_rating}/5
        </span>
      </header>
      <div className="mt-3 flex-1 space-y-3 text-sm">
        <div>
          <div className="font-medium">Профессионализм сотрудника</div>
          <p className="mt-1 leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {r.professionalism_comment.trim() || "—"}
          </p>
        </div>
        <div>
          <div className="font-medium">Следующие шаги после созвона</div>
          <p className="mt-1 leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {r.next_steps_comment.trim() || "—"}
          </p>
        </div>
      </div>
      <footer className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-3">
        <span className="min-w-0 break-words">
          <span className="block text-muted-foreground">Партнёр</span>
          {r.partner_name || "Не указано"}
        </span>
        <span className="min-w-0 break-words">
          <span className="block text-muted-foreground">Город</span>
          {r.partner_city || "Не указано"}
        </span>
        <span>
          <span className="block text-muted-foreground">Дата и время отзыва</span>
          {formatMsk(r.submitted_at)}
        </span>
      </footer>
    </article>
  );
}
