import { EmptyBlock, KpiTile, Delta } from "@/components/kb/analytics/parts";
import { useKbSearchStats } from "@/components/kb/analytics/queries";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/skeletons";
import { formatAgo, percentText, type KbPeriod } from "@/lib/kb/analytics";
import { formatDateTime, formatNumber } from "@/lib/format";

const TIPS = {
  searches: "Сколько раз искали в базе за период. Набор по буквам одного запроса — один поиск.",
  zero: "Поиски, где ничего не нашлось: темы, о которых в базе нет статьи или она названа иначе.",
  clicks: "Доля поисков, после которых открыли найденную статью.",
  results: "Сколько нашлось в последний раз.",
};

/**
 * «Поиск» аналитики: что ищут сотрудники и что не находят (kb_search_log
 * через kb_analytics_search — те же цифры и период, что у «Обзора», но без
 * тяжёлого расчёта чтения).
 */
export function KbSearchTab({ baseId, period }: { baseId: string; period: KbPeriod }) {
  const { data: o, isLoading, error } = useKbSearchStats(baseId, period);
  if (error && !o) return <InfoNote variant="warning">{error.message}</InfoNote>;
  const loading = isLoading || !o;
  const clicks = (o?.top_queries ?? []).reduce((s, q) => s + q.clicks, 0);
  const counted = (o?.top_queries ?? []).reduce((s, q) => s + q.count, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        <KpiTile
          label="Поисков"
          tip={TIPS.searches}
          loading={loading}
          value={o ? formatNumber(o.current.searches) : ""}
          delta={o && <Delta current={o.current.searches} previous={o.previous.searches} />}
        />
        <KpiTile
          label="Ничего не нашли"
          tip={TIPS.zero}
          loading={loading}
          value={o ? percentText(o.current.zero_searches, o.current.searches) : ""}
          hint={o ? `${formatNumber(o.current.zero_searches)} раз` : undefined}
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
        <KpiTile
          label="Открыли найденное"
          tip={TIPS.clicks}
          loading={loading}
          value={o ? percentText(clicks, counted) : ""}
          hint="по частым запросам"
        />
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Ищут, но не находят</h3>
        {o && o.zero_queries.length === 0 ? (
          <EmptyBlock>За период все поиски что-то находили.</EmptyBlock>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Запрос</TableHead>
                  <TableHead>Раз</TableHead>
                  <TableHead>Человек</TableHead>
                  <TableHead>Последний раз</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={4} rows={4} />
                ) : (
                  o.zero_queries.map((q) => (
                    <TableRow key={q.query}>
                      <TableCell className="max-w-80">
                        <span className="block truncate font-medium">«{q.query}»</span>
                        <span className="text-xs text-muted-foreground">
                          Статьи на эту тему нет — или она названа иначе
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">{q.count}</TableCell>
                      <TableCell className="tabular-nums">{q.users}</TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground"
                        title={formatDateTime(q.last_at)}
                      >
                        {formatAgo(q.last_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Частые запросы</h3>
        {o && o.top_queries.length === 0 ? (
          <EmptyBlock>За период в базе не искали.</EmptyBlock>
        ) : (
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Запрос</TableHead>
                  <TableHead>Раз</TableHead>
                  <TableHead>Человек</TableHead>
                  <TableHead tip={TIPS.results}>Нашлось</TableHead>
                  <TableHead tip={TIPS.clicks}>Открыли</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={5} rows={5} />
                ) : (
                  o.top_queries.map((q) => (
                    <TableRow key={q.query}>
                      <TableCell className="max-w-80 truncate font-medium">«{q.query}»</TableCell>
                      <TableCell className="tabular-nums">{q.count}</TableCell>
                      <TableCell className="tabular-nums">{q.users}</TableCell>
                      <TableCell>
                        {q.results === 0 ? (
                          <StatusChip tone="warning" size="sm">
                            ничего
                          </StatusChip>
                        ) : (
                          <span className="tabular-nums">{q.results}</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {percentText(q.clicks, q.count)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
