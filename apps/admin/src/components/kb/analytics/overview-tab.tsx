import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { ChartArea, ChartPanel, DailyPlot, RankList } from "@/components/dashboard/chart-panel";
import { SERIES_COLORS } from "@/components/dashboard/colors";
import { Delta, EmptyBlock, KpiTile, ReadBar } from "@/components/kb/analytics/parts";
import { useKbOverview } from "@/components/kb/analytics/queries";
import { DocumentText } from "@/components/nav-icons";
import { InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  KB_READ_STATE,
  dayLabels,
  formatAgo,
  formatDuration,
  percentText,
  plural,
  type KbPeriod,
} from "@/lib/kb/analytics";
import { kbSectionIcon } from "@/lib/kb/icons";
import { formatNumber } from "@/lib/format";

const TIPS = {
  coverage:
    "Каждая опубликованная статья × каждый, кто должен её прочитать: сотрудники с доступом к базе из «Доступов», без владельцев и авторов статьи. Прочитано — открыта актуальная версия.",
  readers: "Сотрудники с доступом к базе, которые открывали статьи за период.",
  views: "Сколько раз открывали статьи. Повторное открытие чаще раза в 30 минут не считается.",
  time: "Время, пока статья открыта, вкладка на экране и человек что-то делает — листает, двигает мышь. Простой без действий не считается.",
  completed:
    "Из прочитанных в актуальной версии — сколько пролистали до конца (90% текста и больше).",
  zero: "Сколько раз искали в базе и ничего не нашли — темы, о которых стоит написать.",
  activity: "По дням (по Тбилиси) за выбранный период.",
  sections:
    "Разделы базы — папки верхнего уровня: какая доля положенного прочитана в актуальной версии.",
  attention:
    "Опубликованные статьи, которые прочитали не все: меньше всего прочитанных — выше. «Прежняя версия» — открывали до последней публикации, нового не видели.",
  top: "Самые открываемые статьи за период: открытия, сколько человек и сколько времени.",
  queries: "Самые частые запросы в поиске базы за период.",
};

type Metric = "views" | "readers" | "seconds";
const METRICS: { value: Metric; label: string }[] = [
  { value: "views", label: "Открытия" },
  { value: "readers", label: "Читатели" },
  { value: "seconds", label: "Время" },
];

/**
 * «Обзор» аналитики базы: плитки за период со сравнением, сколько
 * прочитано по базе, активность по дням, разделы, статьи, которые
 * прочитали не все, популярное и поиск.
 */
export function KbOverviewTab({
  baseId,
  period,
  onOpenSearch,
}: {
  baseId: string;
  period: KbPeriod;
  onOpenSearch: () => void;
}) {
  const { data, isLoading, error } = useKbOverview(baseId, period, true);
  const [metric, setMetric] = useState<Metric>("views");

  if (error && !data) return <InfoNote variant="warning">{error.message}</InfoNote>;
  const o = data;
  const loading = isLoading || !o;

  return (
    <div className="space-y-3">
      {o && o.people === 0 && (
        <InfoNote>
          Базу пока никому не выдали в «Доступах» — считать некого: владельцы в аналитике не
          участвуют. Выдайте сотрудникам «Просмотр», и здесь появится, кто что прочитал.
        </InfoNote>
      )}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiTile
          label="Прочитано"
          tip={TIPS.coverage}
          loading={loading}
          value={o ? percentText(o.read_current, o.pairs) : ""}
          hint={o ? `${formatNumber(o.read_current)} из ${formatNumber(o.pairs)}` : undefined}
          delta={<span className="text-xs text-muted-foreground">на сегодня</span>}
        />
        <KpiTile
          label="Читатели"
          tip={TIPS.readers}
          loading={loading}
          value={o ? formatNumber(o.current.readers) : ""}
          hint={o ? `из ${o.people}` : undefined}
          delta={o && <Delta current={o.current.readers} previous={o.previous.readers} />}
        />
        <KpiTile
          label="Открытия статей"
          tip={TIPS.views}
          loading={loading}
          value={o ? formatNumber(o.current.views) : ""}
          delta={o && <Delta current={o.current.views} previous={o.previous.views} />}
        />
        <KpiTile
          label="Время чтения"
          tip={TIPS.time}
          loading={loading}
          value={o ? formatDuration(o.current.seconds) : ""}
          delta={
            o && (
              <Delta
                current={o.current.seconds}
                previous={o.previous.seconds}
                format={formatDuration}
              />
            )
          }
        />
        <KpiTile
          label="Дочитали до конца"
          tip={TIPS.completed}
          loading={loading}
          value={o ? percentText(o.completed, o.read_current) : ""}
          hint={o ? `${formatNumber(o.completed)} прочтений` : undefined}
          delta={<span className="text-xs text-muted-foreground">на сегодня</span>}
        />
        <KpiTile
          label="Поиск без ответа"
          tip={TIPS.zero}
          loading={loading}
          value={o ? formatNumber(o.current.zero_searches) : ""}
          hint={o ? `из ${formatNumber(o.current.searches)} поисков` : undefined}
          delta={
            o && (
              <Delta
                current={o.current.zero_searches}
                previous={o.previous.zero_searches}
                goodWhenUp={false}
              />
            )
          }
        />
      </div>

      <ChartPanel
        title="Прочитано по базе"
        tip={TIPS.coverage}
        summary={
          o &&
          `${plural(o.articles, ["статья", "статьи", "статей"])} · ${plural(o.people, ["сотрудник", "сотрудника", "сотрудников"])}`
        }
      >
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <ReadBar
              current={o.read_current}
              outdated={o.read_outdated}
              total={o.pairs}
              legend
              className="[&>div:first-child]:h-3"
            />
            {o.never_read > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Никто ни разу не открывал: {plural(o.never_read, ["статья", "статьи", "статей"])}.
              </p>
            )}
          </>
        )}
      </ChartPanel>

      <ChartPanel
        title="Активность по дням"
        tip={TIPS.activity}
        summary={
          o &&
          (metric === "seconds"
            ? formatDuration(o.current.seconds)
            : metric === "views"
              ? `${formatNumber(o.current.views)} открытий`
              : `${formatNumber(o.current.readers)} за период`)
        }
      >
        <SegmentedControl
          aria-label="Показатель графика"
          value={metric}
          onChange={setMetric}
          options={METRICS}
          className="mb-3"
        />
        <ChartArea
          height={220}
          loading={loading}
          empty={!!o && o.daily.every((d) => d[metric] === 0)}
          emptyText="За период статьи не открывали"
        >
          {o && (
            <DailyPlot
              data={o.daily.map((d) => ({
                ...dayLabels(d.day),
                value: metric === "seconds" ? Math.round(d.seconds / 60) : d[metric],
              }))}
              color="var(--brand)"
              format={(n) =>
                metric === "seconds"
                  ? formatDuration(n * 60)
                  : metric === "views"
                    ? `${formatNumber(n)} открытий`
                    : `${formatNumber(n)} чел.`
              }
            />
          )}
        </ChartArea>
        {metric === "seconds" && (
          <p className="mt-1 text-xs text-muted-foreground">Время — в минутах.</p>
        )}
      </ChartPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel title="Разделы" tip={TIPS.sections}>
          {loading ? (
            <ListSkeleton />
          ) : o.sections.length === 0 ? (
            <EmptyBlock>В базе пока нет разделов с опубликованными статьями</EmptyBlock>
          ) : (
            <ul className="space-y-3">
              {o.sections.map((s) => {
                const Icon = kbSectionIcon(s.icon);
                return (
                  <li key={s.id}>
                    <div className="mb-1 flex items-center gap-2 text-sm">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <Link
                        to="/kb/$baseId/$nodeId"
                        params={{ baseId, nodeId: s.id }}
                        className="min-w-0 flex-1 truncate font-medium hover:underline"
                      >
                        {s.title}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {s.articles} ст. ·{" "}
                        <b className="text-foreground">{percentText(s.read_current, s.pairs)}</b>
                      </span>
                    </div>
                    <ReadBar current={s.read_current} outdated={s.read_outdated} total={s.pairs} />
                  </li>
                );
              })}
            </ul>
          )}
        </ChartPanel>

        <ChartPanel title="Прочитали не все" tip={TIPS.attention}>
          {loading ? (
            <ListSkeleton />
          ) : o.attention.length === 0 ? (
            <EmptyBlock>
              {o.pairs ? "Все статьи прочитаны в актуальной версии" : "Пока нечего считать"}
            </EmptyBlock>
          ) : (
            <ul className="divide-y">
              {o.attention.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <DocumentText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <Link
                      to="/kb/$baseId/$nodeId"
                      params={{ baseId, nodeId: a.id }}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {a.title || "Без названия"}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {a.published_at && `Опубликована ${formatAgo(a.published_at)}`}
                      {a.read_outdated > 0 && (
                        <span className="text-amber-700 dark:text-amber-300">
                          {a.published_at && " · "}
                          {a.read_outdated} читали прежнюю версию
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="w-24 shrink-0">
                    <span className="mb-1 block text-right text-xs tabular-nums">
                      <b>{a.read_current}</b>
                      <span className="text-muted-foreground"> из {a.audience}</span>
                    </span>
                    <ReadBar
                      current={a.read_current}
                      outdated={a.read_outdated}
                      total={a.audience}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ChartPanel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartPanel title="Популярные статьи" tip={TIPS.top}>
          <RankList
            loading={loading}
            items={(o?.top_articles ?? []).map((a) => ({
              key: a.id,
              label: a.title || "Без названия",
              value: a.views,
              note: `${a.readers} чел. · ${formatDuration(a.seconds)}`,
            }))}
            format={(n) => formatNumber(n)}
            color={SERIES_COLORS[0]}
            emptyText="За период статьи не открывали"
            rows={5}
          />
        </ChartPanel>
        <ChartPanel
          title="Что ищут"
          tip={TIPS.queries}
          summary={
            o && o.zero_queries.length > 0 ? (
              <button
                type="button"
                onClick={onOpenSearch}
                className="cursor-pointer font-medium text-amber-700 dark:text-amber-300 underline"
              >
                Не нашли: {o.zero_queries.length}
              </button>
            ) : undefined
          }
        >
          <RankList
            loading={loading}
            items={(o?.top_queries ?? []).slice(0, 5).map((q) => ({
              key: q.query,
              label: `«${q.query}»`,
              value: q.count,
              note: q.results === 0 ? "ничего не нашлось" : `${q.users} чел.`,
            }))}
            format={(n) => `${formatNumber(n)} раз`}
            color={KB_READ_STATE.outdated.color}
            emptyText="За период в базе не искали"
            rows={5}
          />
        </ChartPanel>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i}>
          <Skeleton className="mb-1.5 h-4 w-2/3" />
          <Skeleton className="h-2 w-full" />
        </div>
      ))}
    </div>
  );
}
