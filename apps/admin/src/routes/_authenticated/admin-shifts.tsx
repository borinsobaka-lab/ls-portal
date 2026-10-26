import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { StaffTabs } from "@/components/staff-tabs";
import { useConfirm } from "@/components/confirm-dialog";
import { EmployeePhoto, StaffOption } from "@/components/employee-photo";
import { RowContextMenu } from "@/components/row-context-menu";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
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
import { supabase } from "@/integrations/supabase/client";
import { formatDate, todayISO } from "@/lib/format";
import {
  ADJUSTMENT_KINDS,
  formatPay,
  addMonths,
  monthBounds,
  monthDays,
  monthLabel,
  monthName,
  monthOf,
  plural,
  type AdjustmentKind,
  type MonthKey,
  type PayrollAdjustment,
} from "@/lib/payroll";
import { unwrap } from "@/lib/query";
import {
  isAdminRole,
  usePayRates,
  usePayrollAdjustments,
  usePayrollScope,
  type Employee,
} from "@/lib/staff-directory";
import { cn } from "@/lib/utils";
import { useTableSort } from "@/hooks/use-table-sort";
import { PeriodStepper } from "@/components/period-stepper";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AdminShiftsPageSkeleton } from "@/components/page-skeletons";

export const Route = createFileRoute("/_authenticated/admin-shifts")({
  head: () => ({ meta: [{ title: "График администраторов — Base40 Admin" }] }),
  pendingComponent: AdminShiftsPageSkeleton,
  component: AdminShiftsPage,
});

/**
 * «График администраторов» — раздел «Сотрудники», пакетные студии: кто из
 * администраторов работает в какой день в каждой студии (admin_shifts),
 * корректировки оклада — вычеты и надбавки (payroll_adjustments) и сколько
 * смен у каждого администратора за месяц. Смены и корректировки идут в
 * «Зарплаты» (payroll.tsx, расчёт — RPC payroll_lines). Видны только студии,
 * где у сотрудника есть роль («Доступы»); схема —
 * db/migrations/2026-10-11_zzz_staff_payroll.sql.
 */

const TIPS = {
  grid: "Нажмите «+», чтобы поставить администратора на день; нажмите на администратора, чтобы заменить его или убрать. Смена оплачивается по ставке «Смена администратора».",
  adjustment:
    "Вычет или надбавка к окладу сотрудника. Попадает в зарплату за период, в который входит дата: 1–19 — аванс, с 20-го — основная часть.",
  stats: "Смены за месяц по всем вашим клубам; «отработано» — по сегодняшний день.",
};

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const isWeekend = (weekday: number) => weekday === 0 || weekday === 6;

type Shift = { id: string; studio_id: string; trainer_id: string; shift_date: string };

const SHIFT_SELECT = "id, studio_id, trainer_id, shift_date";

/** Короткое имя на плашке смены — первое слово. */
const shortName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function AdminShiftsPage() {
  const queryClient = useQueryClient();
  const today = todayISO();
  const [month, setMonth] = useState<MonthKey>(monthOf(today));
  const { from, to } = monthBounds(month);
  const days = monthDays(month);

  const { studios, employees, loading: scopeLoading } = usePayrollScope();
  const { data: rates = [] } = usePayRates();
  const studioIds = new Set(studios.map((s) => s.id));

  const { data: allShifts = [], isLoading: shiftsLoading } = useQuery({
    queryKey: ["admin_shifts", month],
    queryFn: () =>
      unwrap<Shift[]>(
        supabase
          .from("admin_shifts")
          .select(SHIFT_SELECT)
          .gte("shift_date", from)
          .lte("shift_date", to)
          .order("created_at"),
      ),
    meta: { errorMessage: "Не удалось загрузить график администраторов" },
  });
  const shifts = allShifts.filter((s) => studioIds.has(s.studio_id));

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const shiftRate = new Set(rates.filter((r) => r.admin_shift_enabled).map((r) => r.trainer_id));
  /** Кого можно поставить в студию: администраторы студии и те, у кого включена ставка смены. */
  const candidatesFor = (studioId: string) =>
    employees.filter(
      (e) =>
        e.trainer_studios.some((s) => s.studio_id === studioId) &&
        (isAdminRole(e.role) || shiftRate.has(e.id)),
    );

  const setShifts = (update: (prev: Shift[]) => Shift[]) => {
    queryClient.setQueryData<Shift[]>(["admin_shifts", month], (prev = []) => update(prev));
    queryClient.invalidateQueries({ queryKey: ["payroll_lines"] });
  };

  const addShift = async (studioId: string, date: string, trainerId: string) => {
    const { data, error } = await supabase
      .from("admin_shifts")
      .insert({ studio_id: studioId, shift_date: date, trainer_id: trainerId })
      .select(SHIFT_SELECT)
      .single<Shift>();
    if (error) {
      toast.error("Смена не добавлена: " + error.message);
      return;
    }
    setShifts((prev) => [...prev, data]);
  };

  const replaceShift = async (shift: Shift, trainerId: string) => {
    const { data, error } = await supabase
      .from("admin_shifts")
      .update({ trainer_id: trainerId })
      .eq("id", shift.id)
      .select(SHIFT_SELECT)
      .single<Shift>();
    if (error) {
      toast.error(
        error.code === "23505"
          ? "Этот администратор уже стоит в этот день"
          : "Смена не изменена: " + error.message,
      );
      return;
    }
    setShifts((prev) => prev.map((s) => (s.id === shift.id ? data : s)));
  };

  const removeShift = async (shift: Shift) => {
    const { error } = await supabase.from("admin_shifts").delete().eq("id", shift.id);
    if (error) {
      toast.error("Смена не убрана: " + error.message);
      return;
    }
    setShifts((prev) => prev.filter((s) => s.id !== shift.id));
  };

  const loading = scopeLoading || shiftsLoading;

  return (
    <AdminShell title="График администраторов">
      <div className="space-y-3">
        <StaffTabs>
          <PeriodStepper
            unit="month"
            label={monthLabel(month)}
            onPrev={() => setMonth(addMonths(month, -1))}
            onNext={() => setMonth(addMonths(month, 1))}
            onCurrent={() => setMonth(monthOf(today))}
            isCurrent={month === monthOf(today)}
          />
        </StaffTabs>

        {!scopeLoading && studios.length === 0 ? (
          <InfoNote variant="empty">
            График ведётся в клубах с пакетами тренировок — у вас нет доступа ни к одному такому
            клубу.
          </InfoNote>
        ) : (
          <>
            <ShiftGrid
              loading={loading}
              days={days}
              today={today}
              month={month}
              studios={studios}
              shifts={shifts}
              employeeById={employeeById}
              candidatesFor={candidatesFor}
              onAdd={addShift}
              onReplace={replaceShift}
              onRemove={removeShift}
            />
            <p className="px-1 text-xs text-muted-foreground">{TIPS.grid}</p>

            <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Adjustments month={month} employees={employees} />
              <ShiftStats
                loading={loading}
                month={month}
                today={today}
                shifts={shifts}
                employeeById={employeeById}
                multiStudio={studios.length > 1}
              />
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}

// --- Сетка смен -------------------------------------------------------------------

function ShiftGrid({
  loading,
  days,
  today,
  month,
  studios,
  shifts,
  employeeById,
  candidatesFor,
  onAdd,
  onReplace,
  onRemove,
}: {
  loading: boolean;
  days: ReturnType<typeof monthDays>;
  today: string;
  month: MonthKey;
  studios: { id: string; name: string; brand_color: string }[];
  shifts: Shift[];
  employeeById: Map<string, Employee>;
  candidatesFor: (studioId: string) => Employee[];
  onAdd: (studioId: string, date: string, trainerId: string) => Promise<void>;
  onReplace: (shift: Shift, trainerId: string) => Promise<void>;
  onRemove: (shift: Shift) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLTableCellElement>(null);
  const todayRef = useRef<HTMLTableCellElement>(null);

  // В текущем месяце сразу показываем сегодняшний день: до конца месяца
  // сетка в экран не помещается.
  useEffect(() => {
    const box = scrollRef.current;
    const cell = todayRef.current;
    if (!box) return;
    // Слева закреплён столбец студий: сегодня — сразу за ним, вчера ещё видно.
    const sticky = stickyRef.current?.offsetWidth ?? 0;
    box.scrollLeft = cell ? Math.max(0, cell.offsetLeft - sticky - cell.offsetWidth) : 0;
  }, [month, studios.length, loading]);

  const byCell = new Map<string, Shift[]>();
  for (const s of shifts) {
    const key = `${s.studio_id}|${s.shift_date}`;
    byCell.set(key, [...(byCell.get(key) ?? []), s]);
  }

  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border bg-background">
      <table className="w-max border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th
              ref={stickyRef}
              className="sticky left-0 z-20 w-28 min-w-28 border-r border-b bg-background px-3 py-2 text-left text-xs font-medium text-muted-foreground sm:w-36 sm:min-w-36"
            >
              Клуб
            </th>
            {days.map((d) => {
              const weekend = isWeekend(d.weekday);
              const isToday = d.date === today;
              return (
                <th
                  key={d.date}
                  ref={isToday ? todayRef : undefined}
                  scope="col"
                  className={cn(
                    "w-[88px] min-w-[88px] border-r border-b px-1 py-1.5 text-center font-normal last:border-r-0",
                    weekend && "bg-muted",
                  )}
                >
                  <div
                    className={cn(
                      "text-xs text-muted-foreground uppercase",
                      weekend && "font-medium",
                    )}
                  >
                    {WEEKDAYS[d.weekday]}
                  </div>
                  <div
                    className={cn(
                      "mx-auto flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
                      isToday && "bg-brand text-brand-foreground",
                    )}
                  >
                    {d.day}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            // Болванка строк студий: та же высота ячеек, что у настоящих.
            Array.from({ length: Math.max(studios.length, 2) }, (_, i) => (
              <tr key={`skeleton-${i}`}>
                <th className="sticky left-0 z-10 border-r border-b bg-background px-3 py-2">
                  <Skeleton className="h-4 w-20" />
                </th>
                {days.map((d) => (
                  <td
                    key={d.date}
                    className={cn(
                      "border-r border-b p-1 align-top last:border-r-0",
                      isWeekend(d.weekday) && "bg-muted",
                    )}
                  >
                    <div className="flex min-h-14 flex-col gap-1">
                      <Skeleton className="h-6 w-full" />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            studios.map((studio) => {
              const candidates = candidatesFor(studio.id);
              return (
                <tr key={studio.id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-b bg-background px-3 py-2 text-left align-top font-medium"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: studio.brand_color }}
                      />
                      <span className="truncate">{studio.name}</span>
                    </span>
                  </th>
                  {days.map((d) => {
                    const cell = byCell.get(`${studio.id}|${d.date}`) ?? [];
                    const taken = new Set(cell.map((s) => s.trainer_id));
                    const dayLabel = `${studio.name}, ${formatDate(d.date)}`;
                    return (
                      <td
                        key={d.date}
                        className={cn(
                          "border-r border-b p-1 align-top last:border-r-0",
                          isWeekend(d.weekday) && "bg-muted",
                        )}
                      >
                        <div className="flex min-h-14 flex-col gap-1">
                          {cell.map((shift) => {
                            const e = employeeById.get(shift.trainer_id);
                            const name = e?.full_name ?? "Сотрудник";
                            return (
                              <AdminPicker
                                key={shift.id}
                                title="Заменить на"
                                candidates={candidates}
                                taken={taken}
                                current={shift.trainer_id}
                                onPick={(id) => onReplace(shift, id)}
                                onRemove={() => onRemove(shift)}
                              >
                                <button
                                  type="button"
                                  title={name}
                                  aria-label={`${dayLabel}: ${name}. Заменить или убрать`}
                                  className="flex w-full cursor-pointer items-center gap-1 rounded-md border bg-background px-1 py-0.5 text-left text-xs transition-colors hover:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                >
                                  <EmployeePhoto
                                    value={e?.photo_url ?? null}
                                    name={name}
                                    className="size-5 text-xs"
                                  />
                                  <span className="min-w-0 truncate">{shortName(name)}</span>
                                </button>
                              </AdminPicker>
                            );
                          })}
                          <AdminPicker
                            title="Поставить на смену"
                            candidates={candidates}
                            taken={taken}
                            onPick={(id) => onAdd(studio.id, d.date, id)}
                          >
                            <button
                              type="button"
                              aria-label={`${dayLabel}: добавить администратора`}
                              className={cn(
                                "flex h-6 w-full cursor-pointer items-center justify-center rounded-md border border-dashed text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                cell.length > 0 && "border-transparent",
                              )}
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </AdminPicker>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

/** Выбор администратора: фото и имя, поиск; у поставленного — «Убрать из смены». */
function AdminPicker({
  title,
  candidates,
  taken,
  current,
  onPick,
  onRemove,
  children,
}: {
  title: string;
  candidates: Employee[];
  taken: Set<string>;
  current?: string;
  onPick: (trainerId: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const options = candidates.filter((c) => c.id === current || !taken.has(c.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Найти администратора" />
          <CommandList>
            <CommandEmpty>
              {candidates.length === 0
                ? "В этом клубе нет администраторов — отметьте клуб у сотрудника в «Сотрудниках»."
                : "Никого не найдено"}
            </CommandEmpty>
            {options.length > 0 && (
              <CommandGroup heading={title}>
                {options.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.full_name} ${c.id}`}
                    onSelect={() => {
                      setOpen(false);
                      if (c.id !== current) void onPick(c.id);
                    }}
                  >
                    <EmployeePhoto value={c.photo_url} name={c.full_name} className="size-6" />
                    <span className="min-w-0 flex-1 truncate">{c.full_name}</span>
                    {c.id === current && <Check />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {onRemove && (
              <CommandGroup>
                <CommandItem
                  value="__remove"
                  onSelect={() => {
                    setOpen(false);
                    void onRemove();
                  }}
                  className="text-destructive data-[selected=true]:text-destructive"
                >
                  <Trash2 />
                  Убрать из смены
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- Статистика ---------------------------------------------------------------------

function ShiftStats({
  loading,
  month,
  today,
  shifts,
  employeeById,
  multiStudio,
}: {
  loading: boolean;
  month: MonthKey;
  today: string;
  shifts: Shift[];
  employeeById: Map<string, Employee>;
  multiStudio: boolean;
}) {
  type Row = { id: string; total: number; worked: number; studios: Map<string, number> };
  const rows = new Map<string, Row>();
  for (const s of shifts) {
    const row = rows.get(s.trainer_id) ?? {
      id: s.trainer_id,
      total: 0,
      worked: 0,
      studios: new Map<string, number>(),
    };
    row.total += 1;
    if (s.shift_date <= today) row.worked += 1;
    row.studios.set(s.studio_id, (row.studios.get(s.studio_id) ?? 0) + 1);
    rows.set(s.trainer_id, row);
  }
  const sorted = [...rows.values()].sort((a, b) => b.total - a.total);
  const studioName = (id: string) => {
    for (const e of employeeById.values()) {
      const s = e.trainer_studios.find((x) => x.studio_id === id);
      if (s?.studio?.name) return s.studio.name;
    }
    return "Клуб";
  };

  return (
    <section className="rounded-lg border bg-background p-4">
      <h2 className="text-lg font-semibold">Смены за {monthName(month).toLowerCase()}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{TIPS.stats}</p>
      {loading ? (
        <ul className="mt-3 divide-y">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 py-2">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-7 w-8" />
            </li>
          ))}
        </ul>
      ) : sorted.length === 0 ? (
        <InfoNote variant="empty" className="mt-3">
          В этом месяце смен пока нет.
        </InfoNote>
      ) : (
        <ul className="mt-3 divide-y">
          {sorted.map((r) => {
            const e = employeeById.get(r.id);
            const name = e?.full_name ?? "Сотрудник";
            return (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <EmployeePhoto value={e?.photo_url ?? null} name={name} className="size-8" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{name}</div>
                  <div className="text-xs text-muted-foreground">
                    отработано {r.worked}
                    {multiStudio &&
                      [...r.studios].map(([id, n]) => ` · ${studioName(id)} ${n}`).join("")}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums">{r.total}</div>
                  <div className="text-xs text-muted-foreground">
                    {plural(r.total, ["смена", "смены", "смен"])}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- Корректировки оклада --------------------------------------------------------------

function Adjustments({ month, employees }: { month: MonthKey; employees: Employee[] }) {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: all = [], isLoading } = usePayrollAdjustments(month);
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const sort = useTableSort<PayrollAdjustment>({
    date: (a) => a.adjusted_on,
    employee: (a) => employeeById.get(a.trainer_id)?.full_name,
    amount: (a) => ADJUSTMENT_KINDS[a.kind].sign * Number(a.amount),
    reason: (a) => a.reason,
    author: (a) => a.created_by_name,
  });
  const adjustments = sort.apply(all.filter((a) => employeeById.has(a.trainer_id)));
  // Администраторы — первыми: корректировки чаще всего про смены.
  const sortedEmployees = [...employees].sort(
    (a, b) =>
      Number(isAdminRole(b.role)) - Number(isAdminRole(a.role)) ||
      a.full_name.localeCompare(b.full_name, "ru"),
  );

  const [trainerId, setTrainerId] = useState("");
  const [kind, setKind] = useState<AdjustmentKind>("deduction");
  const [amount, setAmount] = useState("");
  // Дата по умолчанию — в открытом месяце: сегодня, если смотрим текущий,
  // иначе 1-е число. Выбранная вручную дата держится, пока месяц тот же.
  const today = todayISO();
  const defaultDate = monthOf(today) === month ? today : monthBounds(month).from;
  const [picked, setPicked] = useState<{ month: MonthKey; date: string } | null>(null);
  const date = picked?.month === month ? picked.date : defaultDate;
  const setDate = (value: string) => setPicked({ month, date: value });
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = () => {
    queryClient.invalidateQueries({ queryKey: ["payroll_adjustments"] });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = Number(amount.trim().replace(",", "."));
    if (!trainerId) {
      toast.error("Выберите сотрудника");
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Сумма — положительное число");
      return;
    }
    if (!date) {
      toast.error("Укажите дату");
      return;
    }
    if (!reason.trim()) {
      toast.error("Укажите причину");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("payroll_adjustments").insert({
        trainer_id: trainerId,
        kind,
        amount: value,
        adjusted_on: date,
        reason: reason.trim(),
      });
      if (error) {
        toast.error("Корректировка не добавлена: " + error.message);
        return;
      }
      toast.success(`${ADJUSTMENT_KINDS[kind].label} добавлен${kind === "deduction" ? "" : "а"}`);
      setAmount("");
      setReason("");
      reload();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: "Удалить корректировку?",
        description: "Она перестанет учитываться в зарплате.",
      }))
    )
      return;
    const { error } = await supabase.from("payroll_adjustments").delete().eq("id", id);
    if (error) {
      toast.error("Не удалось удалить: " + error.message);
      return;
    }
    reload();
  };

  return (
    <section className="rounded-lg border bg-background">
      <div className="p-4 pb-0">
        <h2 className="text-lg font-semibold">Корректировки оклада</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{TIPS.adjustment}</p>
      </div>
      <form onSubmit={handleSubmit} className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="Сотрудник" required className="sm:col-span-2 xl:col-span-1">
          <Select value={trainerId} onValueChange={setTrainerId}>
            <SelectTrigger>
              <SelectValue placeholder="Выберите" />
            </SelectTrigger>
            <SelectContent>
              {sortedEmployees.map((e) => (
                <SelectItem key={e.id} value={e.id} textValue={e.full_name}>
                  <StaffOption name={e.full_name} photo={e.photo_url} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Тип" htmlFor={null} required>
          <SegmentedControl
            aria-label="Тип"
            fullWidth
            value={kind}
            onChange={setKind}
            options={(Object.keys(ADJUSTMENT_KINDS) as AdjustmentKind[]).map((k) => ({
              value: k,
              label: ADJUSTMENT_KINDS[k].label,
            }))}
          />
        </FormField>
        <FormField label="Сумма, ₾" required>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="tabular-nums"
          />
        </FormField>
        <FormField label="Дата" required>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label="Причина" required className="sm:col-span-2 xl:col-span-3">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Например: короткий день"
          />
        </FormField>
        <div className="flex items-end">
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? <Loader2 className="animate-spin" /> : <Plus />}
            Добавить
          </Button>
        </div>
      </form>

      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("date")}>Дата</TableHead>
              <TableHead {...sort.head("employee")}>Сотрудник</TableHead>
              <TableHead className="text-right" {...sort.head("amount")}>
                Сумма
              </TableHead>
              <TableHead {...sort.head("reason")}>Причина</TableHead>
              <TableHead {...sort.head("author")}>Добавил</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={5} rows={3} />
            ) : adjustments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  За {monthLabel(month).toLowerCase()} корректировок нет.
                </TableCell>
              </TableRow>
            ) : (
              adjustments.map((a) => {
                const e = employeeById.get(a.trainer_id);
                const sign = ADJUSTMENT_KINDS[a.kind].sign;
                return (
                  <RowContextMenu
                    key={a.id}
                    actions={[
                      {
                        label: "Удалить корректировку",
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => handleDelete(a.id),
                      },
                    ]}
                  >
                    <TableRow>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatDate(a.adjusted_on)}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <EmployeePhoto
                            value={e?.photo_url ?? null}
                            name={e?.full_name ?? "?"}
                            className="size-6"
                          />
                          <span className="font-medium">{e?.full_name ?? "—"}</span>
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium whitespace-nowrap tabular-nums",
                          sign < 0 ? "text-rose-600" : "text-emerald-700",
                        )}
                      >
                        {sign < 0 ? "−" : "+"}
                        {formatPay(Number(a.amount))}
                      </TableCell>
                      <TableCell className="max-w-[280px]">{a.reason}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.created_by_name ?? "—"}
                      </TableCell>
                    </TableRow>
                  </RowContextMenu>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {confirmDialog}
    </section>
  );
}
