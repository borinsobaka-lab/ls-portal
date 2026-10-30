import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { AdminShell } from "@/components/admin-shell";
import { OnecBoardBodySkeleton } from "@/components/page-skeletons";
import { DateRangeFilter, type DateRange } from "@/components/date-range-filter";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/form-field";
import {
  ONEC_BOARD_NOTICE,
  ONEC_BOARD_PRESETS,
  ONEC_BOARD_TITLES,
  onecReportErrorText,
  onecReportQuery,
} from "@/lib/analytics/onec-reports/data";
import { monthDays, type OnecBoard, type OnecPayload } from "@/lib/analytics/onec-reports/payload";
import type { OnecSearch } from "@/lib/analytics/onec-reports/search";

/** Управление доской: фильтры в адресе (переживают смену периода) и смена месяца. */
export type OnecControls = {
  search: OnecSearch;
  setFilters: (next: Pick<OnecSearch, "city" | "studio" | "status">) => void;
  /** Их onecChangeMonth: месяц целиком (с 1-го по последний день). */
  changeMonth: (period: string) => void;
};

const toDate = (iso: string) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Рамка отчёта 1С — их server-controls: период «с — по» и «С начала месяца /
 * квартала / года» (от даты окончания), подпись «Обновлено … МСК» и что
 * сравнивается; ниже — доска. Данные — их full_reports.py
 * (lib/analytics/onec-reports).
 */
export function OnecReportFrame({
  board,
  search,
  navigate,
  children,
}: {
  board: OnecBoard;
  search: OnecSearch;
  navigate: (next: OnecSearch, replace?: boolean) => void;
  children: (payload: OnecPayload, controls: OnecControls) => ReactNode;
}) {
  const { data, error, isPending } = useQuery(onecReportQuery(board, search));
  const payload = data && !data.empty ? data.payload : null;
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const range: DateRange | undefined =
    draft ?? (payload ? { from: toDate(payload.start), to: toDate(payload.end) } : undefined);
  const apply = (start: string, end: string) => {
    setDraft(undefined);
    navigate({ ...search, start, end });
  };
  const preset = (kind: "month" | "quarter" | "year") => {
    const end = payload?.end ?? search.end;
    if (!end) return;
    const year = +end.slice(0, 4);
    const month = +end.slice(5, 7);
    const first =
      kind === "year" ? 1 : kind === "quarter" ? Math.floor((month - 1) / 3) * 3 + 1 : month;
    apply(`${year}-${String(first).padStart(2, "0")}-01`, end);
  };
  const controls: OnecControls = {
    search,
    setFilters: (next) => navigate({ ...search, ...next }, true),
    changeMonth: (period) => {
      const [y, m] = period.split("-").map(Number);
      apply(`${period}-01`, `${period}-${String(monthDays(y, m)).padStart(2, "0")}`);
    },
  };

  return (
    <AdminShell title={ONEC_BOARD_TITLES[board]}>
      <div className="space-y-4">
        <TableToolbar>
          <DateRangeFilter
            value={range}
            placeholder="Период"
            showLabel={false}
            title="С даты — по дату"
            onChange={(r) => {
              if (r?.from && r.to) apply(toIso(r.from), toIso(r.to));
              else setDraft(r);
            }}
          />
          {ONEC_BOARD_PRESETS[board] && (
            <>
              <Button variant="outline" disabled={!payload} onClick={() => preset("month")}>
                С начала месяца
              </Button>
              <Button variant="outline" disabled={!payload} onClick={() => preset("quarter")}>
                С начала квартала
              </Button>
              <Button variant="outline" disabled={!payload} onClick={() => preset("year")}>
                С начала года
              </Button>
            </>
          )}
        </TableToolbar>
        {payload && (
          <p className="text-xs text-muted-foreground">
            {payload.start} — {payload.end} · Обновлено {payload.generatedAt} МСК.{" "}
            {ONEC_BOARD_NOTICE[board]}
          </p>
        )}
        {error ? (
          <InfoNote variant="warning">{onecReportErrorText(error)}</InfoNote>
        ) : data?.empty ? (
          <InfoNote variant="empty">
            Данных ещё нет: их загружает администратор аналитики в «Инструменты» → «Обработка 1С».
          </InfoNote>
        ) : isPending || !payload ? (
          <OnecBoardBodySkeleton board={board} />
        ) : (
          children(payload, controls)
        )}
      </div>
    </AdminShell>
  );
}
