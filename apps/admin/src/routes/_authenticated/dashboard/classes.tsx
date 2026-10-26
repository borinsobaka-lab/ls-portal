import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ChartArea, ChartPanel, RankList, type RankItem } from "@/components/dashboard/chart-panel";
import { OTHER_COLOR } from "@/components/dashboard/colors";
import { DashboardShell, type DashboardView } from "@/components/dashboard/dashboard-shell";
import { ScheduleHeatmap } from "@/components/dashboard/heatmap";
import { MetricTable, ShareCell, type MetricRow } from "@/components/dashboard/metric-table";
import { StatGrid, type StatDef } from "@/components/dashboard/stat-cards";
import {
  DashboardClassesPageSkeleton,
  DashboardClassesSkeleton,
} from "@/components/page-skeletons";
import { InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WEEKDAYS,
  avgPerClass,
  classesMetrics,
  classesText,
  classesSeries,
  fillRate,
  heatmap,
  repeatRate,
  showRate,
  tallyBy,
  type ClassEntry,
  type ClassTally,
  type ClassesKey,
} from "@/lib/dashboard-classes";
import { loadClassEntries, type SeriesDef } from "@/lib/dashboard-data";
import type { DetailsSpec } from "@/lib/dashboard-details";
import {
  CLASSES_CHARTS,
  CLASSES_COLUMNS,
  CLASSES_GRID,
  CLASSES_STATS,
  DASHBOARD_HEATMAP_HEIGHT,
  DASHBOARD_TITLES,
  TRAINER_COLUMNS,
  WORKOUT_COLUMNS,
  formatStat,
} from "@/lib/dashboard-stats";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard/classes")({
  head: () => ({ meta: [{ title: "Занятия — Дашборд — Lady Stretch" }] }),
  pendingComponent: DashboardClassesPageSkeleton,
  component: ClassesPage,
});

function ClassesPage() {
  return (
    <DashboardShell title={DASHBOARD_TITLES.classes} skeleton={<DashboardClassesSkeleton />}>
      {(view) => <ClassesBody {...view} />}
    </DashboardShell>
  );
}

/**
 * Графики плиток — занятия за окно графика (12 месяцев / недель, 30 дней),
 * только статусы записей; «Не пришли» и персональные — с карточками
 * записанных: их отчёт — клиенты. У «Клиентов на занятиях» графика нет:
 * разные клиенты по месяцам не складываются.
 */
function seriesDef(
  key: Exclude<ClassesKey, "uniqueClients">,
  kind: SeriesDef["kind"],
  description: string,
  details: DetailsSpec,
  base?: SeriesDef["base"],
): SeriesDef {
  const light = key !== "noShows" && key !== "personal";
  return {
    kind,
    description,
    base,
    details,
    load: async (studioIds, from, to) =>
      classesSeries(await loadClassEntries(studioIds, from, to, light), Date.now(), key, true),
  };
}

const ENTRIES_UNIT: DetailsSpec["unit"] = ["занятие", "занятия", "занятий"];
const VISITS_UNIT: DetailsSpec["unit"] = ["посещение", "посещения", "посещений"];

/** Отчёт по занятиям: число справа — доля или посещения. */
const entries = (
  title: string,
  sort: DetailsSpec["sort"],
  value: Pick<DetailsSpec, "format" | "valueUnit">,
): DetailsSpec => ({ title, unit: ENTRIES_UNIT, sort, empty: "Занятий нет", ...value });

const CLASSES_SERIES: Partial<Record<ClassesKey, SeriesDef>> = {
  fillRate: seriesDef(
    "fillRate",
    "avg",
    "посещения / вместимость групповых занятий",
    entries("Занятия — пустые первыми", "valueAsc", { format: "percent" }),
    { label: "Мест", empty: "нет занятий" },
  ),
  showRate: seriesDef(
    "showRate",
    "avg",
    "«Посетил» / («Посетил» + «Не пришёл»)",
    entries("Занятия — с пропусками первыми", "valueAsc", { format: "percent" }),
    { label: "Отмеченных записей", empty: "нет отметок" },
  ),
  avgPerClass: seriesDef(
    "avgPerClass",
    "avg",
    "посещения / проведённые групповые занятия",
    entries("Занятия — меньше всего посещений первыми", "valueAsc", { valueUnit: VISITS_UNIT }),
    { label: "Занятий", empty: "нет занятий" },
  ),
  visits: seriesDef(
    "visits",
    "count",
    "отмеченные посещения групповых занятий",
    entries("Занятия по посещениям", "value", { valueUnit: VISITS_UNIT }),
  ),
  classes: seriesDef(
    "classes",
    "count",
    "проведённые групповые занятия",
    entries("Проведённые занятия", "dateDesc", { valueUnit: VISITS_UNIT }),
  ),
  personal: seriesDef("personal", "count", "отмеченные посещения персональных тренировок", {
    title: "Кто ходил на персональные",
    unit: ["клиент", "клиента", "клиентов"],
    valueUnit: ["тренировка", "тренировки", "тренировок"],
    dateLabel: "Последняя",
    sort: "value",
    group: true,
    empty: "Персональных нет",
  }),
  cancelRate: seriesDef(
    "cancelRate",
    "avg",
    "отменённые записи / все записи",
    entries("Занятия с отменами записей", "value", {
      valueUnit: ["отмена", "отмены", "отмен"],
    }),
    { label: "Записей", empty: "нет записей" },
  ),
  noShows: seriesDef("noShows", "count", "записи с отметкой «Не пришёл»", {
    title: "Кто не пришёл",
    unit: ["клиент", "клиента", "клиентов"],
    valueUnit: ["пропуск", "пропуска", "пропусков"],
    dateLabel: "Последний",
    sort: "value",
    group: true,
    empty: "Пропусков нет",
  }),
  cancelledClasses: seriesDef("cancelledClasses", "count", "групповые занятия, отменённые клубом", {
    title: "Отменённые занятия",
    unit: ENTRIES_UNIT,
    sort: "dateDesc",
    empty: "Отмен нет",
  }),
};

const STATS: StatDef<ClassesKey>[] = CLASSES_STATS.map((s) => ({
  ...s,
  series: CLASSES_SERIES[s.key],
}));

/** Сортировка таблиц «Тренеры» и «Тренировки». */
const SORTS = {
  visits: { label: "По посещениям", value: (t: ClassTally) => t.visits },
  avg: { label: "По среднему на занятии", value: avgPerClass },
  fill: { label: "По заполняемости", value: fillRate },
  show: { label: "По доходимости", value: showRate },
  repeat: { label: "По повторным визитам", value: repeatRate },
} as const;
type SortKey = keyof typeof SORTS;

const percent = (n: number) => formatStat("percent", n);
const decimal = (n: number) => formatStat("decimal", n);
const ratingFormat = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function ClassesBody(view: DashboardView) {
  const { period, prev, periodEnd } = view;
  const color = view.color;
  const [trainerSort, setTrainerSort] = useState<SortKey>("visits");
  const [workoutSort, setWorkoutSort] = useState<SortKey>("visits");

  const query = useQuery({
    queryKey: ["dashboard", view.scope, "classes", period?.from, period?.to],
    queryFn: async () => {
      const [current, previous] = await Promise.all([
        loadClassEntries(view.clubIds, period!.from, period!.to),
        loadClassEntries(view.clubIds, prev!.from, prev!.to),
      ]);
      return { current, previous };
    },
    enabled: !!period,
    meta: { errorMessage: `${view.name}: не удалось загрузить занятия` },
  });
  // «Сейчас» — момент загрузки: прошедшие занятия не меняются от перерисовок.
  const now = query.dataUpdatedAt;
  const entries = query.data?.current;
  const loading = query.isLoading;
  const error = query.isError;

  const current = useMemo(() => entries && classesMetrics(entries, now), [entries, now]);
  const previous = useMemo(
    () => query.data && classesMetrics(query.data.previous, now),
    [query.data, now],
  );

  const data = useMemo(() => {
    if (!entries) return null;
    const heat = heatmap(entries, now);

    // Тренеры: id → имя и оценка (из любого занятия, где он вёл).
    const trainerInfo = new Map<string, ClassEntry["trainers"][number]>();
    for (const e of entries) for (const t of e.trainers) trainerInfo.set(t.id, t);
    const byTrainer = tallyBy(entries, now, (e) =>
      e.trainers.length ? e.trainers.map((t) => t.id) : ["__none"],
    );

    const workoutInfo = new Map<string, { name: string; color: string | null }>();
    for (const e of entries)
      workoutInfo.set(e.workoutId ?? e.workoutName, { name: e.workoutName, color: e.workoutColor });
    const byWorkout = tallyBy(entries, now, (e) => [e.workoutId ?? e.workoutName]);

    // Слоты расписания: тренировка в свой день недели и время (в своём клубе).
    const slotInfo = new Map<string, { label: string; studioId: string }>();
    const bySlot = tallyBy(entries, now, (e) => {
      const key = [e.studioId, e.workoutId ?? e.workoutName, e.weekday, e.time].join("|");
      const label = `${e.workoutName} · ${WEEKDAYS[e.weekday].toLowerCase()} ${e.time}`;
      slotInfo.set(key, { label, studioId: e.studioId });
      return [key];
    });
    const slots = [...bySlot.entries()].map(([key, t]) => ({
      key,
      label: slotInfo.get(key)?.label ?? key,
      studioId: slotInfo.get(key)?.studioId ?? "",
      value: avgPerClass(t) ?? 0,
      note: slotNote(t),
      visits: t.visits,
      classes: t.classes,
    }));
    const top = [...slots].sort((a, b) => b.value - a.value || b.visits - a.visits).slice(0, 10);
    const topKeys = new Set(top.map((s) => s.key));
    // Слабые — из тех, что не попали в топ: при малом расписании списки не повторяются.
    const weak = slots
      .filter((s) => !topKeys.has(s.key))
      .sort((a, b) => a.value - b.value || b.classes - a.classes)
      .slice(0, 10);

    return { heat, trainerInfo, byTrainer, workoutInfo, byWorkout, top, weak };
  }, [entries, now]);

  // Выбрано несколько клубов — у занятия расписания подпись клуба.
  const clubName = new Map(view.clubs.map((c) => [c.id, c.name]));
  const withClub = (items: (RankItem & { studioId: string })[] | undefined) =>
    view.clubs.length > 1
      ? items?.map((s) => ({ ...s, label: `${s.label} · ${clubName.get(s.studioId) ?? ""}` }))
      : items;

  const trainerRows = useMemo<MetricRow[]>(() => {
    if (!data) return [];
    return sortRows([...data.byTrainer.entries()], trainerSort).map(([id, t]) => {
      const info = data.trainerInfo.get(id);
      return {
        key: id,
        name: info?.name ?? "Без тренера",
        muted: !info,
        values: { name: info?.name, ...tallyValues(t), rating: info?.rating ?? null },
        cells: {
          ...tallyCells(t, color),
          rating:
            info?.rating != null ? (
              <span>
                {ratingFormat.format(info.rating)}
                <span className="text-muted-foreground">
                  {" "}
                  · {formatNumber(info.ratingCount ?? 0)}
                </span>
              </span>
            ) : undefined,
        },
      };
    });
  }, [data, trainerSort, color]);

  const workoutRows = useMemo<MetricRow[]>(() => {
    if (!data) return [];
    return sortRows([...data.byWorkout.entries()], workoutSort).map(([id, t]) => {
      const info = data.workoutInfo.get(id);
      return {
        key: id,
        name: (
          <span className="inline-flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: info?.color || OTHER_COLOR }}
            />
            {info?.name ?? "Без тренировки"}
          </span>
        ),
        values: { name: info?.name, ...tallyValues(t) },
        cells: tallyCells(t, color),
      };
    });
  }, [data, workoutSort, color]);

  const unmarked = current?.unmarked ?? 0;

  return (
    <>
      <StatGrid
        target={view}
        stats={STATS}
        current={current?.metrics ?? {}}
        previous={previous?.metrics ?? {}}
        loading={loading}
        periodEnd={periodEnd}
        className={CLASSES_GRID}
      />

      {unmarked > 0 && (
        <InfoNote variant="warning">
          На прошедших занятиях {formatNumber(unmarked)} {recordsWord(unmarked)} без отметки
          «Посетил» или «Не пришёл» — они не входят в посещения, заполняемость и доходимость.
          Отметьте их в «Расписании».
        </InfoNote>
      )}

      <ChartPanel
        title={CLASSES_CHARTS.heatmap.title}
        tip={CLASSES_CHARTS.heatmap.tip}
        summary={data && data.heat.cells.length > 0 && "человек на занятии в среднем"}
      >
        {loading || error || !data || data.heat.cells.length === 0 ? (
          <ChartArea
            height={DASHBOARD_HEATMAP_HEIGHT}
            loading={loading}
            error={error}
            empty
            emptyText="Нет проведённых занятий за период"
          >
            {null}
          </ChartArea>
        ) : (
          <ScheduleHeatmap {...data.heat} color={color} />
        )}
      </ChartPanel>

      <ChartPanel
        title={CLASSES_CHARTS.trainers.title}
        tip={CLASSES_CHARTS.trainers.tip}
        summary={<SortSelect value={trainerSort} onChange={setTrainerSort} label="тренеров" />}
      >
        <MetricTable
          nameLabel="Тренер"
          columns={TRAINER_COLUMNS.map((k) => ({ key: k, ...CLASSES_COLUMNS[k] }))}
          rows={trainerRows}
          loading={loading}
          error={error}
          emptyText="Нет проведённых занятий за период"
        />
      </ChartPanel>

      <ChartPanel
        title={CLASSES_CHARTS.workouts.title}
        tip={CLASSES_CHARTS.workouts.tip}
        summary={<SortSelect value={workoutSort} onChange={setWorkoutSort} label="тренировок" />}
      >
        <MetricTable
          nameLabel="Тренировка"
          columns={WORKOUT_COLUMNS.map((k) => ({ key: k, ...CLASSES_COLUMNS[k] }))}
          rows={workoutRows}
          loading={loading}
          error={error}
          emptyText="Нет проведённых занятий за период"
        />
      </ChartPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <SlotsPanel
          chart={CLASSES_CHARTS.topSlots}
          items={withClub(data?.top)}
          loading={loading}
          error={error}
          color={color}
          emptyText="Нет проведённых занятий за период"
        />
        <SlotsPanel
          chart={CLASSES_CHARTS.weakSlots}
          items={withClub(data?.weak)}
          loading={loading}
          error={error}
          color={color}
          emptyText={
            data && data.top.length > 0
              ? "Все занятия расписания — в топе слева"
              : "Нет проведённых занятий за период"
          }
        />
      </div>
    </>
  );
}

/** Строки таблицы по выбранному показателю (по убыванию; нет значения — вниз). */
function sortRows(rows: [string, ClassTally][], sort: SortKey) {
  const value = SORTS[sort].value;
  return rows.sort(([, a], [, b]) => (value(b) ?? -1) - (value(a) ?? -1) || b.visits - a.visits);
}

/** Значения колонок для сортировки по заголовку — те же, что в tallyCells. */
function tallyValues(t: ClassTally): NonNullable<MetricRow["values"]> {
  return {
    classes: t.classes,
    visits: t.visits,
    avg: avgPerClass(t),
    fill: fillRate(t),
    show: showRate(t),
    clients: t.clients.size,
    repeat: repeatRate(t),
  };
}

function tallyCells(t: ClassTally, color: string): MetricRow["cells"] {
  const fill = fillRate(t);
  const show = showRate(t);
  const repeat = repeatRate(t);
  const avg = avgPerClass(t);
  return {
    classes: formatNumber(t.classes),
    visits: formatNumber(t.visits),
    avg: avg === null ? undefined : decimal(avg),
    fill: fill === null ? undefined : <ShareCell value={fill} text={percent(fill)} color={color} />,
    show: show === null ? undefined : <ShareCell value={show} text={percent(show)} color={color} />,
    clients: formatNumber(t.clients.size),
    repeat: repeat === null ? undefined : percent(repeat),
  };
}

function slotNote(t: ClassTally) {
  const fill = fillRate(t);
  return fill === null ? classesText(t.classes) : `${classesText(t.classes)} · ${percent(fill)}`;
}

function recordsWord(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "записи";
  return "записей";
}

function SortSelect({
  value,
  onChange,
  label,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as SortKey)}>
      <SelectTrigger className="w-48 text-foreground" aria-label={`Сортировка ${label}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(SORTS) as SortKey[]).map((k) => (
          <SelectItem key={k} value={k}>
            {SORTS[k].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SlotsPanel({
  chart,
  items,
  loading,
  error,
  color,
  emptyText,
}: {
  chart: { title: string; tip: string };
  items: RankItem[] | undefined;
  loading: boolean;
  error: boolean;
  color: string;
  emptyText: string;
}) {
  return (
    <ChartPanel title={chart.title} tip={chart.tip} summary="человек на занятии">
      <RankList
        items={items ?? []}
        loading={loading}
        error={error}
        format={decimal}
        color={color}
        emptyText={emptyText}
      />
    </ChartPanel>
  );
}
