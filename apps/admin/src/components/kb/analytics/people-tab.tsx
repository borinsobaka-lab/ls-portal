import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { DataPagination, usePagination } from "@/components/data-pagination";
import { StaffAvatar } from "@/components/employee-photo";
import { EmptyBlock, ReadBar } from "@/components/kb/analytics/parts";
import { KbPersonDialogBody } from "@/components/kb/analytics/person-dialog";
import { useKbPeople } from "@/components/kb/analytics/queries";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
import { useTableSort } from "@/hooks/use-table-sort";
import {
  formatAgo,
  formatDuration,
  percentText,
  personProgress,
  type KbPeriod,
  type KbPersonRow,
} from "@/lib/kb/analytics";
import { formatDateTime } from "@/lib/format";
import type { SortGetters } from "@/lib/table-sort";

const TIPS = {
  progress:
    "Сколько опубликованных статей базы сотрудник прочитал в актуальной версии — из тех, что ему положено (свои статьи не считаются). Жёлтым — открывал прежнюю версию, новую не видел.",
  completed: "Сколько прочитанных статей пролистал до конца (90% текста и больше).",
  time: "Время чтения за выбранный период и за всё время: пока статья на экране и человек что-то делает.",
  days: "В сколько дней периода открывал статьи этой базы.",
  last: "Когда и какую статью этой базы открывал последней.",
  signIn: "Последний вход в админку (по коду из письма) — не только в базу знаний.",
};

const SORT: SortGetters<KbPersonRow> = {
  name: (r) => r.full_name ?? "",
  progress: personProgress,
  completed: (r) => r.completed,
  time: (r) => r.seconds_period,
  days: (r) => r.active_days,
  last: (r) => r.last_read_at,
  signIn: (r) => r.last_sign_in_at,
};

/**
 * «Сотрудники» аналитики: каждый, кому выдана база, — сколько положенного
 * прочитал, время, дни активности, последнее чтение и вход в админку. По
 * строке — карточка чтения сотрудника (KbPersonDialogBody).
 */
export function KbPeopleTab({ baseId, period }: { baseId: string; period: KbPeriod }) {
  const { data, isLoading, error } = useKbPeople(baseId, period, true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<KbPersonRow | null>(null);
  const sort = useTableSort<KbPersonRow>(SORT);
  const term = q.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (r) => !term || (r.full_name ?? "").toLowerCase().includes(term),
  );
  const pg = usePagination(sort.apply(rows), undefined, `${sort.key}|${term}`);

  if (error && !data) return <InfoNote variant="warning">{error.message}</InfoNote>;
  if (data && data.length === 0)
    return (
      <EmptyBlock>
        Базу пока никому не выдали в «Доступах». Владельцы в аналитике не участвуют.
      </EmptyBlock>
    );

  return (
    <div className="space-y-3">
      <TableToolbar>
        <ToolbarSearch value={q} onChange={setQ} placeholder="Имя сотрудника" />
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Сотрудник</TableHead>
              <TableHead tip={TIPS.progress} {...sort.head("progress")}>
                Прочитано
              </TableHead>
              <TableHead tip={TIPS.completed} {...sort.head("completed")}>
                До конца
              </TableHead>
              <TableHead tip={TIPS.time} {...sort.head("time")}>
                Время
              </TableHead>
              <TableHead tip={TIPS.days} {...sort.head("days")}>
                Дней
              </TableHead>
              <TableHead tip={TIPS.last} {...sort.head("last")}>
                Последнее чтение
              </TableHead>
              <TableHead tip={TIPS.signIn} {...sort.head("signIn")}>
                Вход в админку
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={7} rows={5} />
            ) : pg.paged.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  Ничего не нашлось
                </TableCell>
              </TableRow>
            ) : (
              pg.paged.map((r) => (
                <TableRow
                  key={r.user_id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                >
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StaffAvatar
                        value={r.avatar_url}
                        name={r.full_name ?? ""}
                        className="size-8 text-xs"
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {r.full_name || "Сотрудник"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {r.level === "edit" ? "Правка" : "Просмотр"}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="min-w-44">
                    <span className="mb-1 flex items-baseline justify-between gap-2 text-xs whitespace-nowrap tabular-nums">
                      <span>
                        <b className="text-sm">{percentText(r.read_current, r.required)}</b>
                        <span className="text-muted-foreground">
                          {" "}
                          · {r.read_current} из {r.required}
                        </span>
                      </span>
                      {r.read_outdated > 0 && (
                        <span className="text-amber-700 dark:text-amber-300">
                          +{r.read_outdated} прежн.
                        </span>
                      )}
                    </span>
                    <ReadBar
                      current={r.read_current}
                      outdated={r.read_outdated}
                      total={r.required}
                    />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {r.read_current ? percentText(r.completed, r.read_current) : "—"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    <span className="block">{formatDuration(r.seconds_period)}</span>
                    <span className="text-xs text-muted-foreground">
                      всего {formatDuration(r.seconds_total)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{r.active_days}</TableCell>
                  <TableCell className="max-w-56 text-sm">
                    {r.last_read_at ? (
                      <>
                        <span className="block" title={formatDateTime(r.last_read_at)}>
                          {formatAgo(r.last_read_at)}
                        </span>
                        {r.last_node_id && (
                          <Link
                            to="/kb/$baseId/$nodeId"
                            params={{ baseId, nodeId: r.last_node_id }}
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate text-xs text-muted-foreground hover:underline"
                          >
                            {r.last_node_title || "Без названия"}
                          </Link>
                        )}
                      </>
                    ) : (
                      <StatusChip tone="warning" size="sm">
                        Ещё не читал
                      </StatusChip>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    title={r.last_sign_in_at ? formatDateTime(r.last_sign_in_at) : undefined}
                  >
                    {formatAgo(r.last_sign_in_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {data && <DataPagination {...pg} />}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-3xl">
          {open && <KbPersonDialogBody baseId={baseId} person={open} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
