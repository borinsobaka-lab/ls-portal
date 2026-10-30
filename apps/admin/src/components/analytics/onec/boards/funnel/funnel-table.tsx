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
  FUNNEL_COLUMNS,
  funnelCells,
  type FunnelTableRow,
} from "@/lib/analytics/onec-reports/funnel";
import { cn } from "@/lib/utils";

/**
 * Таблица «Воронка по городам, студиям и направлениям»: город раскрывается
 * в студии, студия — в направления (их renderTable, строки —
 * lib/analytics/onec-reports/funnel.ts). Сетка для сравнения по колонкам —
 * на телефоне остаётся таблицей с прокруткой вбок, колонка названий
 * прилипает слева, как у них. Сортировки по колонкам у них нет: порядок —
 * по алфавиту на каждом уровне.
 */

// Линия у прилипшей колонки — тенью: рамку ячейки браузер при прокрутке
// оставляет на месте.
const NAME_LINE = "shadow-[inset_-1px_0_0_var(--color-border)]";

const STATUS_TONE: Record<string, "positive" | "neutral"> = { Открыта: "positive" };

export function FunnelTable({
  rows,
  onToggle,
}: {
  rows: FunnelTableRow[];
  onToggle: (row: FunnelTableRow) => void;
}) {
  return (
    <Table mobileCards={false} className="min-w-[1000px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead
            className={cn(
              "sticky left-0 z-20 w-[22%] min-w-48 bg-background px-3 align-bottom whitespace-normal max-md:w-40 max-md:min-w-40",
              NAME_LINE,
            )}
          >
            Город / студия / направление
          </TableHead>
          {FUNNEL_COLUMNS.map((label) => (
            <TableHead
              key={label}
              className="px-3 py-2 text-right align-bottom leading-tight whitespace-normal"
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className="group hover:bg-field">
            <TableCell
              className={cn(
                "sticky left-0 z-10 bg-background px-3 py-1 whitespace-normal group-hover:bg-field",
                NAME_LINE,
                row.level === "studio" && "pl-9",
                row.level === "direction" && "pl-[3.75rem]",
              )}
            >
              {row.toggleId !== undefined ? (
                <button
                  type="button"
                  aria-expanded={row.expanded}
                  onClick={() => onToggle(row)}
                  className={cn(
                    "-mx-1 flex min-h-8 w-[calc(100%+0.5rem)] cursor-pointer items-center gap-1.5 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    row.level === "city" ? "font-semibold" : "font-medium",
                  )}
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      row.expanded && "rotate-90",
                    )}
                  />
                  <span className="min-w-0">
                    {row.name}
                    {row.status && (
                      <StatusChip
                        size="sm"
                        tone={STATUS_TONE[row.status] ?? "neutral"}
                        className="ml-2 align-middle"
                      >
                        {row.status}
                      </StatusChip>
                    )}
                  </span>
                </button>
              ) : (
                <span className="flex min-h-8 items-center">{row.name}</span>
              )}
            </TableCell>
            {funnelCells(row.totals).map((cell, i) => (
              <TableCell
                key={FUNNEL_COLUMNS[i]}
                className={cn("px-3 py-1 text-right whitespace-nowrap", cell.rate && "font-medium")}
              >
                {cell.value}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
