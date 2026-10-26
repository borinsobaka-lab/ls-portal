import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { DataPagination, usePagination } from "@/components/data-pagination";
import { ReadBar } from "@/components/kb/analytics/parts";
import { useKbReport } from "@/components/kb/analytics/queries";
import { KbStatusBadge } from "@/components/kb/kb-status-badge";
import { KbReadersDialogBody } from "@/components/kb/readers-dialog";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
import { useTableSort } from "@/hooks/use-table-sort";
import {
  formatAgo,
  formatDuration,
  percentText,
  share,
  type KbReportRow,
} from "@/lib/kb/analytics";
import { useKbTree } from "@/lib/kb/data";
import { ancestorsOf, indexTree } from "@/lib/kb/tree";
import { KB_STATUS_LABEL, type KbStatus } from "@/lib/kb/types";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import type { SortGetters } from "@/lib/table-sort";

const TIPS = {
  read: "Сколько сотрудников с доступом к базе прочитали актуальную версию (владельцы и авторы статьи не считаются). Жёлтым — открывали до последней публикации.",
  completed: "Из прочитавших — сколько пролистали статью до конца (90% и больше).",
  time: "Среднее время чтения на одного прочитавшего — за всё время.",
  views: "Открытия за последние 30 дней (повтор чаще раза в 30 минут не считается).",
  updated: "Последняя правка: публикация, название или черновик правок.",
};

const SORT: SortGetters<KbReportRow> = {
  title: (r) => r.title,
  status: (r) => KB_STATUS_LABEL[r.status],
  updated: (r) => r.updated_at,
  read: (r) => share(r.readers_count, r.access_count),
  completed: (r) => share(r.completed_count, r.readers_count),
  time: (r) => r.avg_seconds,
  views: (r) => r.views_30d,
  last: (r) => r.last_read_at,
};

type Show = "all" | "unfinished";

/**
 * «Статьи» аналитики (бывший «Отчёт по чтению», RPC kb_report): каждая
 * статья — статус, кто и когда правил, сколько прочитали (и сколько видели
 * только прежнюю версию), дочитали, среднее время, открытия за 30 дней. По
 * строке — кто прочитал (KbReadersDialogBody).
 */
export function KbArticlesTab({ baseId, canGrant }: { baseId: string; canGrant: boolean }) {
  const { data, isLoading, error } = useKbReport(baseId, true);
  const { data: nodes } = useKbTree(baseId);
  const index = useMemo(() => indexTree(nodes ?? []), [nodes]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | KbStatus>("all");
  const [show, setShow] = useState<Show>("all");
  const [open, setOpen] = useState<KbReportRow | null>(null);

  const sort = useTableSort<KbReportRow>(SORT);
  const term = q.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (show === "all" || (r.access_count > 0 && r.readers_count < r.access_count)) &&
      (!term || r.title.toLowerCase().includes(term)),
  );
  const pg = usePagination(sort.apply(rows), undefined, `${sort.key}|${status}|${show}|${term}`);
  const path = (id: string) =>
    ancestorsOf(index, id)
      .map((a) => a.title)
      .join(" › ");

  if (error && !data) return <InfoNote variant="warning">{error.message}</InfoNote>;

  return (
    <div className="space-y-3">
      <TableToolbar>
        <ToolbarSearch value={q} onChange={setQ} placeholder="Название статьи" />
        <Select value={status} onValueChange={(v) => setStatus(v as "all" | KbStatus)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            <SelectItem value="published">{KB_STATUS_LABEL.published}</SelectItem>
            <SelectItem value="draft">{KB_STATUS_LABEL.draft}</SelectItem>
            <SelectItem value="archived">{KB_STATUS_LABEL.archived}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={show} onValueChange={(v) => setShow(v as Show)}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статьи</SelectItem>
            <SelectItem value="unfinished">Прочитали не все</SelectItem>
          </SelectContent>
        </Select>
        <ToolbarReset
          active={!!q || status !== "all" || show !== "all"}
          onReset={() => {
            setQ("");
            setStatus("all");
            setShow("all");
          }}
        />
      </TableToolbar>
      {!!data?.length && data.every((r) => r.access_count === 0) && (
        <InfoNote>
          Читателей пока нет: базу никому не выдали, а администраторы баз и авторы статьи не
          считаются. Выдайте сотрудникам роль с «Просмотром» этой базы —{" "}
          {canGrant ? (
            <Link to="/access" className="font-medium underline">
              открыть «Пользователей»
            </Link>
          ) : (
            "это делает администратор пользователей"
          )}
          , и здесь появится, кто прочитал.
        </InfoNote>
      )}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("title")}>Статья</TableHead>
              <TableHead {...sort.head("status")}>Статус</TableHead>
              <TableHead tip={TIPS.updated} {...sort.head("updated")}>
                Обновлено
              </TableHead>
              <TableHead tip={TIPS.read} {...sort.head("read")}>
                Прочитали
              </TableHead>
              <TableHead tip={TIPS.completed} {...sort.head("completed")}>
                До конца
              </TableHead>
              <TableHead tip={TIPS.time} {...sort.head("time")}>
                Ср. время
              </TableHead>
              <TableHead tip={TIPS.views} {...sort.head("views")}>
                Открытий
              </TableHead>
              <TableHead {...sort.head("last")}>Открывали</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={8} rows={6} />
            ) : pg.paged.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {data?.length ? "Ничего не нашлось" : "В базе пока нет статей"}
                </TableCell>
              </TableRow>
            ) : (
              pg.paged.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                >
                  <TableCell className="max-w-72">
                    <Link
                      to="/kb/$baseId/$nodeId"
                      params={{ baseId, nodeId: r.id }}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate font-medium hover:underline"
                    >
                      {r.title || "Без названия"}
                    </Link>
                    {path(r.id) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {path(r.id)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <KbStatusBadge status={r.status} size="sm" />
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="block">{formatDate(r.updated_at)}</span>
                    <span className="text-xs text-muted-foreground">{r.updated_by_name || ""}</span>
                  </TableCell>
                  <TableCell className="min-w-48">
                    {r.access_count ? (
                      <>
                        <span className="mb-1 flex items-baseline justify-between gap-2 text-xs whitespace-nowrap tabular-nums">
                          <span>
                            <b className="text-sm">
                              {percentText(r.readers_count, r.access_count)}
                            </b>
                            <span className="text-muted-foreground">
                              {" "}
                              · {r.readers_count} из {r.access_count}
                            </span>
                          </span>
                          {r.outdated_count > 0 && (
                            <span className="text-amber-700 dark:text-amber-300">
                              +{r.outdated_count} прежн.
                            </span>
                          )}
                        </span>
                        <ReadBar
                          current={r.readers_count}
                          outdated={r.outdated_count}
                          total={r.access_count}
                        />
                      </>
                    ) : (
                      <span className="text-muted-foreground" title="Читателей нет">
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {r.readers_count ? percentText(r.completed_count, r.readers_count) : "—"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {r.avg_seconds ? formatDuration(r.avg_seconds) : "—"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {formatNumber(r.views_30d)}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    title={r.last_read_at ? formatDateTime(r.last_read_at) : undefined}
                  >
                    {r.last_read_at ? formatAgo(r.last_read_at) : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {data && <DataPagination {...pg} />}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg">
          {open && <KbReadersDialogBody nodeId={open.id} title={open.title} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
