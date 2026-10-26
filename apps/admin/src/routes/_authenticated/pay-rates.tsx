import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { StaffTabs } from "@/components/staff-tabs";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { EmployeePhoto } from "@/components/employee-photo";
import { TableSkeletonRows } from "@/components/skeletons";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import {
  TRAINER_ROLES,
  useEmployees,
  usePayRates,
  type Employee,
  type PayRates,
} from "@/lib/staff-directory";
import { PayRatesPageSkeleton } from "@/components/page-skeletons";

export const Route = createFileRoute("/_authenticated/pay-rates")({
  head: () => ({ meta: [{ title: "Зарплатные ставки — Base40 Admin" }] }),
  pendingComponent: PayRatesPageSkeleton,
  component: PayRatesPage,
});

/**
 * «Зарплатные ставки» — страница раздела «Сотрудники» (справочник —
 * lib/staff-directory.ts): ставки каждого сотрудника справочника
 * (trainer_pay_rates). Читать и править их может только сотрудник с
 * разделом «Сотрудники» (RLS, has_admin_section).
 */

/** Ставки: флаг «получает ли сейчас» + сумма в лари за единицу. */
const RATE_KINDS = [
  {
    key: "admin_shift",
    label: "Смена администратора",
    tip: "Сколько сотрудник получает за смену администратором. Включено — он сейчас работает администратором и получает эту ставку.",
  },
  {
    key: "group_training",
    label: "Групповая тренировка",
    tip: "Сколько сотрудник получает за проведённую групповую тренировку.",
  },
  {
    key: "personal_training",
    label: "Персональная тренировка",
    tip: "Сколько сотрудник получает за проведённую персональную тренировку.",
  },
] as const;

type RateKind = (typeof RATE_KINDS)[number]["key"];
type RatePatch = Partial<Omit<PayRates, "trainer_id">>;

function PayRatesPage() {
  const queryClient = useQueryClient();
  const { data: employees = [], isLoading: loading } = useEmployees();
  const { data: rates = [], isLoading: ratesLoading } = usePayRates();
  const byEmployee = new Map(rates.map((r) => [r.trainer_id, r]));
  // Ставка — сумма, если сотрудник её сейчас получает; выключенные — в конце.
  const rateOf = (e: Employee, kind: RateKind) => {
    const r = byEmployee.get(e.id);
    return r?.[`${kind}_enabled`] ? r[`${kind}_rate`] : null;
  };
  const sort = useTableSort<Employee>({
    name: (e) => e.full_name,
    admin_shift: (e) => rateOf(e, "admin_shift"),
    group_training: (e) => rateOf(e, "group_training"),
    personal_training: (e) => rateOf(e, "personal_training"),
  });
  const pg = usePagination(sort.apply(employees), undefined, sort.key);

  /** Сохраняет одно изменённое поле; строку ставок заводит при первой правке. */
  const save = async (trainerId: string, patch: RatePatch) => {
    const { data, error } = await supabase
      .from("trainer_pay_rates")
      .upsert({ trainer_id: trainerId, ...patch, updated_at: new Date().toISOString() })
      .select("*")
      .single<PayRates>();
    if (error) {
      toast.error("Ставка не сохранена: " + error.message);
      return false;
    }
    queryClient.setQueryData<PayRates[]>(["trainer_pay_rates"], (prev = []) => [
      ...prev.filter((r) => r.trainer_id !== trainerId),
      data,
    ]);
    // Ставки входят в расчёт «Зарплат».
    queryClient.invalidateQueries({ queryKey: ["payroll_lines"] });
    return true;
  };

  const busy = loading || ratesLoading;

  return (
    <AdminShell title="Зарплатные ставки">
      <div className="space-y-3">
        <StaffTabs />
        <InfoNote>
          Ставки — в лари за смену или тренировку. Переключатель — получает ли сотрудник эту ставку
          сейчас; сумма сохраняется, когда поле теряет фокус.
        </InfoNote>
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead {...sort.head("name")}>Сотрудник</TableHead>
                {RATE_KINDS.map((k) => (
                  <TableHead key={k.key} tip={k.tip} {...sort.head(k.key)}>
                    {k.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {busy ? (
                <TableSkeletonRows columns={4} />
              ) : employees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    Сначала добавьте сотрудников в разделе «Сотрудники».
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <EmployeePhoto value={e.photo_url} name={e.full_name} className="size-8" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{e.full_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {TRAINER_ROLES[e.role]?.label ?? TRAINER_ROLES.trainer.label}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    {RATE_KINDS.map((k) => (
                      <TableCell key={k.key}>
                        <RateCell
                          kind={k.key}
                          label={`${k.label}: ${e.full_name}`}
                          rates={byEmployee.get(e.id) ?? null}
                          onSave={(patch) => save(e.id, patch)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={busy} />
        </div>
      </div>
    </AdminShell>
  );
}

/** Ячейка ставки: переключатель «получает» и сумма (правится при включённой ставке). */
function RateCell({
  kind,
  label,
  rates,
  onSave,
}: {
  kind: RateKind;
  label: string;
  rates: PayRates | null;
  onSave: (patch: RatePatch) => Promise<boolean>;
}) {
  const enabled = rates?.[`${kind}_enabled`] ?? false;
  const saved = rates?.[`${kind}_rate`] ?? null;
  const [amount, setAmount] = useState(saved === null ? "" : String(saved));
  const [pending, setPending] = useState(false);

  const run = async (patch: RatePatch) => {
    setPending(true);
    try {
      return await onSave(patch);
    } finally {
      setPending(false);
    }
  };

  const commitAmount = async () => {
    const text = amount.trim().replace(",", ".");
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error("Ставка — неотрицательное число");
      setAmount(saved === null ? "" : String(saved));
      return;
    }
    if (value === saved) return;
    if (!(await run({ [`${kind}_rate`]: value }))) setAmount(saved === null ? "" : String(saved));
  };

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={enabled}
        disabled={pending}
        aria-label={label}
        onCheckedChange={(checked) => run({ [`${kind}_enabled`]: checked })}
      />
      <div className="relative w-28">
        <Input
          inputMode="decimal"
          value={amount}
          disabled={!enabled || pending}
          aria-label={`${label}, сумма`}
          placeholder="0"
          onChange={(e) => setAmount(e.target.value)}
          onBlur={commitAmount}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="pr-7 tabular-nums"
        />
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">
          ₾
        </span>
      </div>
    </div>
  );
}
