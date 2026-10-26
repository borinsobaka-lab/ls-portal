import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Loader2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { RequireStudio } from "@/components/require-studio";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useActiveStudio } from "@/hooks/use-studios";
import { useServerTable } from "@/hooks/use-server-table";
import { useTableSort } from "@/hooks/use-table-sort";
import { orderBy } from "@/lib/table-sort";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import { DataPagination } from "@/components/data-pagination";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { toast } from "sonner";
import { dayTypeLabel, dayTypeColor, type DayType } from "@/lib/workout-types";
import { ClientNameLink } from "@/components/client-name-link";
import { useCrmLinks } from "@/hooks/use-crm-links";
import { TableSkeletonRows } from "@/components/skeletons";
import { BookingStatusBadge } from "@/components/booking-status-badge";
import { BOOKING_STATUS_FILTER, BOOKING_STATUS_LABEL, type BookingStatus } from "@/lib/bookings";
import { formatDateTime, formatPhone } from "@/lib/format";
import { BookingsLogPageSkeleton } from "@/components/page-skeletons";

export const Route = createFileRoute("/_authenticated/bookings-log")({
  head: () => ({ meta: [{ title: "История записей — Base40 Admin" }] }),
  pendingComponent: BookingsLogPageSkeleton,
  component: BookingsLogPage,
});

type LogRow = {
  id: string;
  booking_id: string | null;
  entry_id: string | null;
  user_id: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
  client_full_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  workout_name: string | null;
  workout_type: string | null;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  booked_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  cancelled_lead_minutes: number | null;
  met_value: number | null;
  weight_at_time: number | null;
  duration_min: number | null;
  calories: number | null;
};

const STATUS_ALL = "__all__";

/** Колонки сортировки (lib/table-sort.ts): ключ заголовка → колонки вью. */
const SORT_COLUMNS = {
  name: ["client_full_name", "client_first_name", "client_last_name"],
  contacts: "client_phone",
  workout: "workout_name",
  startsAt: "starts_at",
  status: "status",
  met: "met_value",
  weight: "weight_at_time",
  duration: "duration_min",
  calories: "calories",
  cancelledAt: "cancelled_at",
};

// Срок отмены: >0 — за сколько до начала, <=0 — после начала занятия.
function formatLead(minutes: number) {
  if (minutes <= 0) return "после начала";
  if (minutes < 60) return `за ${minutes} мин до начала`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `за ${h} ч ${m} мин до начала` : `за ${h} ч до начала`;
}

function BookingsLogPage() {
  const studioId = useActiveStudioId();
  const { confirm, confirmDialog } = useConfirm();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(STATUS_ALL);
  const [markingNoShows, setMarkingNoShows] = useState(false);
  const sort = useTableSort();
  // В пакетных клубах приход фиксируют только в «Расписании» (решение
  // владельца 2026-10-11) — массовой отметки пропусков здесь нет.
  const isPackages = useActiveStudio()?.format === "packages";

  const term = useDebouncedValue(search).trim();

  const table = useServerTable<LogRow>({
    queryKey: ["bookings_log_full", studioId, status, term, sort.key],
    queryFn: ({ from, to }) => {
      // Вью bookings_log_full уже объединяет журнал с записями, которые в него
      // ещё не попали (см. db/performance_indexes.sql), поэтому сшивать
      // источники в браузере больше не нужно.
      let query = supabase
        .from("bookings_log_full")
        .select("*", { count: "exact" })
        .eq("studio_id", studioId!);
      if (status !== STATUS_ALL) query = query.eq("status", status);
      if (term) query = query.ilike("search_text", `%${term}%`);
      return orderBy(query, sort.sort, SORT_COLUMNS, (q) =>
        q.order("starts_at", { ascending: false }),
      ).range(from, to);
    },
    enabled: !!studioId,
    errorMessage: "Не удалось загрузить историю",
  });
  const crmLinkOf = useCrmLinks(
    studioId,
    "user_id",
    table.rows.map((r) => r.user_id),
  );

  // Раньше эта простановка вызывалась внутри загрузки страницы, то есть на
  // каждый ввод в поиске и на каждую смену страницы — а это два UPDATE'а по
  // всему журналу. Теперь только по явному нажатию.
  // Правка журнала разом по всей студии — поэтому сначала подтверждение.
  const markNoShows = async () => {
    if (
      !(await confirm({
        title: "Отметить пропущенные?",
        description:
          "Записи в статусе «Забронировано» на уже закончившиеся занятия этого клуба станут «Пропущено».",
        confirmLabel: "Отметить",
        destructive: false,
      }))
    )
      return;
    setMarkingNoShows(true);
    try {
      const { data, error } = await supabase.rpc("mark_no_show_bookings", {
        p_studio_id: studioId,
      });
      if (error) {
        toast.error("Не удалось отметить пропущенные: " + error.message);
        return;
      }
      const n = typeof data === "number" ? data : 0;
      toast.success(n > 0 ? `Отмечено пропущенных: ${n}` : "Новых пропусков нет");
      table.refetch();
    } finally {
      setMarkingNoShows(false);
    }
  };

  return (
    <AdminShell
      title="История записей"
      actions={
        isPackages ? undefined : (
          <Button variant="outline" onClick={markNoShows} disabled={!studioId || markingNoShows}>
            {markingNoShows && <Loader2 className="animate-spin" />}
            Отметить пропущенные
          </Button>
        )
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Поиск: имя, телефон, почта, тренировка"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Статус записи" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STATUS_ALL}>Все статусы</SelectItem>
                {BOOKING_STATUS_FILTER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {BOOKING_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToolbarReset
              active={Boolean(search.trim()) || status !== STATUS_ALL}
              onReset={() => {
                setSearch("");
                setStatus(STATUS_ALL);
              }}
            />
          </TableToolbar>

          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]" {...sort.head("name")}>
                    Клиент
                  </TableHead>
                  <TableHead {...sort.head("contacts")}>Контакты</TableHead>
                  <TableHead {...sort.head("workout")}>Тренировка</TableHead>
                  <TableHead className="w-[160px]" {...sort.head("startsAt")}>
                    Дата и время
                  </TableHead>
                  <TableHead className="w-[140px]" {...sort.head("status")}>
                    Статус
                  </TableHead>
                  <TableHead className="w-[70px] text-right" {...sort.head("met")}>
                    MET
                  </TableHead>
                  <TableHead className="w-[80px] text-right" {...sort.head("weight")}>
                    Вес, кг
                  </TableHead>
                  <TableHead className="w-[80px] text-right" {...sort.head("duration")}>
                    Длит., мин
                  </TableHead>
                  <TableHead className="w-[90px] text-right" {...sort.head("calories")}>
                    Ккал
                  </TableHead>
                  <TableHead className="w-[160px]" {...sort.head("cancelledAt")}>
                    Отменена
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.loading ? (
                  <TableSkeletonRows columns={10} />
                ) : table.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Записей не найдено.
                    </TableCell>
                  </TableRow>
                ) : (
                  table.rows.map((r) => {
                    const color = dayTypeColor(r.workout_type as DayType | null);
                    // Здесь «Имя Фамилия» и full_name в приоритете, а не
                    // clientName(): менять вид имени в разделе — решение
                    // владельца, а не рефакторинга.
                    const name =
                      r.client_full_name ||
                      [r.client_first_name, r.client_last_name].filter(Boolean).join(" ") ||
                      "—";
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">
                          {r.user_id && name !== "—" ? (
                            <ClientNameLink userId={r.user_id} crmLink={crmLinkOf(r.user_id)}>
                              {name}
                            </ClientNameLink>
                          ) : (
                            name
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          <div>{formatPhone(r.client_phone) || "—"}</div>
                          <div className="text-xs">{r.client_email ?? "—"}</div>
                        </TableCell>
                        <TableCell>
                          <div>{r.workout_name ?? "—"}</div>
                          {r.workout_type && color && (
                            <div className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className={`inline-block h-2 w-2 rounded-full ${color.dot}`} />
                              {dayTypeLabel(r.workout_type as DayType)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {formatDateTime(r.starts_at)}
                        </TableCell>
                        <TableCell>
                          <BookingStatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {r.met_value != null ? Number(r.met_value).toFixed(1) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {r.weight_at_time != null ? Number(r.weight_at_time).toFixed(1) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {r.duration_min ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {r.calories ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {r.cancelled_at ? (
                            <div className="space-y-0.5">
                              <div>{formatDateTime(r.cancelled_at)}</div>
                              {r.cancelled_lead_minutes != null && (
                                <div>{formatLead(r.cancelled_lead_minutes)}</div>
                              )}
                            </div>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <DataPagination {...table.pagination} />
          </div>
        </RequireStudio>
      </div>
      {confirmDialog}
    </AdminShell>
  );
}
