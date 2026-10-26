import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { CityTreeTable } from "@/components/analytics/city-tree";
import { EmptyBlock, KpiGrid, KpiTile, TableCard } from "@/components/analytics/parts";
import {
  AnalyticsClassesBodySkeleton,
  AnalyticsClassesPageSkeleton,
} from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
import { InfoNote } from "@/components/ui/form-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { classesQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, CLASSES_TILES } from "@/lib/analytics/labels";
import {
  change,
  classesSummary,
  directionLines,
  formatAvg,
  formatRate,
  shiftPeriod,
  type ClassesSummary,
} from "@/lib/analytics/logic";
import { formatNumber } from "@/lib/format";
import { sortRows } from "@/lib/table-sort";

export const Route = createFileRoute("/_authenticated/analytics/classes")({
  head: () => ({ meta: [{ title: "Занятия — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsClassesPageSkeleton,
  component: ClassesPage,
});

const num = "text-right [&>span]:justify-end";

function ClassesPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.classes}
      kinds={["classes"]}
      skeleton={<AnalyticsClassesBodySkeleton />}
    >
      {(view) => <ClassesBody {...view} />}
    </AnalyticsShell>
  );
}

function ClassesBody({ studios, ids, idSet, period, today, update }: AnalyticsView) {
  const cur = useQuery(classesQuery(ids, period, "month"));
  const pm = useQuery(classesQuery(ids, shiftPeriod(period, -1), "month"));
  const py = useQuery(classesQuery(ids, shiftPeriod(period, -12), "month"));
  const dirSort = useTableSort();

  if (cur.isError)
    return <InfoNote variant="warning">Не удалось загрузить занятия. Обновите страницу.</InfoNote>;

  const loading = cur.isLoading;
  const s = cur.data && classesSummary(cur.data, idSet);
  const sm = pm.data && classesSummary(pm.data, idSet);
  const sy = py.data && classesSummary(py.data, idSet);
  // Как у Lady Stretch: изменение средних и доходимости — относительное, %.
  const tile = (
    k: keyof ClassesSummary & keyof typeof CLASSES_TILES,
    show: (x: ClassesSummary) => string,
  ) => (
    <KpiTile
      key={k}
      {...CLASSES_TILES[k]}
      loading={loading}
      value={s && show(s)}
      deltas={[
        { label: "к пр. месяцу", value: s && sm ? change(s[k], sm[k]) : null },
        { label: "к пр. году", value: s && sy ? change(s[k], sy[k]) : null },
      ]}
    />
  );
  const directions = cur.data ? directionLines(cur.data, idSet) : [];
  const sorted = sortRows(directions, dirSort.sort, {
    name: (d) => d.name,
    classes: (d) => d.classes,
    booked: (d) => d.booked,
    attended: (d) => d.attended,
    avg: (d) => d.avgAttended,
    attendance: (d) => d.attendance,
  });

  return (
    <div className="space-y-3">
      <KpiGrid cols={6}>
        {tile("classes", (x) => formatNumber(x.classes))}
        {tile("booked", (x) => formatNumber(x.booked))}
        {tile("attended", (x) => formatNumber(x.attended))}
        {tile("avgBooked", (x) => formatAvg(x.avgBooked))}
        {tile("avgAttended", (x) => formatAvg(x.avgAttended))}
        {tile("attendance", (x) => formatRate(x.attendance, 1))}
      </KpiGrid>
      <TableCard title="Города и студии">
        <CityTreeTable
          studios={studios}
          today={today}
          loading={loading || !cur.data}
          compute={(set) => classesSummary(cur.data ?? [], set)}
          onPick={(st) => update({ clubId: st.id })}
          columns={[
            {
              key: "classes",
              label: "Занятий",
              tip: CLASSES_TILES.classes.tip,
              render: (v) => formatNumber(v.classes),
              sort: (v) => v.classes,
            },
            {
              key: "booked",
              label: "Записано",
              tip: CLASSES_TILES.booked.tip,
              render: (v) => formatNumber(v.booked),
              sort: (v) => v.booked,
            },
            {
              key: "attended",
              label: "Посетило",
              tip: CLASSES_TILES.attended.tip,
              render: (v) => formatNumber(v.attended),
              sort: (v) => v.attended,
            },
            {
              key: "avg",
              label: "На занятии",
              tip: CLASSES_TILES.avgAttended.tip,
              render: (v) => formatAvg(v.avgAttended),
              sort: (v) => v.avgAttended,
            },
            {
              key: "attendance",
              label: "Доходимость",
              tip: CLASSES_TILES.attendance.tip,
              render: (v) => formatRate(v.attendance, 1),
              sort: (v) => v.attendance,
            },
          ]}
        />
      </TableCard>
      <TableCard title="Направления" tip="Проведённые занятия по направлениям.">
        {!loading && directions.length === 0 ? (
          <EmptyBlock />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead {...dirSort.head("name")}>Направление</TableHead>
                <TableHead className={num} {...dirSort.head("classes")}>
                  Занятий
                </TableHead>
                <TableHead className={num} {...dirSort.head("booked")}>
                  Записано
                </TableHead>
                <TableHead className={num} {...dirSort.head("attended")}>
                  Посетило
                </TableHead>
                <TableHead className={num} {...dirSort.head("avg")}>
                  На занятии
                </TableHead>
                <TableHead className={num} {...dirSort.head("attendance")}>
                  Доходимость
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={6} rows={5} />
              ) : (
                sorted.map((d) => (
                  <TableRow key={d.key}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.classes)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.booked)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.attended)}</TableCell>
                    <TableCell className="text-right">{formatAvg(d.avgAttended)}</TableCell>
                    <TableCell className="text-right">{formatRate(d.attendance, 1)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
