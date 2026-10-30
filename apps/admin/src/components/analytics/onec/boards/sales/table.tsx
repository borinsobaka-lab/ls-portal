import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SALES_COLUMNS,
  SALES_GROUPS,
  type SalesSort,
  type SalesSortKey,
  type SalesTableRow,
  type SalesTrendCell,
} from "@/lib/analytics/onec-reports/sales";
import { cn } from "@/lib/utils";

/**
 * Таблица доски «Продажи абонементов»: город → студии → номенклатуры
 * (раскрываются по нажатию), колонки по группам «Продажи / Оплаты и сумма /
 * Средний чек / Динамика суммы продаж». Широкая сетка для сравнения по
 * колонкам — на телефоне остаётся таблицей с прокруткой вбок (не карточки),
 * шапка и колонка названий прилипают, как у них. Линии у прилипших ячеек —
 * тенью: рамку ячейки при border-collapse браузер оставляет на месте.
 */

const HEAD_LINE = "shadow-[inset_0_-1px_0_var(--color-border)]";
const HEAD_LINE_BLOCK =
  "shadow-[inset_1px_0_0_var(--color-border),inset_0_-1px_0_var(--color-border)]";
const NAME_HEAD_LINE =
  "shadow-[inset_-1px_0_0_var(--color-border),inset_0_-1px_0_var(--color-border)]";
const NAME_LINE = "shadow-[inset_-1px_0_0_var(--color-border)]";

/** Первая колонка каждой группы — с линией слева. */
const GROUP_START = new Set(
  SALES_GROUPS.reduce<number[]>((starts, g, i) => {
    starts.push(i === 0 ? 0 : starts[i - 1] + SALES_GROUPS[i - 1].span);
    return starts;
  }, []),
);

export function SalesTable({
  rows,
  sort,
  onSort,
  onToggle,
}: {
  rows: SalesTableRow[];
  sort: SalesSort;
  onSort: (key: SalesSortKey) => void;
  onToggle: (row: SalesTableRow) => void;
}) {
  return (
    // Своя прокрутка у таблицы — чтобы прилипала шапка (у них — на весь экран).
    <div className="rounded-lg border bg-background [&>div>div:first-child]:max-h-[calc(100dvh-9rem)] max-lg:[&>div>div:first-child]:max-h-[calc(100dvh-12rem)]">
      <Table mobileCards={false}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              rowSpan={2}
              className={cn(
                "sticky top-0 left-0 z-30 h-20 min-w-48 bg-background px-3 sm:min-w-72",
                NAME_HEAD_LINE,
              )}
            >
              Город / студия
            </TableHead>
            {SALES_GROUPS.map((g) => (
              <TableHead
                key={g.label}
                colSpan={g.span}
                className={cn("sticky top-0 z-20 bg-background px-3 text-center", HEAD_LINE_BLOCK)}
              >
                {g.label}
              </TableHead>
            ))}
          </TableRow>
          <TableRow className="hover:bg-transparent">
            {SALES_COLUMNS.map((col, i) => {
              const key = col.sortKey;
              return (
                <TableHead
                  key={col.label}
                  className={cn(
                    "sticky top-10 z-20 bg-background px-3 text-right [&>span]:justify-end",
                    GROUP_START.has(i) ? HEAD_LINE_BLOCK : HEAD_LINE,
                  )}
                  sortDir={key ? (sort?.key === key ? sort.direction : null) : undefined}
                  onSort={key ? () => onSort(key) : undefined}
                >
                  {col.label}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn("group hover:bg-field", row.level === "city" && "font-semibold")}
            >
              <TableCell
                className={cn(
                  "sticky left-0 z-10 min-w-48 max-w-[360px] whitespace-normal bg-background px-3 group-hover:bg-field sm:min-w-72",
                  NAME_LINE,
                  row.level === "studio" && "pl-9",
                  row.level === "product" && "pl-16",
                )}
              >
                {row.toggle ? (
                  <button
                    type="button"
                    className={cn(
                      "-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      row.level === "studio" && "font-medium",
                    )}
                    aria-expanded={row.expanded}
                    onClick={() => onToggle(row)}
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        row.expanded && "rotate-90",
                      )}
                    />
                    {row.name}
                  </button>
                ) : (
                  row.name
                )}
              </TableCell>
              {row.cells.map((text, i) => (
                <TableCell
                  key={SALES_COLUMNS[i].label}
                  className={cn(
                    "whitespace-nowrap px-3 text-right",
                    GROUP_START.has(i) && "border-l",
                  )}
                >
                  {text}
                </TableCell>
              ))}
              <TrendCell cell={row.prev} first />
              <TrendCell cell={row.year} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** «К прошлому месяцу / году»: стрелка роста или падения, «нет базы» — без неё. */
function TrendCell({ cell, first = false }: { cell: SalesTrendCell; first?: boolean }) {
  const Icon = cell.dir === "down" ? ArrowDown : ArrowUp;
  return (
    <TableCell className={cn("whitespace-nowrap px-3 text-right", first && "border-l")}>
      <span className="inline-flex items-center gap-1">
        {!cell.noBase && (
          <Icon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              cell.dir === "down" ? "text-rose-700" : "text-emerald-700",
            )}
          />
        )}
        <span className={cn(cell.noBase && "font-normal text-muted-foreground")}>{cell.text}</span>
      </span>
    </TableCell>
  );
}
