import { Fragment } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AnalyticsShell, type AnalyticsView } from "@/components/analytics/analytics-shell";
import { EmptyBlock, KpiGrid, KpiTile, TableCard } from "@/components/analytics/parts";
import { AnalyticsZeroBodySkeleton, AnalyticsZeroPageSkeleton } from "@/components/page-skeletons";
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
import { zeroQuery } from "@/lib/analytics/data";
import { ANALYTICS_TITLES, CATEGORY_LABEL, ZERO_TILES } from "@/lib/analytics/labels";
import { zeroTree } from "@/lib/analytics/logic";
import { formatDate, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/analytics/zero")({
  head: () => ({ meta: [{ title: "Нулевая номенклатура — Аналитика сети — Base40 Admin" }] }),
  pendingComponent: AnalyticsZeroPageSkeleton,
  component: ZeroPage,
});

const num = "text-right [&>span]:justify-end";

function ZeroPage() {
  return (
    <AnalyticsShell
      title={ANALYTICS_TITLES.zero}
      kinds={["sales"]}
      skeleton={<AnalyticsZeroBodySkeleton />}
    >
      {(view) => <ZeroBody {...view} />}
    </AnalyticsShell>
  );
}

function ZeroBody({ studios, ids, period, today }: AnalyticsView) {
  const q = useQuery(zeroQuery(ids, period));
  if (q.isError)
    return (
      <InfoNote variant="warning">
        Не удалось загрузить нулевые продажи. Обновите страницу.
      </InfoNote>
    );
  const tree = q.data ? zeroTree(q.data, studios, today) : [];
  const total = tree.reduce((s, c) => s + c.count, 0);
  const clubs = tree.reduce((s, c) => s + c.studios.length, 0);

  return (
    <div className="space-y-3">
      <KpiGrid>
        <KpiTile {...ZERO_TILES.count} loading={q.isLoading} value={formatNumber(total)} />
        <KpiTile {...ZERO_TILES.clubs} loading={q.isLoading} value={formatNumber(clubs)} />
      </KpiGrid>
      <TableCard
        title="Продажи с нулём"
        tip="Город → студия → номенклатура. «Пробное занятие» исключено: у него ноль бывает штатно."
      >
        {!q.isLoading && tree.length === 0 ? (
          <EmptyBlock>Строк продаж с нулевой стоимостью за период нет</EmptyBlock>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Город / клуб / номенклатура</TableHead>
                <TableHead>Категория</TableHead>
                <TableHead className={num}>Строк</TableHead>
                <TableHead className={num}>Последняя</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading ? (
                <TableSkeletonRows columns={4} rows={6} />
              ) : (
                tree.map((city) => (
                  <Fragment key={city.city}>
                    <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                      <TableCell>{city.city}</TableCell>
                      <TableCell />
                      <TableCell className="text-right">{formatNumber(city.count)}</TableCell>
                      <TableCell />
                    </TableRow>
                    {city.studios.map(({ studio, items, count }) => (
                      <Fragment key={studio.id}>
                        <TableRow className="font-medium">
                          <TableCell className="pl-6">{studio.name}</TableCell>
                          <TableCell />
                          <TableCell className="text-right">{formatNumber(count)}</TableCell>
                          <TableCell />
                        </TableRow>
                        {items.map((i) => (
                          <TableRow key={`${studio.id}:${i.category}:${i.name}`}>
                            <TableCell className="pl-10">{i.name}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {CATEGORY_LABEL[i.category] ?? i.category}
                            </TableCell>
                            <TableCell className="text-right">{formatNumber(i.count)}</TableCell>
                            <TableCell className="text-right">{formatDate(i.lastOn)}</TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
