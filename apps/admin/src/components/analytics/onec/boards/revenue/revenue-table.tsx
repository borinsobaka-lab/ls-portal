import type { Ref } from "react";
import { ChevronRight } from "lucide-react";

import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  revenueCell,
  revenueStatusLabel,
  type RevenueBodyRow,
  type RevenueColumn,
  type RevenueColumnKind,
  type RevenueSort,
  type RevenueSortKey,
} from "@/lib/analytics/onec-reports/revenue";
import type { RevenueRow } from "@/lib/analytics/onec-reports/payload";
import { cn } from "@/lib/utils";

/**
 * Таблица доски «Выручка»: города (раскрываются в студии), итог сети
 * сверху, колонки — недели и итог текущего месяца, прогноз, «Точка 0» и
 * месяцы истории. Широкая сетка для сравнения по колонкам — на телефоне
 * остаётся таблицей с прокруткой вбок (не карточки); шапка и колонка
 * названий прилипают, как у них. Линии у прилипших ячеек — тенью: рамку
 * ячейки при border-collapse браузер оставляет на месте.
 */

/** Блоки колонок: текущий месяц, «Точка 0», история — между ними линия. */
const BLOCK: Record<RevenueColumnKind, string> = {
  bucket: "current",
  "current-month": "current",
  forecast: "current",
  "break-even": "break-even",
  "break-even-delta": "break-even",
  month: "history",
};

const HEAD_LINE = "shadow-[inset_0_-1px_0_var(--color-border)]";
const HEAD_LINE_BLOCK =
  "shadow-[inset_1px_0_0_var(--color-border),inset_0_-1px_0_var(--color-border)]";
const NAME_HEAD_LINE =
  "shadow-[inset_-1px_0_0_var(--color-border),inset_0_-1px_0_var(--color-border)]";
const NAME_LINE = "shadow-[inset_-1px_0_0_var(--color-border)]";

const STATUS_TONE: Record<string, "positive" | "neutral"> = { Открыта: "positive" };

function StatusLabel({ row }: { row: RevenueRow }) {
  const label = revenueStatusLabel(row);
  if (!label) return null;
  return (
    <StatusChip size="sm" tone={STATUS_TONE[label] ?? "neutral"} className="ml-2 align-middle">
      {label}
    </StatusChip>
  );
}

export function RevenueTable({
  columns,
  rows,
  sort,
  onSort,
  onToggleCity,
  tableRef,
}: {
  columns: RevenueColumn[];
  rows: RevenueBodyRow[];
  sort: RevenueSort;
  onSort: (key: RevenueSortKey) => void;
  onToggleCity: (name: string) => void;
  tableRef: Ref<HTMLTableElement>;
}) {
  const blockStart = columns.map((c, i) => i > 0 && BLOCK[c.kind] !== BLOCK[columns[i - 1].kind]);

  return (
    // Своя прокрутка у таблицы (не у страницы) — чтобы шапка с месяцами
    // прилипала: у них таблица занимала весь экран под фильтрами.
    <div className="rounded-lg border bg-background [&>div>div:first-child]:max-h-[calc(100dvh-9rem)] max-lg:[&>div>div:first-child]:max-h-[calc(100dvh-12rem)]">
      <Table ref={tableRef} mobileCards={false}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              className={cn(
                "sticky top-0 left-0 z-30 min-w-40 bg-background px-3 sm:min-w-56",
                NAME_HEAD_LINE,
              )}
            >
              Город / студия
            </TableHead>
            {columns.map((col, i) => {
              const dir = col.sortKey && sort?.key === col.sortKey ? sort.direction : null;
              const sortKey = col.sortKey;
              return (
                <TableHead
                  key={col.id}
                  className={cn(
                    "sticky top-0 z-20 min-w-28 bg-background px-3 text-right [&>span]:justify-end",
                    blockStart[i] ? HEAD_LINE_BLOCK : HEAD_LINE,
                  )}
                  sortDir={sortKey ? dir : undefined}
                  onSort={sortKey ? () => onSort(sortKey) : undefined}
                >
                  {col.sub ? (
                    <span className="inline-flex flex-col items-end py-1 leading-tight">
                      <span>{col.label}</span>
                      <span className="text-xs font-normal">{col.sub}</span>
                    </span>
                  ) : (
                    col.label
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length + 1} className="p-0">
                <span className="sticky left-0 inline-block px-4 py-8 text-sm text-muted-foreground">
                  Ничего не найдено
                </span>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((item) => {
              const network = item.kind === "network";
              const rowBg = network ? "bg-field" : "bg-background group-hover:bg-field";
              return (
                <TableRow
                  key={item.key}
                  className={cn(
                    "group",
                    network ? "bg-field font-semibold hover:bg-field" : "hover:bg-field",
                  )}
                >
                  <TableCell
                    className={cn(
                      "sticky left-0 z-10 min-w-40 max-w-[360px] whitespace-normal px-3 sm:min-w-56",
                      rowBg,
                      NAME_LINE,
                      item.kind === "studio" && "pl-9",
                    )}
                  >
                    {item.kind === "city" ? (
                      <button
                        type="button"
                        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded px-1 text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title="Нажмите, чтобы раскрыть студии"
                        aria-expanded={item.expanded}
                        onClick={() => onToggleCity(item.row.name)}
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            item.expanded && "rotate-90",
                          )}
                        />
                        {item.row.name}
                      </button>
                    ) : (
                      <span className={item.kind === "studio" ? "font-medium" : undefined}>
                        {item.row.name}
                        <StatusLabel row={item.row} />
                      </span>
                    )}
                  </TableCell>
                  {columns.map((col, i) => {
                    const cell = revenueCell(col.value(item.row));
                    return (
                      <TableCell
                        key={col.id}
                        className={cn(
                          "whitespace-nowrap px-3 text-right",
                          blockStart[i] && "border-l",
                          col.kind === "current-month" && "font-semibold",
                          col.kind === "forecast" && "text-muted-foreground",
                          cell.muted && "text-muted-foreground",
                          cell.negative && "font-semibold text-rose-700",
                        )}
                      >
                        {cell.text}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
